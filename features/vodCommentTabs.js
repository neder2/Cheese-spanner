/**
 * features/vodCommentTabs.js — VOD 채팅 다시보기 영역에 읽기 전용 댓글 탭을 추가한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 동작 위치: /video/* 의 native aside#vod-aside + [role="log"] 조합.
 * 하는 일: 네이티브 채팅 로그와 헤더 높이를 유지한 채 댓글 패널을 겹쳐 표시한다. 화면 유휴 시
 *   첫 댓글 10개를 미리 읽고, 모바일 웹처럼 page.next 기반으로 다음 묶음을 붙인다.
 *   정렬별 상태는 현재 VOD의 메모리에만 두며 SPA 이동·옵션 해제 때 진행 요청과 함께 폐기한다.
 * 의존: BetterChzzkSettings, BetterChzzk.utils(bindFeatureOptions, fetchChzzkCommentPage,
 *   getMainVideoElement, getVodVideoNoFromPath, injectStyleOnce, isVodRoute, startPageChangeDetection).
 * 옵션 키: vodCommentTabsEnabled.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.vodCommentTabs) return;

    const STYLE_ID = "betterchzzk-vod-comment-tabs-style";
    const TABLIST_ID = "betterchzzk-vod-comment-tabs";
    const CHAT_TAB_ID = "betterchzzk-vod-comment-chat-tab";
    const COMMENT_TAB_ID = "betterchzzk-vod-comment-comment-tab";
    const CHAT_PANEL_ID = "betterchzzk-vod-comment-chat-panel";
    const COMMENT_PANEL_ID = "betterchzzk-vod-comment-panel";
    const COMMENT_PAGE_SIZE = 10;
    const MAX_COMMENTS_PER_ORDER = 300;
    const MOUNT_SYNC_DELAY_MS = 80;
    const DEFAULT_ORDER = "ASC";
    const ANCHOR_SELECTOR = [
        "#vod-aside",
        "#vod-aside [role='log']",
        "#vod-aside h1",
        "#vod-aside h2",
        "#vod-aside h3",
        "#vod-aside h4",
        "#vod-aside h5",
        "#vod-aside h6",
    ].join(",");
    const TIMECODE_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
    const TIMECODE_SCAN_RE = /(?:^|[\s([{])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)\]},.!?])/g;
    const NATIVE_BUFF_ICON_CLASS_RE = /^_buff_icon_[A-Za-z0-9_-]+$/;
    const SORT_OPTIONS = Object.freeze([
        Object.freeze({ label: "등록순", order: "ASC" }),
        Object.freeze({ label: "최신순", order: "DESC" }),
        Object.freeze({ label: "인기순", order: "POPULAR" }),
    ]);

    const {
        bindFeatureOptions,
        fetchChzzkCommentPage,
        getMainVideoElement,
        getVodVideoNoFromPath,
        injectStyleOnce,
        isVodRoute,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let runtimeInstalled = false;
    let bodyObserver = null;
    let resizeObserver = null;
    let loadMoreObserver = null;
    let ensureTimerId = 0;
    let layoutFrameId = 0;
    let commentPrefetchHandle = null;
    let commentPrefetchGeneration = 0;
    let mountedAside = null;
    let mountedContainer = null;
    let mountedHeader = null;
    let mountedHeading = null;
    let mountedChatLog = null;
    let assignedChatLogId = false;
    let originalChatAriaHidden = null;
    let tablist = null;
    let chatTab = null;
    let commentTab = null;
    let commentPanel = null;
    let selectedTab = "chat";
    let activeOrder = DEFAULT_ORDER;
    let lastVideoNo = getVodVideoNoFromPath();
    let nativeBuffIconClassNames = null;
    const commentStates = new Map();

    function isFeatureEnabled() {
        return featureOptions.vodCommentTabsEnabled === true;
    }

    function compactText(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function parseTimecodeSeconds(value) {
        const text = compactText(value);
        if (!TIMECODE_RE.test(text)) return NaN;

        const parts = text.split(":").map(Number);
        if (parts.some((part) => !Number.isFinite(part))) return NaN;
        if (parts.length === 2) {
            const [minutes, seconds] = parts;
            return seconds < 60 ? minutes * 60 + seconds : NaN;
        }
        if (parts.length === 3) {
            const [hours, minutes, seconds] = parts;
            return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : NaN;
        }
        return NaN;
    }

    function injectStyles() {
        injectStyleOnce(
            STYLE_ID,
            `
[data-bcvc-container="1"]{
  position:relative!important;
  min-width:0!important;
  min-height:0!important;
}
[data-bcvc-header="1"]{
  display:flex!important;
  align-items:center!important;
  min-width:0!important;
}
[data-bcvc-heading="1"]{
  position:absolute!important;
  width:1px!important;
  height:1px!important;
  margin:-1px!important;
  padding:0!important;
  overflow:hidden!important;
  clip:rect(0 0 0 0)!important;
  clip-path:inset(50%)!important;
  white-space:nowrap!important;
  border:0!important;
}
#${TABLIST_ID}{
  --bcvc-heading-font-family:inherit;
  --bcvc-heading-font-size:14px;
  --bcvc-heading-font-weight:700;
  --bcvc-heading-line-height:20px;
  --bcvc-heading-letter-spacing:normal;
  display:flex;
  flex:1 1 auto;
  align-self:stretch;
  min-width:0;
  height:var(--bcvc-header-height,44px);
}
#${TABLIST_ID} button{
  position:relative;
  display:flex;
  align-items:center;
  min-width:0;
  height:var(--bcvc-header-height,44px);
  border:0;
  border-radius:0;
  background:transparent;
  color:var(--Content-Neutral-Cool-Weak,#8b909b);
  font-family:var(--bcvc-heading-font-family,inherit);
  font-size:var(--bcvc-heading-font-size,14px);
  font-weight:var(--bcvc-heading-font-weight,700);
  line-height:var(--bcvc-heading-line-height,20px);
  letter-spacing:var(--bcvc-heading-letter-spacing,normal);
  cursor:pointer;
}
#${CHAT_TAB_ID},
#${COMMENT_TAB_ID}{
  flex:1 1 50%;
  justify-content:center;
  overflow:hidden;
  padding:0 10px;
  text-align:center;
  text-overflow:ellipsis;
  white-space:nowrap;
}
#${TABLIST_ID} button:hover{
  background:var(--Surface-Interaction-Lighten-Hovered,rgba(255,255,255,.04));
  color:var(--Content-Neutral-Cool-Base,#c9cedc);
}
#${TABLIST_ID} button[aria-selected="true"]{
  color:var(--Content-Neutral-Primary,#f2f3f5);
}
#${TABLIST_ID} button[aria-selected="true"]::after{
  content:"";
  position:absolute;
  right:12px;
  bottom:0;
  left:12px;
  height:2px;
  border-radius:2px 2px 0 0;
  background:var(--Content-Brand-Strong,var(--Content-Brand-Base,#00e693));
}
#${TABLIST_ID} button:focus-visible,
#${COMMENT_PANEL_ID} button:focus-visible{
  outline:2px solid var(--Content-Brand-Strong,var(--Content-Brand-Base,#00e693));
  outline-offset:-2px;
}
[data-bcvc-native-log="1"][data-bcvc-tab-hidden="1"]{
  visibility:hidden!important;
  pointer-events:none!important;
  user-select:none!important;
}
#${COMMENT_PANEL_ID}{
  --bcvc-surface:var(--Background-Neutral-Base,var(--Surface-Neutral-Weakest,#141517));
  --bcvc-surface-raised:var(--Surface-Neutral-Weakest,#1b1c1f);
  --bcvc-surface-soft:var(--Surface-Neutral-Weaker,#2e3033);
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#dfe2ea);
  --bcvc-text-base:var(--Content-Neutral-Cool-Base,#c9cedc);
  --bcvc-text-weak:var(--Content-Neutral-Cool-Weak,#8b909b);
  --bcvc-border:var(--Border-Neutral-Alpha-Weak,rgba(255,255,255,.06));
  --bcvc-brand:var(--Content-Brand-Strong,var(--Content-Brand-Base,#00e693));
  position:absolute;
  z-index:1;
  top:var(--bcvc-panel-top,44px);
  right:0;
  bottom:auto;
  left:0;
  height:var(--bcvc-panel-height,calc(100% - var(--bcvc-panel-top,44px)));
  min-width:0;
  min-height:0;
  overflow-x:hidden;
  overflow-y:auto;
  overscroll-behavior:contain;
  scrollbar-gutter:stable;
  contain:size layout paint;
  background:var(--bcvc-surface);
  color:var(--bcvc-text-base);
  color-scheme:dark light;
  font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",Helvetica,Arial,sans-serif;
}
#${COMMENT_PANEL_ID}[hidden]{display:none!important}
#${COMMENT_PANEL_ID},
#${COMMENT_PANEL_ID} *{box-sizing:border-box}
.bcvc-comments{width:100%;min-width:0}
.bcvc-toolbar{
  position:sticky;
  z-index:2;
  top:0;
  display:flex;
  align-items:center;
  gap:6px;
  min-width:0;
  min-height:44px;
  padding:6px 10px 6px 12px;
  border-bottom:1px solid var(--bcvc-border);
  background:color-mix(in srgb,var(--bcvc-surface) 94%,transparent);
  backdrop-filter:blur(8px);
}
.bcvc-count{
  flex:1 1 auto;
  min-width:0;
  overflow:hidden;
  color:var(--Content-Neutral-Primary,#f2f3f5);
  font-family:inherit;
  font-size:13px;
  font-weight:700;
  line-height:18px;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.bcvc-sort{
  display:flex;
  flex:0 0 auto;
  align-items:center;
  gap:2px;
  padding:2px;
  border-radius:8px;
  background:color-mix(in srgb,var(--bcvc-surface-soft) 55%,transparent);
}
.bcvc-sort-button,
.bcvc-icon-button{
  min-width:0;
  min-height:28px;
  border:0;
  border-radius:6px;
  padding:4px 6px;
  background:transparent;
  color:var(--bcvc-text-weak);
  font-family:inherit;
  font-size:11px;
  font-weight:600;
  line-height:18px;
  white-space:nowrap;
  cursor:pointer;
}
.bcvc-sort-button:hover,
.bcvc-icon-button:hover{background:var(--Surface-Interaction-Lighten-Hovered,rgba(255,255,255,.06));color:var(--bcvc-text)}
.bcvc-sort-button[aria-pressed="true"]{background:var(--bcvc-surface-raised);color:var(--bcvc-brand)}
.bcvc-icon-button{display:grid;place-items:center;flex:0 0 28px;width:28px;padding:0}
.bcvc-icon-button svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.8}
.bcvc-sort-button:disabled,
.bcvc-icon-button:disabled{cursor:default;opacity:.45}
.bcvc-list{min-width:0;padding:0 6px 0 8px}
.bcvc-comment{
  position:relative;
  min-width:0;
  min-height:0;
  padding:12px 0 7px 46px;
  content-visibility:auto;
  contain-intrinsic-size:auto 74px;
}
.bcvc-avatar{
  position:absolute;
  top:12px;
  left:0;
  display:block;
  width:36px;
  height:36px;
  overflow:hidden;
  border-radius:50%;
  background:var(--Surface-Neutral-Base,var(--bcvc-surface-soft));
}
.bcvc-avatar::after{content:"";position:absolute;inset:0;border:1px solid var(--Border-Neutral-Alpha-Weakest,rgba(0,0,0,.05));border-radius:inherit;pointer-events:none}
.bcvc-avatar-image{display:block;width:100%;height:100%;border-radius:inherit;object-fit:cover}
.bcvc-avatar-fallback{background-image:url("https://ssl.pstatic.net/static/nng/glive/image/default_profile_light.png");background-position:center;background-repeat:no-repeat;background-size:cover}
.theme_dark .bcvc-avatar-fallback{background-image:url("https://ssl.pstatic.net/static/nng/glive/image/default_profile_dark.png")}
.bcvc-meta{display:flex;align-items:center;gap:6px;min-width:0;min-height:18px}
.bcvc-author{min-width:0;overflow:hidden;color:var(--bcvc-text);font-family:inherit;font-size:14px;font-weight:700;line-height:18px;text-overflow:ellipsis;white-space:nowrap}
.bcvc-date{flex:0 0 auto;color:var(--bcvc-text-weak);font-family:inherit;font-size:12px;font-weight:400;line-height:18px;white-space:nowrap}
.bcvc-badge{flex:0 0 auto;border-radius:4px;padding:0 4px;font-family:inherit;font-size:9px;font-weight:700;line-height:15px}
.bcvc-writer{background:var(--Surface-Brand-Alpha-Weaker,rgba(0,230,147,.12));color:var(--bcvc-brand)}
.bcvc-message{min-width:0;margin-top:2px;color:var(--bcvc-text);font-family:inherit;font-size:15px;font-weight:400;line-height:20px;overflow-wrap:anywhere;white-space:pre-wrap}
.bcvc-best{display:inline-flex;align-items:center;justify-content:center;min-width:39px;height:18px;margin:1px 6px 0 0;border-radius:5px;padding:0 4px;background:#41bd53;color:#fff;font-family:inherit;font-size:9px;font-weight:700;line-height:18px;vertical-align:top}
.bcvc-timecode{display:inline-block;min-height:0;margin:2px 8px 0 0;border:0;border-radius:4px;padding:0 3px;background:var(--Surface-Brand-Alpha-Weaker,rgba(0,255,163,.1));color:var(--Content-Brand-Base,#00e693);font-family:inherit;font-size:15px;font-weight:600;line-height:16px;vertical-align:top;cursor:pointer}
.bcvc-comment-footer{display:flex;align-items:flex-start;justify-content:flex-end;min-height:25px;margin-top:2px}
.bcvc-buff{display:inline-flex;align-items:flex-start;min-height:23px;color:var(--bcvc-text-weak);font-family:inherit}
.bcvc-buff-icon{display:block;flex:0 0 47px;width:47px;height:23px}
.bcvc-buff-native-icon{font-style:normal}
.bcvc-buff-label{display:inline-flex;align-items:center;justify-content:center;width:47px;height:23px;border:2px solid var(--Border-Neutral-Alpha-Weak,rgba(128,137,156,.2));border-radius:12px;font-size:11px;font-weight:700;line-height:19px}
.bcvc-buff-label::after{content:"↑";margin-left:2px;font-size:12px;line-height:1}
.bcvc-buff-count{display:inline-block;margin:5px 3px 0;color:var(--color-content-04,var(--bcvc-text-weak));font-family:inherit;font-size:13px;font-weight:500;line-height:16px}
.bcvc-attachments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-top:8px;overflow:hidden;border-radius:8px}
.bcvc-attachments[data-count="1"]{display:block}
.bcvc-attachment{display:block;width:100%;height:96px;border-radius:6px;background:var(--bcvc-surface-soft);object-fit:cover}
.bcvc-attachments[data-count="1"] .bcvc-attachment{height:auto;max-height:190px;object-fit:contain}
.bcvc-attachment[data-type="STICKER"],.bcvc-attachment[data-type="EMOTICON"]{object-fit:contain}
.bcvc-state{display:grid;place-items:center;gap:10px;min-height:168px;margin:0;padding:28px 18px;color:var(--bcvc-text-weak);text-align:center}
.bcvc-state p{margin:0;font-family:inherit;font-size:13px;font-weight:500;line-height:20px}
.bcvc-state-button,.bcvc-more-button{min-height:36px;border:0;border-radius:8px;padding:8px 14px;background:color-mix(in srgb,var(--bcvc-surface-soft) 65%,transparent);color:var(--bcvc-text);font-family:inherit;font-size:13px;font-weight:700;line-height:18px;cursor:pointer}
.bcvc-state-button:hover,.bcvc-more-button:hover{background:var(--Surface-Interaction-Lighten-Hovered,rgba(255,255,255,.08))}
.bcvc-skeleton-list{padding:0 6px 0 8px}
.bcvc-skeleton{position:relative;min-height:72px;padding:12px 0 12px 46px;overflow:hidden}
.bcvc-skeleton::before{content:"";position:absolute;top:12px;left:0;width:36px;height:36px;border-radius:50%;background:var(--bcvc-surface-soft)}
.bcvc-skeleton-line{height:10px;margin:2px 0 10px;border-radius:5px;background:var(--bcvc-surface-soft)}
.bcvc-skeleton-line:first-child{width:44%}.bcvc-skeleton-line:last-child{width:82%;margin-bottom:0}
.bcvc-skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent);animation:bcvc-shimmer 1.4s infinite}
.bcvc-footer{display:grid;gap:8px;justify-items:stretch;min-width:0;padding:12px}
.bcvc-footer:empty{display:none}
.bcvc-footer-status{margin:0;color:var(--bcvc-text-weak);font-family:inherit;font-size:12px;font-weight:500;line-height:18px;text-align:center}
.bcvc-more-button{width:100%;min-height:40px}
.bcvc-sentinel{width:100%;height:1px}
@keyframes bcvc-shimmer{to{transform:translateX(100%)}}
@media (prefers-color-scheme:light){
  #${COMMENT_PANEL_ID}{--bcvc-surface:var(--Background-Neutral-Base,#fff);--bcvc-surface-raised:var(--Surface-Neutral-Weakest,#f7f8fa);--bcvc-surface-soft:var(--Surface-Neutral-Weaker,#eef0f3);--bcvc-text:var(--Content-Neutral-Cool-Strong,#292c33);--bcvc-text-base:var(--Content-Neutral-Cool-Base,#444a55);--bcvc-text-weak:var(--Content-Neutral-Cool-Weak,#707784);--bcvc-border:var(--Border-Neutral-Alpha-Weak,rgba(0,0,0,.08))}
}
@media (prefers-reduced-motion:reduce){.bcvc-skeleton::after{animation:none}}
`
        );
    }

    function findNativeHeading(aside) {
        return Array.from(aside?.querySelectorAll?.("h1, h2, h3, h4, h5, h6") || []).find(
            (heading) => compactText(heading.textContent) === "라이브 채팅 다시보기"
        );
    }

    function resolveNativeAnchors() {
        if (!isFeatureEnabled() || !isVodRoute()) return null;
        const aside = document.querySelector("aside#vod-aside");
        if (!(aside instanceof HTMLElement)) return null;

        const chatLog = aside.querySelector("[role='log']");
        const heading = findNativeHeading(aside);
        const header = heading?.parentElement;
        const container = header?.parentElement;
        if (!(chatLog instanceof HTMLElement) || !(heading instanceof HTMLElement)) return null;
        if (!(header instanceof HTMLElement) || !(container instanceof HTMLElement) || !container.contains(chatLog)) {
            return null;
        }
        return { aside, chatLog, container, header, heading };
    }

    function createTabButton(id, text, controls) {
        const button = document.createElement("button");
        button.id = id;
        button.type = "button";
        button.setAttribute("role", "tab");
        button.setAttribute("aria-controls", controls);
        button.textContent = text;
        return button;
    }

    function syncNativeHeaderAppearance() {
        if (!tablist || !mountedHeading?.isConnected || !mountedHeader || !mountedContainer) return;
        const style = getComputedStyle(mountedHeading);
        const propertyMap = [
            ["--bcvc-heading-font-family", style.fontFamily],
            ["--bcvc-heading-font-size", style.fontSize],
            ["--bcvc-heading-font-weight", style.fontWeight],
            ["--bcvc-heading-line-height", style.lineHeight],
            ["--bcvc-heading-letter-spacing", style.letterSpacing],
        ];
        for (const [property, value] of propertyMap) {
            if (value) tablist.style.setProperty(property, value);
        }

        const asideRect = mountedAside.getBoundingClientRect();
        const headerRect = mountedHeader.getBoundingClientRect();
        const containerRect = mountedContainer.getBoundingClientRect();
        const measuredHeight = Math.round(headerRect.height || Number.parseFloat(style.lineHeight) || 44);
        const headerHeight = Math.max(36, Math.min(64, measuredHeight));
        tablist.style.setProperty("--bcvc-header-height", `${headerHeight}px`);
        const panelTop =
            headerRect.height > 0 ? Math.max(headerHeight, Math.round(headerRect.bottom - containerRect.top)) : 44;
        const visibleBottom =
            asideRect.height > 0 ? Math.min(containerRect.bottom, asideRect.bottom) : containerRect.bottom;
        const panelHeight = Math.max(0, Math.round(visibleBottom - (containerRect.top + panelTop)));
        mountedContainer.style.setProperty("--bcvc-panel-top", `${panelTop}px`);
        mountedContainer.style.setProperty("--bcvc-panel-height", `${panelHeight}px`);
    }

    function scheduleNativeHeaderSync() {
        if (layoutFrameId) return;
        layoutFrameId = requestAnimationFrame(() => {
            layoutFrameId = 0;
            syncNativeHeaderAppearance();
            syncNativeCommentAssets();
        });
    }

    function touchState(state) {
        state.version += 1;
    }

    function createListState(order) {
        return {
            capped: false,
            commentActive: true,
            controller: null,
            error: "",
            hasMore: true,
            inFlight: null,
            items: [],
            loaded: false,
            loading: false,
            loadingMore: false,
            moreError: "",
            nextOffset: 0,
            order,
            requestToken: 0,
            scrollTop: 0,
            seenKeys: new Set(),
            totalCount: null,
            version: 0,
        };
    }

    function getActiveState() {
        if (!commentStates.has(activeOrder)) commentStates.set(activeOrder, createListState(activeOrder));
        return commentStates.get(activeOrder);
    }

    function abortStateRequest(state) {
        if (!state) return;
        state.requestToken += 1;
        state.controller?.abort();
        state.controller = null;
        state.inFlight = null;
        state.loading = false;
        state.loadingMore = false;
        touchState(state);
    }

    function resetState(state) {
        abortStateRequest(state);
        Object.assign(state, {
            capped: false,
            commentActive: true,
            error: "",
            hasMore: true,
            items: [],
            loaded: false,
            moreError: "",
            nextOffset: 0,
            scrollTop: 0,
            seenKeys: new Set(),
            totalCount: null,
        });
        touchState(state);
    }

    function resetCommentStates() {
        for (const state of commentStates.values()) abortStateRequest(state);
        commentStates.clear();
        activeOrder = DEFAULT_ORDER;
        nativeBuffIconClassNames = null;
    }

    function getCommentKey(row, fallbackIndex) {
        const comment = row?.comment || {};
        const id = comment.commentId;
        if (id !== undefined && id !== null && id !== "") return `id:${id}`;
        return `fallback:${comment.createdDate || ""}:${row?.user?.userIdHash || ""}:${comment.content || ""}:${fallbackIndex}`;
    }

    function appendRows(state, rows, { best = false, offset = 0 } = {}) {
        const added = [];
        for (const [index, row] of (Array.isArray(rows) ? rows : []).entries()) {
            if (!row || typeof row !== "object") continue;
            const key = getCommentKey(row, offset + index);
            const existing = state.items.find((item) => item.key === key);
            if (existing) {
                if (best) existing.best = true;
                continue;
            }
            if (state.items.length >= MAX_COMMENTS_PER_ORDER) {
                state.capped = true;
                state.hasMore = false;
                break;
            }
            const item = { best, key, row };
            state.seenKeys.add(key);
            state.items.push(item);
            added.push(item);
        }
        return added;
    }

    function applyCommentResponse(state, content, offset) {
        const comments = content?.comments || {};
        const rows = Array.isArray(comments.data) ? comments.data : [];
        const added = [];
        if (offset === 0) added.push(...appendRows(state, content?.bestComments, { best: true, offset: -1000 }));
        added.push(...appendRows(state, rows, { offset }));

        state.commentActive = content?.commentActive !== false;
        const totalCount = Number(comments.totalCount ?? comments.commentCount);
        if (Number.isFinite(totalCount) && totalCount >= 0) state.totalCount = totalCount;

        const page = comments.page;
        const next = Number(page?.next);
        if (page && Object.hasOwn(page, "next")) {
            state.hasMore = Number.isFinite(next) && next > offset;
            state.nextOffset = state.hasMore ? next : offset + rows.length;
        } else {
            state.nextOffset = offset + rows.length;
            state.hasMore = rows.length >= COMMENT_PAGE_SIZE;
        }
        if (!rows.length || state.items.length >= MAX_COMMENTS_PER_ORDER) {
            state.hasMore = false;
            if (state.items.length >= MAX_COMMENTS_PER_ORDER) state.capped = true;
        }
        return added;
    }

    function safeImageUrl(value) {
        const raw = compactText(value);
        if (!raw) return "";
        try {
            const url = new URL(raw, location.href);
            return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
        } catch (_) {
            return "";
        }
    }

    function parseCommentDate(value) {
        const text = compactText(value);
        const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
        if (!match) return null;
        const [, year, month, day, hours, minutes, seconds] = match.map(Number);
        const date = new Date(Date.UTC(year, month - 1, day, hours - 9, minutes, seconds));
        return Number.isNaN(date.getTime()) ? null : date;
    }

    function formatCommentDate(value) {
        const date = parseCommentDate(value);
        if (!date) return compactText(value);
        const elapsed = Date.now() - date.getTime();
        if (elapsed >= 0 && elapsed < 60 * 1000) return "방금 전";
        if (elapsed >= 0 && elapsed < 60 * 60 * 1000) return `${Math.max(1, Math.floor(elapsed / 60000))}분 전`;
        if (elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)}시간 전`;
        const kstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
        const currentKstDate = new Date(Date.now() + 9 * 60 * 60 * 1000);
        const year = kstDate.getUTCFullYear();
        const month = String(kstDate.getUTCMonth() + 1).padStart(2, "0");
        const day = String(kstDate.getUTCDate()).padStart(2, "0");
        return year === currentKstDate.getUTCFullYear() ? `${month}.${day}` : `${year}.${month}.${day}`;
    }

    function appendCommentText(container, text, { allowTimecodes = true } = {}) {
        const content = String(text || "");
        if (!allowTimecodes || !content) {
            container.textContent = content;
            return;
        }

        TIMECODE_SCAN_RE.lastIndex = 0;
        let cursor = 0;
        let match = TIMECODE_SCAN_RE.exec(content);
        while (match) {
            const label = match[1];
            const labelIndex = match.index + match[0].lastIndexOf(label);
            const seconds = parseTimecodeSeconds(label);
            if (labelIndex > cursor) container.append(content.slice(cursor, labelIndex));
            if (Number.isFinite(seconds)) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "bcvc-timecode";
                button.textContent = label;
                button.setAttribute("data-bcvc-action", "time");
                button.setAttribute("data-bcvc-seconds", String(seconds));
                button.setAttribute("aria-label", `${label}로 이동`);
                container.appendChild(button);
            } else {
                container.append(label);
            }
            cursor = labelIndex + label.length;
            match = TIMECODE_SCAN_RE.exec(content);
        }
        if (cursor < content.length) container.append(content.slice(cursor));
    }

    function getNativeCommentElement(item) {
        const commentId = item?.row?.comment?.commentId;
        if (commentId === undefined || commentId === null || commentId === "") return null;
        const nativeRow = document.getElementById(`commentBox-${commentId}`);
        return nativeRow instanceof HTMLElement ? nativeRow : null;
    }

    function getNativeAvatarUrl(item) {
        const image = getNativeCommentElement(item)?.querySelector("img[width='36'][height='36']");
        return image instanceof HTMLImageElement ? safeImageUrl(image.currentSrc || image.src) : "";
    }

    function isNativeDefaultProfileUrl(url) {
        return /\/default_profile_(?:light|dark)\.png(?:[?#]|$)/i.test(url);
    }

    function createAvatar(item) {
        const avatar = document.createElement("span");
        avatar.className = "bcvc-avatar";
        avatar.setAttribute("aria-hidden", "true");

        const url = getNativeAvatarUrl(item) || safeImageUrl(item?.row?.user?.profileImageUrl);
        if (!url || isNativeDefaultProfileUrl(url)) {
            avatar.classList.add("bcvc-avatar-fallback");
            return avatar;
        }

        const image = document.createElement("img");
        image.className = "bcvc-avatar-image";
        image.src = url;
        image.alt = "";
        image.width = 36;
        image.height = 36;
        image.loading = "lazy";
        image.draggable = false;
        avatar.appendChild(image);
        return avatar;
    }

    function createAttachments(comment) {
        const attachments = (Array.isArray(comment?.attaches) ? comment.attaches : [])
            .map((attachment) => ({
                src: safeImageUrl(attachment?.attachValue),
                type: compactText(attachment?.attachType).toUpperCase(),
            }))
            .filter((attachment) => attachment.src && ["PHOTO", "STICKER", "EMOTICON"].includes(attachment.type))
            .slice(0, 5);
        if (!attachments.length) return null;

        const wrapper = document.createElement("div");
        wrapper.className = "bcvc-attachments";
        wrapper.setAttribute("data-count", String(attachments.length));
        for (const attachment of attachments) {
            const image = document.createElement("img");
            image.className = "bcvc-attachment";
            image.src = attachment.src;
            image.alt = attachment.type === "PHOTO" ? "댓글 첨부 이미지" : "댓글 스티커";
            image.loading = "lazy";
            image.draggable = false;
            image.setAttribute("data-type", attachment.type);
            wrapper.appendChild(image);
        }
        return wrapper;
    }

    function findNativeBuffIcon(item) {
        const nativeRow = getNativeCommentElement(item);
        const commentArea = document.getElementById("commentArea");
        const scopes = [nativeRow, commentArea].filter(
            (scope, index, list) => scope instanceof HTMLElement && list.indexOf(scope) === index
        );
        for (const scope of scopes) {
            const buttons = scope.querySelectorAll("button[aria-pressed]");
            for (const button of buttons) {
                if (compactText(button.textContent) !== "버프") continue;
                const icon = button.querySelector("i");
                if (icon instanceof HTMLElement) return icon;
            }
        }
        return null;
    }

    function getNativeBuffIconClassNames(item = null) {
        if (nativeBuffIconClassNames?.length) return nativeBuffIconClassNames;
        const nativeIcon = findNativeBuffIcon(item);
        if (!nativeIcon) return null;
        const classNames = [...nativeIcon.classList].filter((className) => NATIVE_BUFF_ICON_CLASS_RE.test(className));
        if (!classNames.length) return null;
        nativeBuffIconClassNames = Object.freeze(classNames);
        return nativeBuffIconClassNames;
    }

    function createNativeBuffIcon(item = null) {
        const classNames = getNativeBuffIconClassNames(item);
        if (!classNames?.length) return null;
        const icon = document.createElement("i");
        icon.className = `${classNames.join(" ")} bcvc-buff-icon bcvc-buff-native-icon`;
        icon.setAttribute("aria-hidden", "true");
        return icon;
    }

    function syncNativeCommentAssets() {
        if (!commentPanel?.isConnected || !getNativeBuffIconClassNames()) return;
        const fallbackIcons = commentPanel.querySelectorAll(".bcvc-buff-label");
        for (const fallback of fallbackIcons) {
            const nativeIcon = createNativeBuffIcon();
            if (nativeIcon) fallback.replaceWith(nativeIcon);
        }
    }

    function createCommentFooter(item) {
        const rawBuffCount = Number(item?.row?.buffNerf?.buffCount);
        if (!Number.isFinite(rawBuffCount) || rawBuffCount < 0) return null;
        const buffCount = Math.trunc(rawBuffCount);

        const footer = document.createElement("div");
        footer.className = "bcvc-comment-footer";
        const buff = document.createElement("span");
        buff.className = "bcvc-buff";
        buff.setAttribute("role", "img");
        buff.setAttribute("aria-label", `버프 ${buffCount.toLocaleString()}`);
        const nativeIcon = createNativeBuffIcon(item);
        if (nativeIcon) {
            buff.appendChild(nativeIcon);
        } else {
            const label = document.createElement("span");
            label.className = "bcvc-buff-label";
            label.setAttribute("aria-hidden", "true");
            label.textContent = "버프";
            buff.appendChild(label);
        }
        if (buffCount > 0) {
            const count = document.createElement("span");
            count.className = "bcvc-buff-count";
            count.setAttribute("aria-hidden", "true");
            count.textContent = buffCount.toLocaleString();
            buff.appendChild(count);
        }
        footer.appendChild(buff);
        return footer;
    }

    function createCommentRow(item) {
        const { comment = {}, user = {} } = item.row || {};
        const deleted = comment.deleted === true;
        const cleanBotHidden = comment.hideByCleanBot === true;
        const authorName = deleted ? "삭제된 댓글" : compactText(user.userNickname) || "알 수 없음";
        const row = document.createElement("article");
        row.className = "bcvc-comment";
        row.setAttribute("role", "listitem");
        row.setAttribute("data-bcvc-comment-key", item.key);
        row.appendChild(createAvatar(item));

        const meta = document.createElement("div");
        meta.className = "bcvc-meta";
        const author = document.createElement("strong");
        author.className = "bcvc-author";
        author.textContent = authorName;
        author.title = authorName;
        meta.appendChild(author);
        if (user.writer === true) {
            const writer = document.createElement("span");
            writer.className = "bcvc-badge bcvc-writer";
            writer.textContent = "방송자";
            meta.appendChild(writer);
        }
        const dateText = formatCommentDate(comment.createdDate);
        if (dateText) {
            const date = document.createElement("span");
            date.className = "bcvc-date";
            date.textContent = dateText;
            meta.appendChild(date);
        }
        row.appendChild(meta);

        const message = document.createElement("div");
        message.className = "bcvc-message";
        if (item.best) {
            const best = document.createElement("span");
            best.className = "bcvc-best";
            best.textContent = "BEST";
            message.appendChild(best);
        }
        const messageText = deleted
            ? "삭제된 댓글입니다."
            : cleanBotHidden
              ? "클린봇이 부적절한 표현을 감지한 댓글입니다."
              : String(comment.content || "");
        appendCommentText(message, messageText, { allowTimecodes: !deleted && !cleanBotHidden });
        row.appendChild(message);
        if (!deleted && !cleanBotHidden) {
            const attachments = createAttachments(comment);
            if (attachments) row.appendChild(attachments);
        }
        const footer = createCommentFooter(item);
        if (footer) row.appendChild(footer);
        return row;
    }

    function createRefreshIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 20 20");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M15.7 6.2V2.9m0 3.3h-3.3M15.1 13a6 6 0 1 1 .6-6.8");
        svg.appendChild(path);
        return svg;
    }

    function createToolbar(state) {
        const toolbar = document.createElement("div");
        toolbar.className = "bcvc-toolbar";
        const count = document.createElement("strong");
        count.className = "bcvc-count";
        count.setAttribute("data-bcvc-count", "1");
        count.textContent = Number.isFinite(state.totalCount) ? `댓글 ${state.totalCount.toLocaleString()}` : "댓글";
        toolbar.appendChild(count);

        const sort = document.createElement("div");
        sort.className = "bcvc-sort";
        sort.setAttribute("role", "group");
        sort.setAttribute("aria-label", "댓글 정렬");
        for (const option of SORT_OPTIONS) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "bcvc-sort-button";
            button.textContent = option.label;
            button.setAttribute("data-bcvc-action", "sort");
            button.setAttribute("data-bcvc-order", option.order);
            button.setAttribute("aria-pressed", String(activeOrder === option.order));
            sort.appendChild(button);
        }
        toolbar.appendChild(sort);

        const refresh = document.createElement("button");
        refresh.type = "button";
        refresh.className = "bcvc-icon-button";
        refresh.setAttribute("data-bcvc-action", "refresh");
        refresh.setAttribute("aria-label", "댓글 새로고침");
        refresh.title = "댓글 새로고침";
        refresh.disabled = state.loading;
        refresh.appendChild(createRefreshIcon());
        toolbar.appendChild(refresh);
        return toolbar;
    }

    function createSkeletonList() {
        const list = document.createElement("div");
        list.className = "bcvc-skeleton-list";
        list.setAttribute("aria-hidden", "true");
        for (let index = 0; index < 4; index += 1) {
            const row = document.createElement("div");
            row.className = "bcvc-skeleton";
            for (let line = 0; line < 2; line += 1) {
                const block = document.createElement("div");
                block.className = "bcvc-skeleton-line";
                row.appendChild(block);
            }
            list.appendChild(row);
        }
        return list;
    }

    function createStateBlock(text, actionLabel = "", action = "") {
        const state = document.createElement("div");
        state.className = "bcvc-state";
        state.setAttribute("role", "status");
        const message = document.createElement("p");
        message.textContent = text;
        state.appendChild(message);
        if (actionLabel && action) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "bcvc-state-button";
            button.textContent = actionLabel;
            button.setAttribute("data-bcvc-action", action);
            state.appendChild(button);
        }
        return state;
    }

    function createFooter(state) {
        const footer = document.createElement("div");
        footer.className = "bcvc-footer";
        footer.setAttribute("aria-live", "polite");
        footer.setAttribute("data-bcvc-footer", "1");

        if (state.loadingMore) {
            const status = document.createElement("p");
            status.className = "bcvc-footer-status";
            status.textContent = "댓글을 더 불러오는 중입니다…";
            footer.appendChild(status);
            return footer;
        }
        if (state.moreError) {
            const status = document.createElement("p");
            status.className = "bcvc-footer-status";
            status.textContent = "댓글을 더 불러오지 못했습니다.";
            footer.appendChild(status);
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "bcvc-more-button";
            retry.textContent = "다시 시도";
            retry.setAttribute("data-bcvc-action", "retry-more");
            footer.appendChild(retry);
            return footer;
        }
        if (state.hasMore) {
            const sentinel = document.createElement("div");
            sentinel.className = "bcvc-sentinel";
            sentinel.setAttribute("data-bcvc-sentinel", "1");
            sentinel.setAttribute("aria-hidden", "true");
            footer.appendChild(sentinel);
            const more = document.createElement("button");
            more.type = "button";
            more.className = "bcvc-more-button";
            more.textContent = "댓글 더 보기";
            more.setAttribute("data-bcvc-action", "load-more");
            footer.appendChild(more);
            return footer;
        }
        if (state.capped) {
            const status = document.createElement("p");
            status.className = "bcvc-footer-status";
            status.textContent = `댓글은 ${MAX_COMMENTS_PER_ORDER.toLocaleString()}개까지 표시합니다.`;
            footer.appendChild(status);
        }
        return footer;
    }

    function createCommentView(state) {
        const view = document.createElement("div");
        view.className = "bcvc-comments";
        view.setAttribute("data-bcvc-comments", "1");
        view.setAttribute("data-bcvc-mirror", "1");
        view.setAttribute("data-bcvc-order", state.order);
        view.setAttribute("data-bcvc-version", String(state.version));
        view.appendChild(createToolbar(state));

        if (state.loading && !state.loaded) {
            view.appendChild(createSkeletonList());
            return view;
        }
        if (state.error && !state.loaded) {
            view.appendChild(createStateBlock("댓글을 불러오지 못했습니다.", "다시 시도", "retry-initial"));
            return view;
        }
        if (!state.commentActive) {
            view.appendChild(createStateBlock("이 영상은 댓글을 사용할 수 없습니다."));
            return view;
        }
        if (!state.items.length) {
            view.appendChild(createStateBlock("아직 등록된 댓글이 없습니다."));
            return view;
        }

        const list = document.createElement("div");
        list.className = "bcvc-list";
        list.setAttribute("role", "list");
        list.setAttribute("data-bcvc-list", "1");
        state.items.forEach((item) => list.appendChild(createCommentRow(item)));
        view.appendChild(list);
        view.appendChild(createFooter(state));
        return view;
    }

    function getRenderedView() {
        const view = commentPanel?.firstElementChild;
        return view instanceof HTMLElement && view.getAttribute("data-bcvc-comments") === "1" ? view : null;
    }

    function stampRenderedView(state) {
        const view = getRenderedView();
        if (!view) return;
        view.setAttribute("data-bcvc-order", state.order);
        view.setAttribute("data-bcvc-version", String(state.version));
    }

    function isRenderedViewCurrent(state) {
        const view = getRenderedView();
        return (
            view?.getAttribute("data-bcvc-order") === state.order &&
            view.getAttribute("data-bcvc-version") === String(state.version)
        );
    }

    function disconnectLoadMoreObserver() {
        loadMoreObserver?.disconnect();
        loadMoreObserver = null;
    }

    function connectLoadMoreObserver() {
        disconnectLoadMoreObserver();
        if (selectedTab !== "comments" || typeof IntersectionObserver !== "function" || !commentPanel) return;
        const sentinel = commentPanel.querySelector("[data-bcvc-sentinel='1']");
        if (!(sentinel instanceof HTMLElement)) return;
        loadMoreObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) loadComments();
            },
            { root: commentPanel, rootMargin: "0px 0px 160px", threshold: 0 }
        );
        loadMoreObserver.observe(sentinel);
    }

    function renderActiveState({ restoreScroll = true } = {}) {
        if (!commentPanel || selectedTab !== "comments") return;
        const state = getActiveState();
        disconnectLoadMoreObserver();
        commentPanel.setAttribute("aria-busy", String(state.loading));
        commentPanel.replaceChildren(createCommentView(state));
        if (restoreScroll) commentPanel.scrollTop = state.scrollTop;
        connectLoadMoreObserver();
    }

    function updateFooter(state) {
        if (!commentPanel || selectedTab !== "comments" || state !== getActiveState()) return;
        disconnectLoadMoreObserver();
        const footer = commentPanel.querySelector("[data-bcvc-footer='1']");
        if (footer) footer.replaceWith(createFooter(state));
        const refresh = commentPanel.querySelector("[data-bcvc-action='refresh']");
        if (refresh instanceof HTMLButtonElement) refresh.disabled = state.loading;
        commentPanel.setAttribute("aria-busy", String(state.loading));
        stampRenderedView(state);
        connectLoadMoreObserver();
    }

    function appendLoadedRows(state, added) {
        if (!commentPanel || selectedTab !== "comments" || state !== getActiveState()) return;
        const list = commentPanel.querySelector("[data-bcvc-list='1']");
        if (!(list instanceof HTMLElement) || !added.length) {
            renderActiveState();
            return;
        }
        const fragment = document.createDocumentFragment();
        added.forEach((item) => fragment.appendChild(createCommentRow(item)));
        list.appendChild(fragment);
        const count = commentPanel.querySelector("[data-bcvc-count='1']");
        if (count)
            count.textContent = Number.isFinite(state.totalCount)
                ? `댓글 ${state.totalCount.toLocaleString()}`
                : "댓글";
        updateFooter(state);
    }

    function cancelScheduledCommentPrefetch() {
        const handle = commentPrefetchHandle;
        commentPrefetchHandle = null;
        commentPrefetchGeneration += 1;
        if (handle !== null && typeof window.cancelIdleCallback === "function") {
            window.cancelIdleCallback(handle);
        }
    }

    function canPrefetchInitialComments(videoNo) {
        if (
            !runtimeInstalled ||
            !isFeatureEnabled() ||
            !isVodRoute() ||
            selectedTab !== "chat" ||
            document.visibilityState !== "visible" ||
            window.navigator?.connection?.saveData === true ||
            !mountedAside?.isConnected ||
            !commentPanel?.isConnected ||
            videoNo !== getVodVideoNoFromPath()
        ) {
            return false;
        }
        const state = getActiveState();
        return !state.loaded && !state.loading && !state.error && state.items.length === 0;
    }

    function scheduleCommentPrefetch() {
        cancelScheduledCommentPrefetch();
        if (typeof window.requestIdleCallback !== "function") return;
        const videoNo = getVodVideoNoFromPath();
        if (!videoNo || !canPrefetchInitialComments(videoNo)) return;
        const generation = commentPrefetchGeneration;
        commentPrefetchHandle = window.requestIdleCallback(() => {
            if (generation !== commentPrefetchGeneration) return;
            commentPrefetchHandle = null;
            if (!canPrefetchInitialComments(videoNo)) return;
            loadComments({ allowHidden: true, silent: true });
        });
    }

    async function loadComments({ allowHidden = false, reset = false, silent = false } = {}) {
        const videoNo = getVodVideoNoFromPath();
        if (!videoNo || (selectedTab !== "comments" && !allowHidden)) return;
        const state = getActiveState();
        if (state.loading) return state.inFlight;
        if (reset) resetState(state);
        const initial = !state.loaded;
        if (!initial && !state.hasMore) return;

        const offset = initial ? 0 : state.nextOffset;
        state.loading = true;
        state.loadingMore = !initial;
        state.error = "";
        state.moreError = "";
        state.controller = new AbortController();
        const token = ++state.requestToken;
        touchState(state);
        if (initial) renderActiveState({ restoreScroll: false });
        else updateFooter(state);

        const request = (async () => {
            try {
                const content = await fetchChzzkCommentPage({
                    limit: COMMENT_PAGE_SIZE,
                    objectId: videoNo,
                    offset,
                    orderType: state.order,
                    signal: state.controller.signal,
                });
                if (token !== state.requestToken || videoNo !== getVodVideoNoFromPath()) return;
                const added = applyCommentResponse(state, content, offset);
                state.loaded = true;
                state.error = "";
                state.moreError = "";
                touchState(state);
                if (initial) renderActiveState({ restoreScroll: false });
                else appendLoadedRows(state, added);
            } catch (error) {
                if (token !== state.requestToken || error?.name === "AbortError") return;
                if (initial) {
                    state.error = silent && selectedTab !== "comments" ? "" : error?.message || String(error);
                } else state.moreError = error?.message || String(error);
                touchState(state);
                if (initial) renderActiveState();
                else updateFooter(state);
            } finally {
                if (token === state.requestToken) {
                    state.loading = false;
                    state.loadingMore = false;
                    state.controller = null;
                    state.inFlight = null;
                    touchState(state);
                    if (selectedTab === "comments" && state === getActiveState()) {
                        if (initial && (state.error || !state.loaded)) renderActiveState();
                        else updateFooter(state);
                    }
                }
            }
        })();
        state.inFlight = request;
        return request;
    }

    function refreshComments() {
        const state = getActiveState();
        resetState(state);
        loadComments();
    }

    function showActiveComments() {
        const state = getActiveState();
        if (!state.loaded && !state.loading && !state.error) {
            loadComments();
            return;
        }
        if (isRenderedViewCurrent(state)) {
            commentPanel.scrollTop = state.scrollTop;
            connectLoadMoreObserver();
        } else {
            renderActiveState();
        }
    }

    function changeOrder(order) {
        if (!SORT_OPTIONS.some((option) => option.order === order) || order === activeOrder) return;
        const previous = getActiveState();
        previous.scrollTop = commentPanel?.scrollTop || 0;
        if (previous.loading) abortStateRequest(previous);
        activeOrder = order;
        showActiveComments();
    }

    function seekToCommentTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0 || !isVodRoute()) return false;
        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement)) return false;
        const duration = Number(video.duration);
        const target = Number.isFinite(duration) && duration >= 0 ? Math.min(seconds, duration) : seconds;
        try {
            video.currentTime = target;
            return true;
        } catch (_) {
            return false;
        }
    }

    function onCommentPanelClick(event) {
        const control = event.target.closest?.("[data-bcvc-action]");
        if (!(control instanceof HTMLElement) || !commentPanel?.contains(control)) return;
        const action = control.getAttribute("data-bcvc-action") || "";
        event.preventDefault();
        event.stopPropagation();
        if (action === "time") {
            seekToCommentTime(Number(control.getAttribute("data-bcvc-seconds")));
        } else if (action === "sort") {
            changeOrder(control.getAttribute("data-bcvc-order") || "");
        } else if (action === "refresh") {
            refreshComments();
        } else if (action === "retry-initial") {
            loadComments({ reset: true });
        } else if (["load-more", "retry-more"].includes(action)) {
            loadComments();
        }
    }

    function onCommentPanelScroll() {
        const state = getActiveState();
        state.scrollTop = commentPanel?.scrollTop || 0;
    }

    function updateTabState({ focus = false } = {}) {
        const commentsSelected = selectedTab === "comments";
        chatTab?.setAttribute("aria-selected", String(!commentsSelected));
        commentTab?.setAttribute("aria-selected", String(commentsSelected));
        if (chatTab) chatTab.tabIndex = commentsSelected ? -1 : 0;
        if (commentTab) commentTab.tabIndex = commentsSelected ? 0 : -1;
        if (mountedChatLog) {
            if (commentsSelected) {
                mountedChatLog.setAttribute("data-bcvc-tab-hidden", "1");
                mountedChatLog.setAttribute("aria-hidden", "true");
            } else {
                mountedChatLog.removeAttribute("data-bcvc-tab-hidden");
                if (originalChatAriaHidden === null) mountedChatLog.removeAttribute("aria-hidden");
                else mountedChatLog.setAttribute("aria-hidden", originalChatAriaHidden);
            }
        }
        if (commentPanel) commentPanel.hidden = !commentsSelected;
        if (!commentsSelected) disconnectLoadMoreObserver();
        if (focus) (commentsSelected ? commentTab : chatTab)?.focus();
    }

    function selectTab(tab, options = {}) {
        if (selectedTab === "comments" && commentPanel) getActiveState().scrollTop = commentPanel.scrollTop;
        if (tab === "comments") cancelScheduledCommentPrefetch();
        selectedTab = tab === "comments" ? "comments" : "chat";
        updateTabState(options);
        if (selectedTab === "comments") showActiveComments();
    }

    function onTabClick(event) {
        const button = event.target.closest?.("button[role='tab']");
        if (button === chatTab) selectTab("chat");
        else if (button === commentTab) selectTab("comments");
    }

    function onTabKeyDown(event) {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (event.key === "ArrowLeft" || event.key === "Home") selectTab("chat", { focus: true });
        else selectTab("comments", { focus: true });
    }

    function detachMountedChatLog() {
        const chatLog = mountedChatLog;
        chatLog?.removeAttribute("data-bcvc-tab-hidden");
        chatLog?.removeAttribute("data-bcvc-native-log");
        if (chatLog) {
            if (originalChatAriaHidden === null) chatLog.removeAttribute("aria-hidden");
            else chatLog.setAttribute("aria-hidden", originalChatAriaHidden);
        }
        if (assignedChatLogId && chatLog?.id === CHAT_PANEL_ID) chatLog.removeAttribute("id");
        mountedChatLog = null;
        assignedChatLogId = false;
        originalChatAriaHidden = null;
    }

    function attachMountedChatLog(chatLog) {
        mountedChatLog = chatLog;
        originalChatAriaHidden = mountedChatLog.getAttribute("aria-hidden");
        mountedChatLog.setAttribute("data-bcvc-native-log", "1");
        if (!mountedChatLog.id) {
            mountedChatLog.id = CHAT_PANEL_ID;
            assignedChatLogId = true;
        }
        chatTab?.setAttribute("aria-controls", mountedChatLog.id);
    }

    function clearMountedNativeMarkers() {
        mountedHeading?.removeAttribute("data-bcvc-heading");
        mountedHeader?.removeAttribute("data-bcvc-header");
        mountedContainer?.removeAttribute("data-bcvc-container");
        mountedContainer?.style.removeProperty("--bcvc-panel-top");
        mountedContainer?.style.removeProperty("--bcvc-panel-height");
        mountedAside?.removeAttribute("data-bcvc-mounted");
    }

    function observeMountedLayout() {
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (typeof ResizeObserver !== "function") return;
        resizeObserver = new ResizeObserver(scheduleNativeHeaderSync);
        resizeObserver.observe(mountedAside);
        resizeObserver.observe(mountedHeader);
        resizeObserver.observe(mountedContainer);
    }

    function mountTabs(anchors) {
        injectStyles();
        mountedAside = anchors.aside;
        mountedContainer = anchors.container;
        mountedHeader = anchors.header;
        mountedHeading = anchors.heading;
        attachMountedChatLog(anchors.chatLog);

        mountedAside.setAttribute("data-bcvc-mounted", "1");
        mountedContainer.setAttribute("data-bcvc-container", "1");
        mountedHeader.setAttribute("data-bcvc-header", "1");
        mountedHeading.setAttribute("data-bcvc-heading", "1");

        tablist = document.createElement("div");
        tablist.id = TABLIST_ID;
        tablist.setAttribute("role", "tablist");
        tablist.setAttribute("aria-label", "다시보기 보조 패널");
        chatTab = createTabButton(
            CHAT_TAB_ID,
            compactText(mountedHeading.textContent) || "라이브 채팅 다시보기",
            mountedChatLog.id
        );
        commentTab = createTabButton(COMMENT_TAB_ID, "댓글", COMMENT_PANEL_ID);
        tablist.append(chatTab, commentTab);
        tablist.addEventListener("click", onTabClick);
        tablist.addEventListener("keydown", onTabKeyDown);
        mountedHeader.insertBefore(tablist, mountedHeading);

        commentPanel = document.createElement("div");
        commentPanel.id = COMMENT_PANEL_ID;
        commentPanel.setAttribute("role", "tabpanel");
        commentPanel.setAttribute("aria-labelledby", COMMENT_TAB_ID);
        commentPanel.hidden = true;
        commentPanel.addEventListener("click", onCommentPanelClick);
        commentPanel.addEventListener("scroll", onCommentPanelScroll, { passive: true });
        mountedContainer.appendChild(commentPanel);

        observeMountedLayout();
        syncNativeHeaderAppearance();
        scheduleNativeHeaderSync();
        updateTabState();
        if (selectedTab === "comments") showActiveComments();
        else scheduleCommentPrefetch();
    }

    function reattachMount(anchors) {
        if (!(tablist instanceof HTMLElement) || !(commentPanel instanceof HTMLElement)) return false;
        if (!(chatTab instanceof HTMLButtonElement) || !(commentTab instanceof HTMLButtonElement)) return false;

        const state = selectedTab === "comments" ? getActiveState() : null;
        if (state) state.scrollTop = commentPanel.scrollTop;
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (layoutFrameId) cancelAnimationFrame(layoutFrameId);
        layoutFrameId = 0;

        detachMountedChatLog();
        clearMountedNativeMarkers();
        mountedAside = anchors.aside;
        mountedContainer = anchors.container;
        mountedHeader = anchors.header;
        mountedHeading = anchors.heading;
        attachMountedChatLog(anchors.chatLog);

        mountedAside.setAttribute("data-bcvc-mounted", "1");
        mountedContainer.setAttribute("data-bcvc-container", "1");
        mountedHeader.setAttribute("data-bcvc-header", "1");
        mountedHeading.setAttribute("data-bcvc-heading", "1");
        chatTab.textContent = compactText(mountedHeading.textContent) || "라이브 채팅 다시보기";
        mountedHeader.insertBefore(tablist, mountedHeading);
        mountedContainer.appendChild(commentPanel);

        observeMountedLayout();
        syncNativeHeaderAppearance();
        scheduleNativeHeaderSync();
        updateTabState();
        if (state) {
            commentPanel.scrollTop = state.scrollTop;
            if (!isRenderedViewCurrent(state)) showActiveComments();
        } else scheduleCommentPrefetch();
        return true;
    }

    function teardownMount() {
        cancelScheduledCommentPrefetch();
        if (selectedTab === "comments" && commentPanel) getActiveState().scrollTop = commentPanel.scrollTop;
        disconnectLoadMoreObserver();
        resizeObserver?.disconnect();
        resizeObserver = null;
        if (layoutFrameId) cancelAnimationFrame(layoutFrameId);
        layoutFrameId = 0;

        tablist?.removeEventListener("click", onTabClick);
        tablist?.removeEventListener("keydown", onTabKeyDown);
        commentPanel?.removeEventListener("click", onCommentPanelClick);
        commentPanel?.removeEventListener("scroll", onCommentPanelScroll);
        tablist?.remove();
        commentPanel?.remove();

        detachMountedChatLog();
        clearMountedNativeMarkers();

        mountedAside = null;
        mountedContainer = null;
        mountedHeader = null;
        mountedHeading = null;
        tablist = null;
        chatTab = null;
        commentTab = null;
        commentPanel = null;
    }

    function ensureMounted() {
        ensureTimerId = 0;
        if (!isFeatureEnabled() || !isVodRoute()) {
            teardownMount();
            return;
        }
        const anchors = resolveNativeAnchors();
        if (!anchors) {
            if (!tablist && !commentPanel) teardownMount();
            return;
        }
        const reusableMount =
            tablist instanceof HTMLElement &&
            commentPanel instanceof HTMLElement &&
            chatTab instanceof HTMLButtonElement &&
            commentTab instanceof HTMLButtonElement;
        const shellChanged =
            mountedAside !== anchors.aside ||
            mountedContainer !== anchors.container ||
            mountedHeader !== anchors.header ||
            mountedHeading !== anchors.heading ||
            !tablist?.isConnected ||
            !commentPanel?.isConnected;
        if (reusableMount && shellChanged && reattachMount(anchors)) return;
        const shellMatches =
            mountedAside === anchors.aside &&
            mountedContainer === anchors.container &&
            mountedHeader === anchors.header &&
            mountedHeading === anchors.heading &&
            tablist?.isConnected &&
            commentPanel?.isConnected;
        if (shellMatches && mountedChatLog !== anchors.chatLog) {
            detachMountedChatLog();
            attachMountedChatLog(anchors.chatLog);
            updateTabState();
            scheduleNativeHeaderSync();
            return;
        }
        const matches = shellMatches && mountedChatLog === anchors.chatLog;
        if (matches) {
            scheduleNativeHeaderSync();
            return;
        }
        teardownMount();
        mountTabs(anchors);
    }

    function clearEnsureTimer() {
        if (!ensureTimerId) return;
        clearTimeout(ensureTimerId);
        ensureTimerId = 0;
    }

    function scheduleEnsureMounted({ immediate = false } = {}) {
        if (immediate) {
            clearEnsureTimer();
            ensureMounted();
            return;
        }
        if (ensureTimerId) return;
        ensureTimerId = setTimeout(ensureMounted, MOUNT_SYNC_DELAY_MS);
    }

    function nodeCouldAffectAnchors(node) {
        return (
            node instanceof Element && (node.matches(ANCHOR_SELECTOR) || Boolean(node.querySelector?.(ANCHOR_SELECTOR)))
        );
    }

    function mutationCouldAffectAnchors(mutation) {
        if (mutation.type !== "childList") return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeCouldAffectAnchors);
    }

    function nodeCouldSupplyNativeCommentAssets(node) {
        return (
            node instanceof Element &&
            (node.matches("#commentArea") ||
                Boolean(node.closest("#commentArea")) ||
                Boolean(node.querySelector?.("#commentArea")))
        );
    }

    function mutationCouldSupplyNativeCommentAssets(mutation) {
        if (mutation.type !== "childList") return false;
        if (mutation.target instanceof Element && mutation.target.closest("#commentArea")) return true;
        return [...mutation.addedNodes].some(nodeCouldSupplyNativeCommentAssets);
    }

    function installBodyObserver() {
        if (bodyObserver || !document.documentElement) return;
        bodyObserver = new MutationObserver((mutations) => {
            if (!isFeatureEnabled() || !isVodRoute()) {
                teardownMount();
                return;
            }
            if (!nativeBuffIconClassNames && mutations.some(mutationCouldSupplyNativeCommentAssets)) {
                scheduleNativeHeaderSync();
            }
            const hasMount = Boolean(mountedAside || mountedChatLog || tablist || commentPanel);
            const mountDisconnected =
                hasMount &&
                (!mountedAside?.isConnected ||
                    !mountedChatLog?.isConnected ||
                    !tablist?.isConnected ||
                    !commentPanel?.isConnected);
            if (mountDisconnected) scheduleEnsureMounted({ immediate: true });
            else if (mutations.some(mutationCouldAffectAnchors)) scheduleEnsureMounted();
        });
        bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function installRuntime() {
        if (!runtimeInstalled) {
            runtimeInstalled = true;
            installBodyObserver();
        }
        scheduleEnsureMounted({ immediate: true });
    }

    function uninstallRuntime() {
        runtimeInstalled = false;
        clearEnsureTimer();
        bodyObserver?.disconnect();
        bodyObserver = null;
        teardownMount();
        resetCommentStates();
        selectedTab = "chat";
    }

    function handlePageChange() {
        const videoNo = getVodVideoNoFromPath();
        if (videoNo === lastVideoNo) return;
        lastVideoNo = videoNo;
        teardownMount();
        resetCommentStates();
        selectedTab = "chat";
        if (isFeatureEnabled() && videoNo) scheduleEnsureMounted();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isFeatureEnabled()) installRuntime();
        else uninstallRuntime();
    }

    startPageChangeDetection(handlePageChange);
    bindFeatureOptions(applyOptions);

    root.vodCommentTabs = Object.freeze({ parseTimecodeSeconds });
})();
