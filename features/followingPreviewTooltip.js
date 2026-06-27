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
    const HIDDEN_TEXT_SELECTOR = [
        "script",
        "style",
        "noscript",
        "svg",
        "[hidden]",
        "[aria-hidden='true']",
    ].join(", ");
    const VISUALLY_HIDDEN_TOKEN_RE = /(^|[\s_-])(blind|sr-only|screen-reader|visually-hidden|a11y-hidden)([\s_-]|$)/i;
    const LIVE_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v2/channels";
    const HOVER_OPEN_DELAY_MS = 0;
    const FETCH_TIMEOUT_MS = 8000;
    const CACHE_TTL_MS = 20000;
    const MAX_CACHE_ENTRIES = 80;
    const CARD_WIDTH = 460;
    const PLAYER_START_SETTLE_MS = 90;
    const PLAYER_PLAY_EVENT = "betterchzzk:following-preview:play";
    const PLAYER_STOP_EVENT = "betterchzzk:following-preview:stop";
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
  font-family:inherit;
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
#${TOOLTIP_ID} .bcfp-player{
  display:block;
  width:100%;
  height:100%;
}
#${TOOLTIP_ID} .bcfp-media img{
  object-fit:cover;
}
#${TOOLTIP_ID} .bcfp-player{
  position:absolute;
  inset:0;
  border:0;
  background:#05070A;
}
#${TOOLTIP_ID} .bcfp-player[${PLAYER_STATE_ATTR}="idle"],
#${TOOLTIP_ID} .bcfp-player[${PLAYER_STATE_ATTR}="loading"],
#${TOOLTIP_ID} .bcfp-player[${PLAYER_STATE_ATTR}="error"]{
  visibility:hidden;
}
#${TOOLTIP_ID} .bcfp-player > *{
  display:block;
  width:100% !important;
  height:100% !important;
  object-fit:cover !important;
}
#${TOOLTIP_ID} .bcfp-media-fallback{
  position:absolute;
  inset:0;
  display:flex;
  align-items:center;
  justify-content:center;
  background:linear-gradient(135deg, #202329, #3A4250);
  color:#00FFA3;
  font-size:24px;
  font-weight:900;
  letter-spacing:0;
}
#${TOOLTIP_ID} .bcfp-live{
  position:absolute;
  left:10px;
  top:10px;
  display:inline-flex;
  align-items:center;
  height:20px;
  padding:0 7px;
  border-radius:4px;
  background:#FF365E;
  color:#FFFFFF;
  font-size:11px;
  font-weight:900;
  line-height:20px;
  pointer-events:none;
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
    let playerStartTimer = 0;
    let removePageChangeDetection = null;

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
        return normSpace(`${el.tagName || ""} ${String(el.className || "")} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`);
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
        if (/^(?:https?:|data:|blob:)/i.test(withSize)) return withSize;
        if (withSize.startsWith("//")) return `${location.protocol}${withSize}`;

        try {
            return new URL(withSize, location.origin).href;
        } catch (_) {
            return withSize;
        }
    }

    function getBackgroundImageUrl(el) {
        if (!(el instanceof Element)) return "";
        const value = getComputedStyle(el).backgroundImage || "";
        const match = value.match(/url\((["']?)(.*?)\1\)/i);
        return normalizeImageUrl(match?.[2] || "");
    }

    function getImageUrl(root) {
        if (!root) return "";

        const img = root.querySelector("img[src], img[data-src], img[data-lazy-src]");
        const imageUrl = normalizeImageUrl(
            img?.currentSrc ||
                img?.getAttribute("src") ||
                img?.getAttribute("data-src") ||
                img?.getAttribute("data-lazy-src") ||
                ""
        );
        if (imageUrl) return imageUrl;

        for (const el of root.querySelectorAll("[style], [class*='thumb'], [class*='image']")) {
            const url = getBackgroundImageUrl(el);
            if (url) return url;
        }

        return getBackgroundImageUrl(root);
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
        const livePlaybackJson = pickRawString(content.livePlaybackJson);
        const previewPlaybackJson = pickRawString(content.previewPlaybackJson);

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
            playbackJson: pickRawString(livePlaybackJson, previewPlaybackJson, fallback.playbackJson),
            isPreviewPlayback: !livePlaybackJson && Boolean(previewPlaybackJson || fallback.isPreviewPlayback),
        };
    }

    async function fetchPreviewMeta(channelId, fallback, { signal } = {}) {
        const url = `${LIVE_DETAIL_API_BASE}/${encodeURIComponent(channelId)}/live-detail`;
        const json = await fetchJson(url, { signal, timeoutMs: FETCH_TIMEOUT_MS });
        return normalizePreviewMeta(json, fallback);
    }

    async function getPreviewMeta(channelId, fallback, { signal } = {}) {
        const now = Date.now();
        const cached = previewCache.get(channelId);
        if (cached && now - cached.cachedAt <= CACHE_TTL_MS) return cached.value;

        if (signal) {
            const value = await fetchPreviewMeta(channelId, fallback, { signal });
            return touchMapEntry(previewCache, channelId, { cachedAt: Date.now(), value }, MAX_CACHE_ENTRIES).value;
        }

        if (!pendingRequests.has(channelId)) {
            const request = fetchPreviewMeta(channelId, fallback)
                .then((value) => {
                    touchMapEntry(previewCache, channelId, { cachedAt: Date.now(), value }, MAX_CACHE_ENTRIES);
                    return value;
                })
                .finally(() => pendingRequests.delete(channelId));
            pendingRequests.set(channelId, request);
        }

        return pendingRequests.get(channelId);
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

    function dispatchPlayerEvent(type, detail) {
        window.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(detail || {}) }));
    }

    let playerRequestSeq = 0;
    let activePlayerRequestId = "";

    function clearPlayerStartTimer() {
        if (!playerStartTimer) return;
        window.clearTimeout(playerStartTimer);
        playerStartTimer = 0;
    }

    function stopPreviewPlayer(requestId = activePlayerRequestId) {
        clearPlayerStartTimer();
        if (!requestId) return;
        dispatchPlayerEvent(PLAYER_STOP_EVENT, { requestId });
        if (requestId === activePlayerRequestId) activePlayerRequestId = "";
    }

    function queuePlayerRequest(fn) {
        if (typeof queueMicrotask === "function") {
            queueMicrotask(fn);
            return;
        }
        Promise.resolve().then(fn);
    }

    function requestPreviewPlayer(mount, meta) {
        if (!mount?.isConnected || !meta.playbackJson) return;

        const requestId = `bcfp${Date.now().toString(36)}${(playerRequestSeq += 1).toString(36)}`;
        activePlayerRequestId = requestId;
        mount.setAttribute(PLAYER_MOUNT_ATTR, requestId);
        mount.setAttribute(PLAYER_STATE_ATTR, "loading");

        const startPlayer = () => {
            playerStartTimer = 0;
            if (activePlayerRequestId !== requestId || !mount.isConnected) return;
            dispatchPlayerEvent(PLAYER_PLAY_EVENT, {
                mountId: requestId,
                muted: true,
                playbackJson: meta.playbackJson,
                requestId,
                volume: 0,
            });
        };

        clearPlayerStartTimer();
        if (PLAYER_START_SETTLE_MS > 0) {
            playerStartTimer = window.setTimeout(startPlayer, PLAYER_START_SETTLE_MS);
            return;
        }

        queuePlayerRequest(startPlayer);
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
        } else {
            const fallback = document.createElement("div");
            fallback.className = "bcfp-media-fallback";
            fallback.textContent = "LIVE";
            media.appendChild(fallback);
        }

        if (meta.playbackJson) {
            media.dataset.hasPlayer = "1";

            const playerMount = document.createElement("div");
            playerMount.className = "bcfp-player";
            playerMount.title = `${meta.channelName || meta.channelId} \ub77c\uc774\ube0c \ubbf8\ub9ac\ubcf4\uae30`;
            playerMount.setAttribute(PLAYER_STATE_ATTR, "loading");
            media.appendChild(playerMount);
            queuePlayerRequest(() => requestPreviewPlayer(playerMount, meta));
        }

        const badge = document.createElement("div");
        badge.className = "bcfp-live";
        badge.textContent = "LIVE";
        media.appendChild(badge);

        return media;
    }

    function updateMedia(tip, meta) {
        const channelId = meta.channelId || "";
        const currentChannelId = tip.dataset.channelId || "";
        const existingMedia = tip.querySelector(".bcfp-media");

        if (existingMedia && channelId && currentChannelId === channelId && existingMedia.querySelector(".bcfp-player")) {
            return;
        }

        if (existingMedia?.querySelector(".bcfp-player")) stopPreviewPlayer();

        const media = createMedia(meta);
        if (existingMedia) existingMedia.replaceWith(media);
        else tip.prepend(media);

        if (channelId) tip.dataset.channelId = channelId;
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

    function openPreview(info) {
        abortActiveFetch();
        requestToken += 1;
        const token = requestToken;
        const fetchController = new AbortController();
        activeFetchController = fetchController;

        setActiveItem(info.item);
        activeInfo = info;
        renderPreview(info.domMeta, "loading");

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

    function hidePreview() {
        clearOpenTimer();
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
