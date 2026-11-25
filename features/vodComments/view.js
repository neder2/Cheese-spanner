/**
 * features/vodComments/view.js — VOD 댓글 탭과 댓글 목록 DOM을 관리한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: CheeseSpanner.vodComments.model, CheeseSpanner.utils.injectStyleOnce(주입), CheeseSpanner.utils.ensureUiTheme(선택).
 * 색·모서리는 shared/uiTheme.js의 공통 --bct-* 변수를 따르고, 글꼴은 원본 댓글(body)·원본 heading 측정값을 그대로 쓴다.
 */
(() => {
    "use strict";

    const root = (window.CheeseSpanner = window.CheeseSpanner || {});
    const namespace = (root.vodComments = root.vodComments || {});
    if (namespace.view) return;

    const model = namespace.model;
    const STYLE_ID = "cheese-spanner-vod-comment-tabs-style";
    const TABLIST_ID = "cheese-spanner-vod-comment-tabs";
    const CHAT_TAB_ID = "cheese-spanner-vod-comment-chat-tab";
    const COMMENT_TAB_ID = "cheese-spanner-vod-comment-comment-tab";
    const CHAT_PANEL_ID = "cheese-spanner-vod-comment-chat-panel";
    const COMMENT_PANEL_ID = "cheese-spanner-vod-comment-panel";
    const SPLITTER_ID = "cheese-spanner-vod-comment-splitter";
    const SPLITTER_HEIGHT = 8;
    const NATIVE_ACTION_HINT_ID = "cheese-spanner-vod-comment-native-action-hint";
    // The native BEST lettering is a fixed vector in both themes.
    const BEST_BADGE_LETTERING = `
M5.61411 13 V4.87012 H9.39453 C11.0059 4.87012 11.9805 5.64761 11.9805 6.91527 V6.92653 C11.9805
7.84488 11.2763 8.5773 10.3523 8.69561 V8.73505 C11.4622 8.79139 12.3355 9.59706 12.3355 10.6619
V10.6732 C12.3355 12.0873 11.2369 13 9.49594 13 H5.61411 Z
M8.84803 6.32933 H7.68179 V8.21109 H8.69591 C9.52411 8.21109 9.96357 7.85051 9.96357 7.24204
V7.23077 C9.96357 6.66737 9.54665 6.32933 8.84803 6.32933 Z
M8.84803 9.51255 H7.68179 V11.5408 H8.91001 C9.75511 11.5408 10.234 11.1858 10.234 10.5267
V10.5154 C10.234 9.86749 9.75511 9.51255 8.84803 9.51255 Z
M13.2088 13 V4.87012 H18.7808 V6.53215 H15.2764 V8.13785 H18.5723 V9.69283 H15.2764 V11.338
H18.7808 V13 H13.2088 Z
M23.0795 13.1465 C21.0569 13.1465 19.778 12.2507 19.6879 10.6957 L19.6822 10.5943 H21.6034
L21.6147 10.6563 C21.7161 11.1802 22.3246 11.5239 23.119 11.5239 C23.9416 11.5239 24.4486 11.1746
24.4486 10.6675 V10.6619 C24.4486 10.1999 24.088 9.9858 23.1359 9.79988 L22.3021 9.64213 C20.6907
9.34353 19.84 8.54913 19.84 7.30401 V7.29838 C19.84 5.73212 21.1978 4.72363 23.0626 4.72363
C25.1022 4.72363 26.2571 5.68142 26.3304 7.15753 L26.336 7.27584 H24.4148 L24.4092 7.21387
C24.3472 6.67864 23.8232 6.34623 23.0795 6.34623 C22.319 6.34623 21.8908 6.6899 21.8908 7.15753
V7.16316 C21.8908 7.60262 22.2739 7.83361 23.1472 7.997 L23.981 8.15475 C25.705 8.48716 26.505
9.18577 26.505 10.4872 V10.4929 C26.505 12.1155 25.2317 13.1465 23.0795 13.1465 Z
M29.1248 13 V6.53215 H26.8825 V4.87012 H33.4292 V6.53215 H31.1869 V13 H29.1248 Z
`;
    const { MAX_COMMENTS_PER_ORDER, MAX_REPLIES_PER_COMMENT, MAX_REPLIES_PER_ORDER, SORT_OPTIONS } = model;

    function createCommentView({
        apiAvatarUrls = new WeakMap(),
        injectStyleOnce,
        onLoadMore = () => {},
        onNativeAction = () => {},
        onOpenNativePhoto = () => false,
        onOrderChange = () => {},
        onRefresh = () => {},
        onRendered = () => {},
        onRowRendered = () => {},
        onRetryInitial = () => {},
        onScroll = () => {},
        onTabChange = () => {},
        onTimecode = () => {},
    } = {}) {
        let resizeObserver = null;
        let loadMoreObserver = null;
        let layoutFrameId = 0;
        let mountedAside = null;
        let mountedContainer = null;
        let mountedHeader = null;
        let mountedHeading = null;
        let mountedAppearanceHeading = null;
        let mountedChatLog = null;
        let assignedChatLogId = false;
        let originalChatAriaHidden = null;
        let chatVisibilityObserver = null;
        let nativeChatHidden = false;
        let tablist = null;
        let chatTab = null;
        let commentTab = null;
        let commentPanel = null;
        let photoDialog = null;
        let splitter = null;
        let splitTitle = null;
        let layoutMode = "tabs";
        let splitTop = "chat";
        let splitRatio = 50;
        let splitDrag = null;
        let splitBounds = null;
        let splitChatNodes = [];
        let selectedTab = "chat";
        let activeOrder = model.DEFAULT_ORDER;
        let nativeMeasurements = {};
        const messageToggleStates = new WeakMap();

        function injectStyles() {
            root.utils?.ensureUiTheme?.();
            injectStyleOnce(
                STYLE_ID,
                `
[data-bcvc-container="1"]{
  min-width:0!important;
  min-height:0!important;
}
[data-bcvc-comment-only-host="1"]{
  display:flex!important;
  width:100%!important;
  min-width:0!important;
}
[data-bcvc-comment-only-vod-column="1"]{
  margin-top:0!important;
}
#cheese-spanner-vod-comment-aside{
  --bcvc-surface:var(--bct-bg);
  --bcvc-text:var(--bct-text-body);
  --bcvc-border:var(--bct-border-alpha);
  position:relative;
  flex:0 0 353px;
  align-self:stretch;
  width:353px;
  max-width:35%;
  min-width:280px;
  min-height:280px;
  overflow:hidden;
  border-left:1px solid var(--bcvc-border);
  background:var(--bcvc-surface);
  color:var(--bcvc-text);
}
[data-bcvc-comment-only-container="1"]{
  position:absolute;
  inset:0;
  display:flex;
  flex-direction:column;
  min-width:0;
  min-height:0;
}
[data-bcvc-comment-only-header="1"]{
  flex:0 0 44px;
  height:44px;
  border-bottom:1px solid var(--bcvc-border);
  background:var(--bcvc-surface);
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
  --bcvc-text:var(--bct-text-body);
  --bcvc-text-base:var(--bct-text-muted);
  --bcvc-text-weak:var(--bct-text-muted);
  --bcvc-hover:var(--bct-hover);
  display:flex;
  flex:1 1 auto;
  justify-content:flex-start;
  gap:16px;
  align-self:stretch;
  min-width:0;
  height:var(--bcvc-header-height,44px);
}
#${TABLIST_ID} button{
  position:relative;
  display:flex;
  box-sizing:border-box;
  align-items:center;
  min-width:0;
  height:var(--bcvc-header-height,44px);
  border:0;
  border-radius:0;
  background:transparent;
  color:var(--bcvc-text-weak);
  font-family:var(--bcvc-heading-font-family,inherit);
  font-size:var(--bcvc-heading-font-size,14px);
  font-weight:var(--bcvc-heading-font-weight,700);
  line-height:var(--bcvc-heading-line-height,20px);
  letter-spacing:var(--bcvc-heading-letter-spacing,normal);
  cursor:pointer;
}
#${CHAT_TAB_ID},
#${COMMENT_TAB_ID}{
  flex:0 0 auto;
  justify-content:center;
  overflow:hidden;
  padding:0 2px;
  text-align:center;
  text-overflow:ellipsis;
  white-space:nowrap;
}
#${TABLIST_ID} button:hover{
  background:var(--bcvc-hover);
  color:var(--bcvc-text);
}
#${TABLIST_ID} button[aria-selected="true"]{
  color:var(--bcvc-text);
}
#${TABLIST_ID} button[aria-selected="true"]::after{
  content:"";
  position:absolute;
  right:2px;
  bottom:0;
  left:2px;
  height:2px;
  border-radius:2px 2px 0 0;
  background:var(--bct-brand-text);
}
#cheese-spanner-vod-comment-aside #${TABLIST_ID}{
  background:var(--bcvc-surface);
}
#cheese-spanner-vod-comment-aside #${COMMENT_TAB_ID}{
  flex:1 1 100%;
  justify-content:center;
  padding:0 10px;
  color:var(--bcvc-text);
  text-align:center;
  cursor:default;
}
#cheese-spanner-vod-comment-aside #${COMMENT_TAB_ID}:hover{
  background:transparent;
  color:var(--bcvc-text);
}
#${TABLIST_ID} button:focus-visible,
#${COMMENT_PANEL_ID} button:not(.bcvc-sort-button):focus-visible{
  outline:2px solid var(--bct-focus-ring);
  outline-offset:-2px;
}
[data-bcvc-native-log="1"][data-bcvc-tab-hidden="1"]{
  visibility:hidden!important;
  pointer-events:none!important;
  user-select:none!important;
}
[data-bcvc-native-log="1"]{
  min-height:0!important;
}
[data-bcvc-container="1"][data-bcvc-layout="split"]{
  position:relative!important;
  height:100%!important;
}
#${TABLIST_ID} [hidden]{display:none!important}
#${TABLIST_ID} .bcvc-split-title{
  align-self:center;
  min-width:0;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
  color:var(--bcvc-text);
  font-family:var(--bcvc-heading-font-family,inherit);
  font-size:var(--bcvc-heading-font-size,14px);
  font-weight:var(--bcvc-heading-font-weight,700);
  line-height:var(--bcvc-heading-line-height,20px);
  letter-spacing:var(--bcvc-heading-letter-spacing,normal);
}
[data-bcvc-split-chat="1"]{
  position:absolute!important;
  inset:auto 0!important;
  top:var(--bcvc-chat-top)!important;
  width:100%!important;
  height:var(--bcvc-chat-height)!important;
  max-height:var(--bcvc-chat-height)!important;
  min-height:0!important;
  box-sizing:border-box!important;
}
[data-bcvc-split-chat-inner="1"]{
  min-height:0!important;
  height:100%!important;
  max-height:100%!important;
}
[data-bcvc-layout="split"] > #${COMMENT_PANEL_ID}{
  top:var(--bcvc-comment-top);
  height:var(--bcvc-comment-height);
}
#${SPLITTER_ID}{
  position:absolute;
  z-index:2;
  top:var(--bcvc-divider-top);
  left:0;
  right:0;
  height:${SPLITTER_HEIGHT}px;
  cursor:row-resize;
  touch-action:none;
  user-select:none;
  background:var(--bct-bg);
}
#${SPLITTER_ID}[hidden]{display:none!important}
#${SPLITTER_ID}::after{
  content:"";
  position:absolute;
  top:3px;
  left:0;
  right:0;
  height:2px;
  background:var(--bct-border-strong);
}
#${SPLITTER_ID}:is(:hover, :focus-visible, [data-dragging])::after{background:var(--bct-brand)}
#${SPLITTER_ID}:focus-visible{outline:2px solid var(--bct-focus-ring);outline-offset:-2px}
#${COMMENT_PANEL_ID}{
  --bcvc-font-family:inherit;
  --bcvc-author-font-size:14px;
  --bcvc-author-font-weight:700;
  --bcvc-author-line-height:18px;
  --bcvc-author-letter-spacing:normal;
  --bcvc-date-font-size:12px;
  --bcvc-date-font-weight:400;
  --bcvc-date-line-height:18px;
  --bcvc-date-letter-spacing:normal;
  --bcvc-message-font-size:15px;
  --bcvc-message-font-weight:400;
  --bcvc-message-line-height:1.5;
  --bcvc-message-letter-spacing:normal;
  --bcvc-surface:var(--bct-bg);
  --bcvc-surface-soft:var(--bct-surface-weak);
  --bcvc-text:var(--bct-text-body);
  --bcvc-text-base:var(--bct-text-muted);
  --bcvc-text-weak:var(--bct-text-muted);
  --bcvc-border:var(--bct-border-alpha);
  --bcvc-brand:var(--bct-brand-text);
  --bcvc-hover:var(--bct-hover);
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
  container-type:inline-size;
  background:var(--bcvc-surface);
  color:var(--bcvc-text-base);
  font-family:var(--bcvc-font-family,inherit);
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
  flex-wrap:wrap;
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
  flex:0 1 auto;
  min-width:0;
  overflow:hidden;
  color:var(--bcvc-text);
  font-family:var(--bcvc-toolbar-font-family,var(--bcvc-font-family,inherit));
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
  gap:4px;
  margin-left:auto;
}
.bcvc-sort-button{
  position:relative;
  border:0;
  border-radius:0;
  padding:4px 5px;
  background:transparent;
  color:var(--bct-text-secondary);
  font-family:var(--bcvc-toolbar-font-family,"Sandoll Nemony2",sans-serif);
  font-size:13px;
  font-weight:400;
  line-height:14px;
  letter-spacing:normal;
  white-space:nowrap;
  cursor:pointer;
}
.bcvc-sort-button+.bcvc-sort-button::before{
  content:"";
  position:absolute;
  top:9px;
  left:-3px;
  width:2px;
  height:2px;
  border-radius:50%;
  background:var(--bct-separator-dot);
  pointer-events:none;
}
.bcvc-sort-button[aria-pressed="true"]{color:var(--bct-text-cool-stronger)}
.bcvc-sort-button:is(:hover,:active,:focus-visible){border-radius:var(--bct-radius-sm);background:var(--bct-overlay-hover)}
.bcvc-sort-button:focus-visible{outline:none}
@media (forced-colors:active){.bcvc-sort-button:focus-visible{outline:2px solid Highlight;outline-offset:-2px}}
.bcvc-icon-button{
  min-width:0;
  min-height:28px;
  border:0;
  border-radius:var(--bct-radius-sm);
  padding:4px 6px;
  background:transparent;
  color:var(--bcvc-text-weak);
  font-size:12px;
  font-weight:600;
  line-height:18px;
  white-space:nowrap;
  cursor:pointer;
}
.bcvc-icon-button:hover{background:var(--bcvc-hover);color:var(--bcvc-text)}
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
  border:0;
  border-radius:50%;
  padding:0;
  appearance:none;
  background:var(--bct-surface-base);
}
.bcvc-avatar:not(:disabled){cursor:pointer}
.bcvc-avatar:not(:disabled):hover::after{border-color:var(--bcvc-brand)}
.bcvc-avatar:disabled{cursor:default}
.bcvc-avatar::after{content:"";position:absolute;inset:0;border:1px solid var(--bct-border-alpha-weaker);border-radius:inherit;pointer-events:none}
.bcvc-avatar-image{display:block;width:100%;height:100%;border-radius:inherit}
.bcvc-avatar-image{object-fit:cover}
.bcvc-avatar-fallback{background-image:url("https://ssl.pstatic.net/static/nng/glive/image/default_profile_dark.png");background-position:center;background-repeat:no-repeat;background-size:cover}
@container style(--bct-scheme:light){.bcvc-avatar-fallback{background-image:url("https://ssl.pstatic.net/static/nng/glive/image/default_profile_light.png")}}
.bcvc-meta{display:flex;align-items:center;gap:6px;min-width:0;min-height:18px}
.bcvc-author{display:block;min-width:0;overflow:hidden;border:0;padding:0;background:transparent;color:var(--bcvc-text);font-family:inherit;font-size:var(--bcvc-author-font-size,14px);font-weight:var(--bcvc-author-font-weight,700);line-height:var(--bcvc-author-line-height,18px);letter-spacing:var(--bcvc-author-letter-spacing,normal);text-align:left;text-overflow:ellipsis;white-space:nowrap;appearance:none}
.bcvc-author:not(:disabled){cursor:pointer}
.bcvc-author:not(:disabled):hover{text-decoration:underline}
.bcvc-author:disabled{cursor:default}
.bcvc-date{flex:0 0 auto;color:var(--bcvc-text-weak);font-family:inherit;font-size:var(--bcvc-date-font-size,12px);font-weight:var(--bcvc-date-font-weight,400);line-height:var(--bcvc-date-line-height,18px);letter-spacing:var(--bcvc-date-letter-spacing,normal);white-space:nowrap}
.bcvc-badge{flex:0 0 auto;border-radius:var(--bct-radius-sm);padding:0 4px;font-family:inherit;font-size:9px;font-weight:700;line-height:15px}
.bcvc-writer{background:var(--bct-brand-weak);color:var(--bct-text)}
.bcvc-message{min-width:0;margin-top:2px;color:var(--bcvc-text);font-family:inherit;font-size:var(--bcvc-message-font-size,15px);font-weight:var(--bcvc-message-font-weight,400);line-height:var(--bcvc-message-line-height,1.5);letter-spacing:var(--bcvc-message-letter-spacing,normal);word-break:break-all;overflow-wrap:break-word;white-space:pre-line}
.bcvc-message-content{display:inline}
.bcvc-message-toggle{display:inline-block;border:0;margin:0;padding:0;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.bcvc-best{display:inline-block;width:39px;height:18px;margin:1px 6px 0 0;vertical-align:top}
.bcvc-timecode{display:inline-block;min-height:0;margin:2px 8px 0 0;border:0;border-radius:4px;padding:0 3px;background:var(--bct-brand-weaker);color:var(--bct-brand-text-base);font-family:inherit;font-size:15px;font-weight:600;line-height:16px;vertical-align:top;cursor:pointer}
.bcvc-comment-footer{display:flex;align-items:flex-start;justify-content:space-between;min-height:25px;margin-top:2px}
.bcvc-reply-toggle{display:block;margin:0 0 0 4px;border:0;padding:3px 4px 2px 6px;background:transparent;color:var(--bcvc-brand);font-family:inherit;font-size:13px;font-weight:700;line-height:16px;text-align:left;cursor:pointer}
.bcvc-reply-toggle svg{display:inline-block;width:14px;height:14px;margin:1px 0 0;vertical-align:top}
.bcvc-reply-toggle[aria-expanded="false"] svg{transform:rotate(180deg)}
.bcvc-buff{display:inline-flex;align-items:flex-start;min-height:23px;border:0;padding:0;background:transparent;color:var(--bcvc-text-weak);font-family:inherit;appearance:none}
.bcvc-buff{margin-left:auto}
.bcvc-buff:not(:disabled){cursor:pointer}
.bcvc-buff:not(:disabled):hover,.bcvc-buff[aria-pressed="true"]{color:var(--bcvc-brand)}
.bcvc-buff:disabled{cursor:default}
.bcvc-buff-icon{display:block;flex:0 0 47px;width:47px;height:23px}
.bcvc-buff-native-icon{font-style:normal}
.bcvc-buff-label{display:inline-flex;align-items:center;justify-content:center;width:47px;height:23px;border:2px solid var(--bcvc-border);border-radius:var(--bct-radius-full);font-size:11px;font-weight:700;line-height:19px}
.bcvc-buff-label::after{content:"↑";margin-left:2px;font-size:12px;line-height:1}
.bcvc-buff-count{display:inline-block;margin:5px 3px 0;color:var(--bct-text-muted);font-family:inherit;font-size:13px;font-weight:500;line-height:16px}
.bcvc-buff[aria-pressed="true"] .bcvc-buff-count{color:var(--bcvc-brand);font-weight:600}
.bcvc-replies{min-width:0;margin:4px 0 0 12px}
.bcvc-replies[hidden]{display:none!important}
.bcvc-replies .bcvc-comment{padding:9px 0 5px 30px}
.bcvc-replies .bcvc-avatar{top:9px;width:22px;height:22px}
.bcvc-replies .bcvc-message{font-size:14px;line-height:1.5}
.bcvc-mention{display:inline-block;margin-right:5px;color:var(--bcvc-brand);font-size:15px;font-weight:700;line-height:20px}
.bcvc-reply-limit{margin:3px 0 4px 20px;color:var(--bcvc-text-weak);font-size:12px;line-height:18px}
.bcvc-reply-limit[hidden]{display:none!important}
.bcvc-comment[data-bcvc-deleted="1"]{padding-left:0}
.bcvc-attachments{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;margin-top:5px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:thin;line-height:0}
.bcvc-attachments[data-sticker-wide]{column-gap:15px}
.bcvc-attachment{display:block;max-width:100%}
.bcvc-attachment[data-type="STICKER"]{flex:none;width:103px;height:auto;border-radius:0;background:transparent;object-fit:contain}
.bcvc-attachment[data-type="EMOTICON"]{flex:none;width:auto;height:auto;max-height:190px;object-fit:contain}
.bcvc-photo{position:relative;flex:none;max-width:100%;min-width:0;width:103px;border:0;border-radius:var(--bct-radius-lg);padding:0;background:transparent;line-height:0;appearance:none;cursor:pointer}
.bcvc-photo[data-layout="single"],.bcvc-photo[data-layout="wide"]{width:215px}
.bcvc-photo::after{content:"";position:absolute;inset:0;border:1px solid var(--bct-photo-border);border-radius:inherit;pointer-events:none}
.bcvc-photo .bcvc-attachment{width:100%;aspect-ratio:1;height:auto;border-radius:inherit;background:var(--bcvc-surface-soft);object-fit:cover}
.bcvc-photo[data-layout="single"] .bcvc-attachment{width:215px;aspect-ratio:auto;max-height:440px}
.bcvc-photo[data-layout="wide"] .bcvc-attachment{height:103px;aspect-ratio:auto}
.bcvc-photo-more{position:absolute;bottom:6px;right:6px;border-radius:5px;padding:3px 5px 2px 6px;background:color-mix(in srgb,var(--bct-viewer-bg) 70%,transparent);color:var(--bct-viewer-fg);font-family:inherit;font-size:12px;font-weight:600;line-height:14px}
.bcvc-state{display:grid;place-items:center;gap:10px;min-height:168px;margin:0;padding:28px 18px;color:var(--bcvc-text-weak);text-align:center}
.bcvc-state p{margin:0;font-family:inherit;font-size:13px;font-weight:500;line-height:20px}
.bcvc-state-button,.bcvc-more-button{min-height:36px;border:0;border-radius:var(--bct-radius-md);padding:8px 14px;background:color-mix(in srgb,var(--bcvc-surface-soft) 65%,transparent);color:var(--bcvc-text);font-family:inherit;font-size:13px;font-weight:700;line-height:18px;cursor:pointer}
.bcvc-state-button:hover,.bcvc-more-button:hover{background:var(--bcvc-hover)}
.bcvc-skeleton-list{padding:0 6px 0 8px}
.bcvc-skeleton{position:relative;min-height:72px;padding:12px 0 12px 46px;overflow:hidden}
.bcvc-skeleton::before{content:"";position:absolute;top:12px;left:0;width:36px;height:36px;border-radius:50%;background:var(--bcvc-surface-soft)}
.bcvc-skeleton-line{height:10px;margin:2px 0 10px;border-radius:var(--bct-radius-full);background:var(--bcvc-surface-soft)}
.bcvc-skeleton-line:first-child{width:44%}.bcvc-skeleton-line:last-child{width:82%;margin-bottom:0}
.bcvc-skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,var(--bcvc-hover),transparent);animation:bcvc-shimmer 1.4s infinite}
.bcvc-footer{display:grid;gap:8px;justify-items:stretch;min-width:0;padding:12px}
.bcvc-footer:empty{display:none}
.bcvc-footer-status{margin:0;color:var(--bcvc-text-weak);font-family:inherit;font-size:12px;font-weight:500;line-height:18px;text-align:center}
.bcvc-sr-only{position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}
.bcvc-more-button{width:100%;min-height:40px}
.bcvc-sentinel{width:100%;height:1px}
.bcvc-photo-viewer[open]{
  position:fixed;inset:0;display:block;box-sizing:border-box;width:100%;height:100%;
  max-width:none;max-height:none;margin:0;border:0;padding:0;overflow:hidden;
  background:var(--bct-viewer-bg);color:var(--bct-viewer-fg);font:inherit;
}
.bcvc-photo-viewer::backdrop{background:var(--bct-viewer-bg)}
.bcvc-photo-stage{position:absolute;inset:16px;display:flex;overflow:auto;overscroll-behavior:contain}
.bcvc-photo-stage img{flex:none;display:block;width:auto;height:auto;max-width:100%;max-height:100%;margin:auto;object-fit:contain}
.bcvc-photo-stage img[data-zoomed]{max-width:none;max-height:none}
.bcvc-photo-viewer button{display:grid;place-items:center;border:0;padding:8px;background:transparent;color:inherit;opacity:.8;cursor:pointer}
.bcvc-photo-viewer button:disabled{opacity:.4;cursor:default}
.bcvc-photo-viewer button:not(:disabled):is(:hover,:focus-visible){opacity:1}
.bcvc-photo-viewer button:focus-visible{outline:2px solid currentColor;outline-offset:-3px}
.bcvc-photo-viewer svg{display:block;width:32px;height:32px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;filter:drop-shadow(2px 2px 2px var(--bct-viewer-bg))}
.bcvc-photo-counter,.bcvc-photo-actions{position:absolute;top:0}
.bcvc-photo-counter{left:0;padding:8px;font-size:16px;line-height:24px;text-shadow:1px 1px 2px var(--bct-viewer-bg)}
.bcvc-photo-actions{right:0;display:flex}
.bcvc-photo-viewer .bcvc-photo-step{position:absolute;top:50%;transform:translateY(-50%);padding:24px 16px}
.bcvc-photo-step[data-direction="prev"]{left:0}
.bcvc-photo-step[data-direction="next"]{right:0}
.bcvc-photo-status{position:absolute;inset:50% 0 auto;margin:0;text-align:center}
.bcvc-photo-viewer [hidden]{display:none}
@keyframes bcvc-shimmer{to{transform:translateX(100%)}}
@container (max-width:300px){
  .bcvc-toolbar{gap:4px;padding-inline:6px}
}
@media (prefers-reduced-motion:reduce){.bcvc-skeleton::after{animation:none}}
`
            );
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

        function applyNativeMeasurements(measurements = {}) {
            nativeMeasurements = measurements;
            if (!(commentPanel instanceof HTMLElement)) return;
            // Native comment rows inherit body typography, not the branded chat heading.
            const fallbackFontFamily = document.body ? getComputedStyle(document.body).fontFamily : "inherit";
            const fontFamily = measurements.fontFamily || fallbackFontFamily;
            if (fontFamily) commentPanel.style.setProperty("--bcvc-font-family", fontFamily);
            if (measurements.toolbarFontFamily) {
                commentPanel.style.setProperty("--bcvc-toolbar-font-family", measurements.toolbarFontFamily);
            } else {
                commentPanel.style.removeProperty("--bcvc-toolbar-font-family");
            }
            for (const [prefix, values] of Object.entries(measurements.typography || {})) {
                for (const [property, value] of Object.entries({
                    "font-size": values.fontSize,
                    "font-weight": values.fontWeight,
                    "letter-spacing": values.letterSpacing,
                    "line-height": values.lineHeight,
                })) {
                    if (value) commentPanel.style.setProperty(`--bcvc-${prefix}-${property}`, value);
                }
            }
        }

        function syncNativeHeaderAppearance() {
            if (!tablist || !mountedHeading?.isConnected || !mountedHeader || !mountedContainer) return;
            const appearanceHeading =
                mountedAppearanceHeading instanceof HTMLElement && mountedAppearanceHeading.isConnected
                    ? mountedAppearanceHeading
                    : mountedHeading;
            const style = getComputedStyle(appearanceHeading);
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
            applyNativeMeasurements(nativeMeasurements);

            const asideRect = mountedAside.getBoundingClientRect();
            const headerRect = mountedHeader.getBoundingClientRect();
            const containerRect = mountedContainer.getBoundingClientRect();
            const measuredHeight = Math.round(headerRect.height || Number.parseFloat(style.lineHeight) || 44);
            const headerHeight = Math.max(36, Math.min(64, measuredHeight));
            tablist.style.setProperty("--bcvc-header-height", `${headerHeight}px`);
            const panelTop =
                headerRect.height > 0 ? Math.max(headerHeight, Math.round(headerRect.bottom - containerRect.top)) : 44;
            const visibleBottom = asideRect.height > 0 ? asideRect.bottom : containerRect.bottom;
            const panelHeight = Math.max(0, Math.round(visibleBottom - (containerRect.top + panelTop)));
            mountedContainer.style.setProperty("--bcvc-panel-top", `${panelTop}px`);
            mountedContainer.style.setProperty("--bcvc-panel-height", `${panelHeight}px`);
            syncSplitLayout(panelTop, panelHeight);
        }

        function hasSplitLayout() {
            return layoutMode === "split" && Boolean(mountedChatLog && !mountedHeader?.contains(mountedChatLog));
        }

        function isSplit() {
            return hasSplitLayout() && !nativeChatHidden;
        }

        function isCommentsVisible() {
            return Boolean(commentPanel && (hasSplitLayout() || !mountedChatLog || selectedTab === "comments"));
        }

        function isNativeChatHidden() {
            for (let node = mountedChatLog; node && node !== mountedContainer; node = node.parentElement) {
                if (node.hidden || node.getAttribute("aria-hidden") === "true") return true;
                const style = getComputedStyle(node);
                if (["hidden", "collapse"].includes(style.visibility) || style.display === "none") return true;
            }
            return false;
        }

        function syncChatVisibility() {
            if (hasSplitLayout() && isNativeChatHidden() !== nativeChatHidden) updateTabState();
        }

        function observeChatAncestors() {
            chatVisibilityObserver.disconnect();
            for (let node = mountedChatLog; node && node !== mountedContainer; node = node.parentElement) {
                chatVisibilityObserver.observe(node, {
                    attributes: true,
                    attributeFilter: ["class", "style", "hidden", "aria-hidden"],
                });
            }
        }

        function restoreChatTabHiddenState() {
            if (!mountedChatLog?.hasAttribute("data-bcvc-tab-hidden")) return;
            mountedChatLog.removeAttribute("data-bcvc-tab-hidden");
            if (originalChatAriaHidden === null) mountedChatLog.removeAttribute("aria-hidden");
            else mountedChatLog.setAttribute("aria-hidden", originalChatAriaHidden);
        }

        function clearSplitChatMarkers() {
            for (const node of splitChatNodes) {
                node.removeAttribute("data-bcvc-split-chat");
                node.removeAttribute("data-bcvc-split-chat-inner");
            }
            splitChatNodes = [];
        }

        function applySplitSizes() {
            if (!splitBounds || !isSplit()) return;
            const { top, height } = splitBounds;
            const upper = Math.round((height * splitRatio) / 100);
            const lower = height - upper;
            const lowerTop = top + upper + SPLITTER_HEIGHT;
            const chatFirst = splitTop === "chat";
            for (const [name, value] of Object.entries({
                "chat-top": chatFirst ? top : lowerTop,
                "chat-height": chatFirst ? upper : lower,
                "comment-top": chatFirst ? lowerTop : top,
                "comment-height": chatFirst ? lower : upper,
                "divider-top": top + upper,
            }))
                mountedContainer.style.setProperty(`--bcvc-${name}`, `${value}px`);
            splitter?.setAttribute("aria-valuenow", String(splitRatio));
            splitter?.setAttribute("aria-valuetext", `상단 ${splitRatio}%, 하단 ${100 - splitRatio}%`);
        }

        function syncSplitLayout(top, height) {
            if (!splitter || !mountedContainer) return;
            const active = isSplit();
            splitter.hidden = !active;
            if (!active) {
                mountedContainer.removeAttribute("data-bcvc-layout");
                clearSplitChatMarkers();
                splitBounds = null;
                return;
            }
            mountedContainer.setAttribute("data-bcvc-layout", "split");
            const nodes = [];
            for (let node = mountedChatLog; node && node !== mountedContainer; node = node.parentElement)
                nodes.push(node);
            if (nodes.some((node, i) => splitChatNodes[i] !== node) || nodes.length !== splitChatNodes.length) {
                clearSplitChatMarkers();
                splitChatNodes = nodes;
                nodes.forEach((node, i) =>
                    node.setAttribute(
                        i === nodes.length - 1 ? "data-bcvc-split-chat" : "data-bcvc-split-chat-inner",
                        "1"
                    )
                );
            }
            splitBounds = { top, height: Math.max(0, height - SPLITTER_HEIGHT) };
            splitter.setAttribute("aria-controls", `${mountedChatLog.id} ${COMMENT_PANEL_ID}`);
            applySplitSizes();
        }

        function setSplitRatio(value) {
            splitRatio = Math.round(Math.max(20, Math.min(80, value)));
            applySplitSizes();
        }

        function stopSplitDrag(commit = false) {
            const drag = splitDrag;
            if (!drag) return;
            splitDrag = null;
            drag.listeners.abort();
            splitter?.removeAttribute("data-dragging");
            if (!commit) setSplitRatio(drag.ratio);
        }

        function onSplitterPointerDown(event) {
            if (event.button !== 0 || event.isPrimary === false || !isSplit() || !splitBounds?.height) return;
            stopSplitDrag();
            event.preventDefault();
            event.stopPropagation();
            splitter.focus({ preventScroll: true });
            splitter.setAttribute("data-dragging", "");
            const drag = (splitDrag = {
                pointer: event.pointerId,
                y: event.clientY,
                ratio: splitRatio,
                height: splitBounds.height,
                listeners: new AbortController(),
            });
            const options = { signal: drag.listeners.signal, capture: true };
            const move = (next) => {
                if (next.pointerId !== drag.pointer) return;
                if (next.type === "pointermove" && next.pointerType === "mouse" && next.buttons === 0) {
                    stopSplitDrag();
                    return;
                }
                next.preventDefault();
                next.stopPropagation();
                setSplitRatio(drag.ratio + ((next.clientY - drag.y) / drag.height) * 100);
            };
            window.addEventListener("pointermove", move, options);
            window.addEventListener(
                "pointerup",
                (next) => {
                    if (next.pointerId !== drag.pointer) return;
                    move(next);
                    stopSplitDrag(true);
                },
                options
            );
            window.addEventListener(
                "pointercancel",
                (next) => {
                    if (next.pointerId === drag.pointer) stopSplitDrag();
                },
                options
            );
            window.addEventListener(
                "keydown",
                (next) => {
                    if (next.key !== "Escape") return;
                    next.preventDefault();
                    next.stopPropagation();
                    stopSplitDrag();
                },
                options
            );
            window.addEventListener("blur", () => stopSplitDrag(), options);
            window.addEventListener("pagehide", () => stopSplitDrag(), options);
        }

        function onSplitterKeyDown(event) {
            if (!isSplit() || splitDrag || event.ctrlKey || event.metaKey || event.altKey) return;
            const ratio = { ArrowUp: splitRatio - 5, ArrowDown: splitRatio + 5, Home: 20, End: 80 }[event.key];
            if (ratio === undefined) return;
            event.preventDefault();
            event.stopPropagation();
            setSplitRatio(ratio);
        }

        function setLayout({ mode = "tabs", top = "chat" } = {}) {
            const nextMode = mode === "split" ? "split" : "tabs";
            const nextTop = top === "comments" ? "comments" : "chat";
            if (layoutMode === nextMode && splitTop === nextTop) return;
            stopSplitDrag();
            layoutMode = nextMode;
            splitTop = nextTop;
            updateTabState();
        }

        function scheduleNativeHeaderSync() {
            if (layoutFrameId) return;
            layoutFrameId = requestAnimationFrame(() => {
                layoutFrameId = 0;
                syncNativeHeaderAppearance();
            });
        }

        function appendCommentText(container, text, { allowTimecodes = true, sourceText = text } = {}) {
            const content = String(text || "");
            if (!allowTimecodes || !content) {
                container.textContent = content;
                return;
            }

            let cursor = 0;
            for (const { label, seconds, index } of root.utils.commentTimecodes(sourceText)) {
                // A preview can end partway through a timecode. Only link complete tokens from the original.
                if (!content.startsWith(label, index)) break;
                if (index > cursor) container.append(content.slice(cursor, index));
                const button = document.createElement("button");
                button.type = "button";
                button.className = "bcvc-timecode";
                button.textContent = label;
                button.setAttribute("data-bcvc-action", "time");
                button.setAttribute("data-bcvc-seconds", String(seconds));
                button.setAttribute("aria-label", `${label}로 이동`);
                container.appendChild(button);
                cursor = index + label.length;
            }
            if (cursor < content.length) container.append(content.slice(cursor));
        }

        function getCommentId(item) {
            const commentId = item?.row?.comment?.commentId;
            return commentId === undefined || commentId === null || commentId === "" ? "" : String(commentId);
        }

        function isNativeDefaultProfileUrl(url) {
            return /\/default_profile_(?:light|dark)\.png(?:[?#]|$)/i.test(url);
        }

        function createAvatar(item, authorName) {
            const avatar = document.createElement("button");
            avatar.type = "button";
            avatar.className = "bcvc-avatar";
            avatar.setAttribute("data-bcvc-action", "profile");
            avatar.setAttribute("data-bcvc-profile-target", "avatar");
            avatar.setAttribute("aria-label", `${authorName} 프로필 보기`);
            avatar.disabled = true;
            avatar.title = "하단 원본 댓글이 표시될 때 프로필 보기 가능.";
            avatar.setAttribute("aria-describedby", NATIVE_ACTION_HINT_ID);

            const apiUrl = model.normalizeImageUrl(item?.row?.user?.profileImageUrl, location.href);
            if (apiUrl && !isNativeDefaultProfileUrl(apiUrl)) {
                apiAvatarUrls.set(avatar, apiUrl);
                const image = document.createElement("img");
                image.className = "bcvc-avatar-image";
                image.referrerPolicy = "no-referrer";
                image.src = apiUrl;
                image.alt = "";
                image.width = 36;
                image.height = 36;
                image.loading = "lazy";
                image.draggable = false;
                avatar.appendChild(image);
            } else {
                avatar.classList.add("bcvc-avatar-fallback");
            }
            return avatar;
        }

        function createAttachmentImage(attachment) {
            const image = document.createElement("img");
            image.className = "bcvc-attachment";
            image.referrerPolicy = "no-referrer";
            image.alt = attachment.type === "PHOTO" ? "" : "댓글 스티커";
            image.loading = "lazy";
            image.draggable = false;
            image.dataset.type = attachment.type;
            image.src = attachment.type === "PHOTO" ? model.getPhotoThumbnailUrl(attachment.src) : attachment.src;
            return image;
        }

        function createAttachments(comment) {
            // A native row may carry one sticker alongside five photos.
            const attachments = model.normalizeAttachments(comment, { baseUrl: location.href, maxItems: 6 });
            if (!attachments.length) return null;

            const wrapper = document.createElement("div");
            wrapper.className = "bcvc-attachments";
            const sticker = attachments.find((item) => item.type === "STICKER");
            if (sticker) wrapper.appendChild(createAttachmentImage(sticker));
            for (const emoticon of attachments.filter((item) => item.type === "EMOTICON").slice(0, 5)) {
                wrapper.appendChild(createAttachmentImage(emoticon));
            }

            const photos = attachments.filter((item) => item.type === "PHOTO").slice(0, 5);
            if (!photos.length) return wrapper;
            const sources = photos.map((photo) => photo.src);
            const single = photos.length === 1 && !sticker;
            const wide = !single && photos.every((photo) => photo.width > photo.height);
            let visibleCount = photos.length;
            if (wide) visibleCount = Math.min(photos.length, sticker ? 1 : 2);
            else if (sticker) visibleCount = Math.min(photos.length, 4);
            if (sticker && wide) wrapper.setAttribute("data-sticker-wide", "");

            wrapper.addEventListener("focusin", ({ target }) => {
                if (!(target instanceof HTMLButtonElement) || wrapper.scrollWidth <= wrapper.clientWidth) return;
                const strip = wrapper.getBoundingClientRect();
                const tile = target.getBoundingClientRect();
                if (tile.right > strip.right) wrapper.scrollLeft += tile.right - strip.right;
                else if (tile.left < strip.left) wrapper.scrollLeft -= strip.left - tile.left;
            });

            for (let index = 0; index < visibleCount; index++) {
                const photo = photos[index];
                const button = document.createElement("button");
                button.type = "button";
                button.className = "bcvc-photo";
                button.dataset.layout = single ? "single" : wide ? "wide" : "square";
                button.setAttribute("aria-label", `첨부 사진 ${index + 1}/${photos.length} 크게 보기`);
                button.setAttribute("aria-haspopup", "dialog");
                button.addEventListener("click", (event) => {
                    event.stopPropagation();
                    openPhotoViewer(sources, index, button);
                });
                const image = createAttachmentImage(photo);
                if (single && photo.height > photo.width) image.style.aspectRatio = `${photo.width} / ${photo.height}`;
                button.appendChild(image);
                if (wide && index === visibleCount - 1 && photos.length > visibleCount) {
                    const more = document.createElement("span");
                    more.className = "bcvc-photo-more";
                    more.textContent = `+${photos.length - visibleCount}`;
                    button.appendChild(more);
                }
                wrapper.appendChild(button);
            }
            return wrapper;
        }

        function createPhotoControl(label, pathData, activate) {
            const button = document.createElement("button");
            button.type = "button";
            button.title = label;
            button.setAttribute("aria-label", label);
            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.setAttribute("viewBox", "0 0 24 24");
            icon.setAttribute("aria-hidden", "true");
            const path = document.createElementNS(icon.namespaceURI, "path");
            path.setAttribute("d", pathData);
            icon.append(path);
            button.append(icon);
            button.addEventListener("click", activate);
            return button;
        }

        function dismissPhotoViewer() {
            if (!photoDialog) return;
            const dialog = photoDialog;
            photoDialog = null;
            if (dialog.open) dialog.close();
            dialog.remove();
        }

        function openPhotoViewer(photos, index, trigger) {
            if (!isCommentsVisible() || !commentPanel?.contains(trigger) || !photos[index] || photoDialog) return;
            // Use CHZZK's complete viewer when the current native row owns these same photos.
            if (onOpenNativePhoto(trigger, photos, index)) return;

            const dialog = document.createElement("dialog");
            dialog.className = "bcvc-photo-viewer";
            dialog.setAttribute("aria-label", "댓글 사진 확대");
            const stage = document.createElement("div");
            stage.className = "bcvc-photo-stage";
            stage.tabIndex = -1;
            stage.setAttribute("role", "group");
            stage.setAttribute("aria-label", "사진 보기");
            let image;
            const counter = document.createElement("span");
            counter.className = "bcvc-photo-counter";
            counter.setAttribute("aria-live", "polite");
            counter.hidden = photos.length === 1;
            const status = document.createElement("p");
            status.className = "bcvc-photo-status";
            status.setAttribute("role", "status");
            const actions = document.createElement("div");
            actions.className = "bcvc-photo-actions";
            const lens = "M17 17l4.5 4.5M18.5 11a7.5 7.5 0 1 1-15 0 7.5 7.5 0 1 1 15 0";
            const zoomIn = createPhotoControl("확대", lens + "M8 11h6m-3-3v6", () => setZoom(true));
            const zoomOut = createPhotoControl("축소", lens + "M8 11h6", () => setZoom(false));
            const close = createPhotoControl("닫기", "m6 6 12 12m0-12L6 18", () => dialog.close());
            actions.append(zoomIn, zoomOut, close);
            const previous = createPhotoControl("이전 사진", "m15 4-8 8 8 8", () => showPhoto(index - 1));
            const next = createPhotoControl("다음 사진", "m9 4 8 8-8 8", () => showPhoto(index + 1));
            previous.className = next.className = "bcvc-photo-step";
            previous.dataset.direction = "prev";
            next.dataset.direction = "next";
            previous.hidden = next.hidden = photos.length === 1;
            dialog.append(stage, counter, status, previous, next, actions);

            function syncControls() {
                const focused = document.activeElement;
                const zoomed = image.hasAttribute("data-zoomed");
                zoomIn.disabled = zoomed || !image.naturalWidth || image.hidden;
                zoomOut.disabled = !zoomed || image.hidden;
                previous.disabled = index === 0;
                next.disabled = index === photos.length - 1;
                if (focused instanceof HTMLButtonElement && focused.disabled && dialog.contains(focused)) {
                    stage.focus({ preventScroll: true });
                }
            }

            function setZoom(zoomed) {
                image.style.width = zoomed
                    ? `${Math.max(image.naturalWidth, image.getBoundingClientRect().width * 2)}px`
                    : "";
                image.toggleAttribute("data-zoomed", zoomed);
                if (!zoomed) stage.scrollTop = stage.scrollLeft = 0;
                syncControls();
            }

            function showPhoto(position) {
                if (position < 0 || position >= photos.length) return;
                index = position;
                status.textContent = "사진 불러오는 중";
                status.hidden = false;
                // A slow previous image must never appear under the next photo's number.
                image = document.createElement("img");
                image.referrerPolicy = "no-referrer";
                image.draggable = false;
                image.hidden = true;
                image.alt = `댓글 사진 ${position + 1} / ${photos.length}`;
                stage.replaceChildren(image);
                image.src = photos[position];
                setZoom(false);
                counter.textContent = `${position + 1} / ${photos.length}`;
            }

            stage.addEventListener(
                "load",
                (event) => {
                    if (event.target !== image) return;
                    image.hidden = false;
                    status.hidden = true;
                    syncControls();
                },
                true
            );
            stage.addEventListener(
                "error",
                (event) => {
                    if (event.target === image) status.textContent = "사진을 불러올 수 없음.";
                },
                true
            );
            stage.addEventListener("dblclick", (event) => {
                if (event.target === image) setZoom(!image.hasAttribute("data-zoomed"));
            });
            dialog.addEventListener("keydown", (event) => {
                if (event.altKey || event.ctrlKey || event.metaKey) return;
                if (event.key === "Escape") dialog.close();
                else if (event.key === "ArrowLeft") showPhoto(index - 1);
                else if (event.key === "ArrowRight") showPhoto(index + 1);
                else return;
                event.preventDefault();
                event.stopPropagation();
            });
            dialog.addEventListener(
                "close",
                () => {
                    if (photoDialog !== dialog) return;
                    photoDialog = null;
                    dialog.remove();
                    if (trigger.isConnected && isCommentsVisible()) trigger.focus({ preventScroll: true });
                },
                { once: true }
            );
            (document.fullscreenElement || document.body).append(dialog);
            photoDialog = dialog;
            showPhoto(index);
            dialog.showModal();
            stage.focus({ preventScroll: true });
        }

        function createCommentFooter(item) {
            const rawBuffCount = Number(item?.row?.buffNerf?.buffCount);
            if (!Number.isFinite(rawBuffCount) || rawBuffCount < 0) return null;
            const buffCount = Math.trunc(rawBuffCount);

            const footer = document.createElement("div");
            footer.className = "bcvc-comment-footer";
            const buff = document.createElement("button");
            buff.type = "button";
            buff.className = "bcvc-buff";
            buff.setAttribute("data-bcvc-action", "buff");
            buff.setAttribute("data-bcvc-count", String(buffCount));
            buff.setAttribute("aria-label", `버프 ${buffCount.toLocaleString()}`);
            buff.setAttribute("aria-pressed", "false");
            buff.setAttribute("aria-describedby", NATIVE_ACTION_HINT_ID);
            buff.disabled = true;
            buff.title = "하단 원본 댓글이 표시될 때 버프 가능.";
            const label = document.createElement("span");
            label.className = "bcvc-buff-label";
            label.setAttribute("aria-hidden", "true");
            label.textContent = "버프";
            buff.appendChild(label);
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

        function createReplyItem(parentItem, row, index) {
            return {
                best: false,
                key: model.getReplyKey(parentItem.key, row, index),
                replyToName: model.compactText(parentItem?.row?.user?.userNickname),
                row,
            };
        }

        function createReplyToggle(count) {
            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "bcvc-reply-toggle";
            toggle.append(`답글 ${count.toLocaleString()}`);
            toggle.setAttribute("data-bcvc-action", "reply-toggle");
            toggle.setAttribute("aria-expanded", "false");

            const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            icon.setAttribute("width", "14");
            icon.setAttribute("height", "14");
            icon.setAttribute("viewBox", "0 0 14 14");
            icon.setAttribute("fill", "none");
            icon.setAttribute("aria-hidden", "true");
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", "M10 8.2002L7 5.2002L4 8.2002");
            path.setAttribute("stroke", "currentColor");
            path.setAttribute("stroke-width", "1.6");
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            icon.appendChild(path);
            toggle.appendChild(icon);
            return toggle;
        }

        function appendCommentMessage(message, fullText, allowTimecodes, commentId) {
            const collapsedText = model.getCollapsedCommentText(fullText);
            const content = document.createElement("span");
            content.className = "bcvc-message-content";
            message.appendChild(content);
            appendCommentText(content, collapsedText || fullText, { allowTimecodes, sourceText: fullText });
            if (!collapsedText) return;

            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "bcvc-message-toggle";
            toggle.setAttribute("data-bcvc-action", "message-toggle");
            toggle.setAttribute("aria-expanded", "false");
            toggle.textContent = "더보기";
            messageToggleStates.set(toggle, { allowTimecodes, commentId, content, fullText });
            message.appendChild(toggle);
        }

        function appendBestBadge(message) {
            const svgNamespace = "http://www.w3.org/2000/svg";
            const icon = document.createElementNS(svgNamespace, "svg");
            icon.setAttribute("class", "bcvc-best");
            icon.setAttribute("viewBox", "0 0 39 18");
            icon.setAttribute("aria-hidden", "true");
            const background = document.createElementNS(svgNamespace, "rect");
            background.setAttribute("y", "0.5");
            background.setAttribute("width", "39");
            background.setAttribute("height", "17");
            background.setAttribute("rx", "4.61538");
            background.setAttribute("fill", "#41BD53");
            const lettering = document.createElementNS(svgNamespace, "path");
            lettering.setAttribute("d", BEST_BADGE_LETTERING);
            lettering.setAttribute("fill", "white");
            icon.append(background, lettering);

            const label = document.createElement("span");
            label.className = "bcvc-sr-only";
            label.textContent = "BEST";
            message.append(icon, label);
        }

        function createCommentRow(item, { includeReplies = true, reply = false, replyBudget = null } = {}) {
            const rowData = item?.row && typeof item.row === "object" ? item.row : {};
            const hasComment = Boolean(rowData.comment && typeof rowData.comment === "object");
            const comment = hasComment ? rowData.comment : {};
            const user = rowData.user && typeof rowData.user === "object" ? rowData.user : {};
            const deleted = comment.deleted === true;
            const cleanBotHidden = comment.hideByCleanBot === true;
            const authorName = deleted ? "삭제된 댓글" : model.compactText(user.userNickname) || "알 수 없음";
            const row = document.createElement("article");
            row.className = "bcvc-comment";
            row.setAttribute("role", "listitem");
            row.setAttribute("data-bcvc-comment-key", item.key);
            const commentId = getCommentId(item);
            if (commentId) row.setAttribute("data-bcvc-comment-id", commentId);
            if (reply) row.setAttribute("data-bcvc-reply", "1");
            if (deleted) row.setAttribute("data-bcvc-deleted", "1");

            if (!deleted) {
                row.appendChild(createAvatar(item, authorName));

                const meta = document.createElement("div");
                meta.className = "bcvc-meta";
                const author = document.createElement("button");
                author.type = "button";
                author.className = "bcvc-author";
                author.textContent = authorName;
                author.setAttribute("data-bcvc-action", "profile");
                author.setAttribute("data-bcvc-profile-target", "author");
                author.setAttribute("aria-label", `${authorName} 프로필 보기`);
                author.disabled = true;
                author.title = "하단 원본 댓글이 표시될 때 프로필 보기 가능.";
                author.setAttribute("aria-describedby", NATIVE_ACTION_HINT_ID);
                meta.appendChild(author);
                if (user.writer === true) {
                    const writer = document.createElement("span");
                    writer.className = "bcvc-badge bcvc-writer";
                    writer.textContent = "방송자";
                    meta.appendChild(writer);
                }
                const dateText = model.formatCommentDate(comment.createdDate);
                if (dateText) {
                    const date = document.createElement("span");
                    date.className = "bcvc-date";
                    date.textContent = dateText;
                    meta.appendChild(date);
                }
                row.appendChild(meta);
            }

            const message = document.createElement("div");
            message.className = "bcvc-message";
            if (item.best) appendBestBadge(message);
            let messageText = deleted
                ? "삭제된 댓글"
                : !hasComment
                  ? "표시할 수 없는 댓글"
                  : cleanBotHidden
                    ? "클린봇 감지: 부적절한 표현"
                    : String(comment.content || "");
            if (reply && !deleted && !cleanBotHidden) {
                const replyToName = model.compactText(item.replyToName);
                if (replyToName) {
                    const mention = document.createElement("span");
                    mention.className = "bcvc-mention";
                    mention.textContent = replyToName;
                    message.appendChild(mention);
                    messageText = messageText.trimStart();
                }
            }
            appendCommentMessage(message, messageText, !deleted && !cleanBotHidden, commentId);
            row.appendChild(message);
            if (!deleted && !cleanBotHidden) {
                const attachments = createAttachments(comment);
                if (attachments) row.appendChild(attachments);
            }
            let footer = !deleted && !cleanBotHidden && hasComment ? createCommentFooter(item) : null;
            let replyList = null;
            let replyLimit = null;

            if (includeReplies) {
                const { rows: replies, truncated } = model.collectReplyRows(rowData);
                if (replies.length || truncated) {
                    const availableReplies = replyBudget
                        ? Math.max(0, Math.min(replies.length, replyBudget.remaining))
                        : replies.length;
                    const visibleReplies = replies.slice(0, availableReplies);
                    if (replyBudget) replyBudget.remaining -= visibleReplies.length;
                    if (visibleReplies.length) {
                        const replyToggle = createReplyToggle(visibleReplies.length);
                        if (!footer) {
                            footer = document.createElement("div");
                            footer.className = "bcvc-comment-footer";
                        }
                        footer.prepend(replyToggle);
                        replyList = document.createElement("div");
                        replyList.className = "bcvc-replies";
                        replyList.setAttribute("role", "list");
                        replyList.setAttribute("aria-label", "답글");
                        replyList.hidden = true;
                        visibleReplies.forEach((replyRow, index) =>
                            replyList.appendChild(
                                createCommentRow(createReplyItem(item, replyRow, index), {
                                    includeReplies: false,
                                    reply: true,
                                })
                            )
                        );
                    }
                    if (truncated || visibleReplies.length < replies.length) {
                        replyLimit = document.createElement("div");
                        replyLimit.className = "bcvc-reply-limit";
                        // 펼칠 답글이 없으면 토글도 없으므로 한도 안내를 바로 보여 답글 없는 댓글처럼 보이지 않게 해요.
                        replyLimit.hidden = visibleReplies.length > 0;
                        replyLimit.textContent =
                            replyBudget?.remaining === 0 ||
                            visibleReplies.length < replies.length ||
                            !visibleReplies.length
                                ? `이 정렬은 답글 최대 ${MAX_REPLIES_PER_ORDER}개 표시.`
                                : `댓글당 답글 최대 ${MAX_REPLIES_PER_COMMENT}개 표시.`;
                    }
                }
            }
            if (footer) row.appendChild(footer);
            if (replyList) row.appendChild(replyList);
            if (replyLimit) row.appendChild(replyLimit);
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
            count.textContent = Number.isFinite(state.totalCount)
                ? `댓글 ${state.totalCount.toLocaleString()}`
                : "댓글";
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

            const refresh = document.createElement("button");
            refresh.type = "button";
            refresh.className = "bcvc-icon-button";
            refresh.setAttribute("data-bcvc-action", "refresh");
            refresh.setAttribute("aria-label", "댓글 새로고침");
            refresh.title = "댓글 새로고침";
            refresh.disabled = state.loading;
            refresh.appendChild(createRefreshIcon());
            toolbar.append(refresh, sort);
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
                status.textContent = "댓글 더 불러오는 중…";
                footer.appendChild(status);
                return footer;
            }
            if (state.moreError) {
                const status = document.createElement("p");
                status.className = "bcvc-footer-status";
                status.textContent = "댓글 추가 불러오기 실패.";
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
                status.textContent = `댓글 최대 ${MAX_COMMENTS_PER_ORDER.toLocaleString()}개 표시.`;
                footer.appendChild(status);
            }
            return footer;
        }

        function createCommentStateView(state) {
            const view = document.createElement("div");
            view.className = "bcvc-comments";
            view.setAttribute("data-bcvc-comments", "1");
            view.setAttribute("data-bcvc-mirror", "1");
            view.setAttribute("data-bcvc-order", state.order);
            view.setAttribute("data-bcvc-version", String(state.version));
            const nativeActionHint = document.createElement("p");
            nativeActionHint.id = NATIVE_ACTION_HINT_ID;
            nativeActionHint.className = "bcvc-sr-only";
            nativeActionHint.textContent = "하단 원본 댓글에 같은 댓글이 표시될 때 프로필·버프 사용 가능.";
            view.appendChild(nativeActionHint);
            view.appendChild(createToolbar(state));

            if (state.loading && !state.loaded) {
                view.appendChild(createSkeletonList());
                return view;
            }
            if (state.error && !state.loaded) {
                view.appendChild(createStateBlock("댓글 불러오기 실패.", "다시 시도", "retry-initial"));
                return view;
            }
            if (!state.commentActive) {
                view.appendChild(createStateBlock("댓글을 사용할 수 없는 영상."));
                return view;
            }
            if (!state.items.length) {
                view.appendChild(createStateBlock("등록된 댓글 없음."));
                return view;
            }

            const list = document.createElement("div");
            list.className = "bcvc-list";
            list.setAttribute("role", "list");
            list.setAttribute("data-bcvc-list", "1");
            const replyBudget = { remaining: MAX_REPLIES_PER_ORDER };
            state.items.forEach((item) => list.appendChild(createCommentRow(item, { replyBudget })));
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
            if (!isCommentsVisible() || typeof IntersectionObserver !== "function" || !commentPanel) return;
            const sentinel = commentPanel.querySelector("[data-bcvc-sentinel='1']");
            if (!(sentinel instanceof HTMLElement)) return;
            loadMoreObserver = new IntersectionObserver(
                (entries) => {
                    if (entries.some((entry) => entry.isIntersecting)) onLoadMore(null);
                },
                { root: commentPanel, rootMargin: "0px 0px 160px", threshold: 0 }
            );
            loadMoreObserver.observe(sentinel);
        }

        function renderState(state, { restoreScroll = true } = {}) {
            if (!isCommentsVisible()) return;
            dismissPhotoViewer();
            disconnectLoadMoreObserver();
            commentPanel.setAttribute("aria-busy", String(state.loading));
            commentPanel.replaceChildren(createCommentStateView(state));
            if (restoreScroll) commentPanel.scrollTop = state.scrollTop;
            connectLoadMoreObserver();
            onRendered();
        }

        function updateState(state) {
            if (!isCommentsVisible()) return;
            disconnectLoadMoreObserver();
            const footer = commentPanel.querySelector("[data-bcvc-footer='1']");
            if (footer) footer.replaceWith(createFooter(state));
            const refresh = commentPanel.querySelector("[data-bcvc-action='refresh']");
            if (refresh instanceof HTMLButtonElement) refresh.disabled = state.loading;
            commentPanel.setAttribute("aria-busy", String(state.loading));
            stampRenderedView(state);
            connectLoadMoreObserver();
        }

        function appendRows(state, added) {
            if (!isCommentsVisible()) return;
            const list = commentPanel.querySelector("[data-bcvc-list='1']");
            if (!(list instanceof HTMLElement) || !state.commentActive) {
                renderState(state);
                return;
            }
            // 새 행이 없는 추가 페이지(이미 받은 댓글뿐)는 기존 행을 다시 그리지 않아 펼친 답글·본문을 보존해요.
            if (added.length) {
                const fragment = document.createDocumentFragment();
                const renderedReplies = list.querySelectorAll("[data-bcvc-reply='1']").length;
                const replyBudget = { remaining: Math.max(0, MAX_REPLIES_PER_ORDER - renderedReplies) };
                added.forEach((item) => fragment.appendChild(createCommentRow(item, { replyBudget })));
                list.appendChild(fragment);
            }
            const count = commentPanel.querySelector("[data-bcvc-count='1']");
            if (count)
                count.textContent = Number.isFinite(state.totalCount)
                    ? `댓글 ${state.totalCount.toLocaleString()}`
                    : "댓글";
            updateState(state);
            onRendered();
        }

        function expandCommentMessage(control) {
            const record = messageToggleStates.get(control);
            if (!record) return;
            const { allowTimecodes, commentId, content, fullText } = record;
            const restoreFocus = document.activeElement === control;
            content.replaceChildren();
            appendCommentText(content, fullText, { allowTimecodes });
            control.remove();
            if (restoreFocus) {
                content.tabIndex = -1;
                content.focus({ preventScroll: true });
            }
            if (commentId) onRowRendered(commentId);
        }

        function toggleCommentReplies(control) {
            const row = control.closest?.(".bcvc-comment");
            if (!(row instanceof HTMLElement)) return;
            const replyList = Array.from(row.children).find((child) => child.classList.contains("bcvc-replies"));
            if (!(replyList instanceof HTMLElement)) return;
            const expanded = control.getAttribute("aria-expanded") !== "true";
            control.setAttribute("aria-expanded", String(expanded));
            replyList.hidden = !expanded;
            for (const limit of Array.from(row.children).filter((child) =>
                child.classList.contains("bcvc-reply-limit")
            )) {
                limit.hidden = !expanded;
            }
        }

        function restoreCommentControlFocus(request) {
            if (!request || !isCommentsVisible() || !commentPanel?.isConnected) return;
            const active = document.activeElement;
            if (
                active instanceof Element &&
                active !== document.body &&
                active.isConnected &&
                active !== request.origin
            ) {
                return;
            }

            let target = null;
            if (request.action === "sort") {
                target = Array.from(commentPanel.querySelectorAll("[data-bcvc-action='sort']")).find(
                    (control) => control.getAttribute("data-bcvc-order") === request.order
                );
            } else if (request.action === "refresh") {
                target = commentPanel.querySelector("[data-bcvc-action='refresh']");
            } else if (request.action === "retry-initial") {
                target =
                    commentPanel.querySelector("[data-bcvc-action='retry-initial']") ||
                    commentPanel.querySelector("[data-bcvc-action='refresh']");
            } else if (["load-more", "retry-more"].includes(request.action)) {
                target =
                    commentPanel.querySelector("[data-bcvc-action='retry-more']") ||
                    commentPanel.querySelector("[data-bcvc-action='load-more']");
            }
            if (!(target instanceof HTMLElement) && request.resultKey) {
                target = Array.from(commentPanel.querySelectorAll("[data-bcvc-comment-key]")).find(
                    (row) => row.getAttribute("data-bcvc-comment-key") === request.resultKey
                );
            }
            if (!(target instanceof HTMLElement)) {
                target = commentPanel.querySelector("[data-bcvc-action='refresh']");
            }
            if (target instanceof HTMLElement && !target.matches(":disabled")) {
                if (!target.matches("button, a[href], input, select, textarea, [tabindex]")) target.tabIndex = -1;
                target.focus();
            }
        }

        function onCommentPanelClick(event) {
            const control = event.target.closest?.("[data-bcvc-action]");
            if (!(control instanceof HTMLElement) || !commentPanel?.contains(control)) return;
            const action = control.getAttribute("data-bcvc-action") || "";
            event.preventDefault();
            event.stopPropagation();
            if (action === "time") {
                onTimecode(control);
            } else if (action === "message-toggle") {
                expandCommentMessage(control);
            } else if (action === "reply-toggle") {
                toggleCommentReplies(control);
            } else if (action === "profile" || action === "buff") {
                onNativeAction(control, action);
            } else if (action === "sort") {
                const order = control.getAttribute("data-bcvc-order") || "";
                onOrderChange(order, { action: "sort", order, origin: control });
            } else if (action === "refresh") {
                onRefresh({ action: "refresh", origin: control });
            } else if (action === "retry-initial") {
                onRetryInitial({ action, origin: control });
            } else if (["load-more", "retry-more"].includes(action)) {
                onLoadMore({ action, origin: control });
            }
        }

        function onCommentPanelScroll(event) {
            // Chrome은 문서에서 빠지거나 숨겨진 패널에도 지연된 scroll을 보내고 그때 scrollTop은 0이에요. 저장된 위치를 덮어쓰지 않아요.
            if (!(commentPanel instanceof HTMLElement) || event?.currentTarget !== commentPanel) return;
            if (!commentPanel.isConnected || commentPanel.hidden || !isCommentsVisible()) return;
            onScroll(commentPanel.scrollTop || 0);
        }

        function updateTabState({ focus = false } = {}) {
            const commentOnly = Boolean(commentTab) && !chatTab;
            const commentsSelected = commentOnly || selectedTab === "comments";
            const splitLayout = hasSplitLayout();
            if (splitLayout) restoreChatTabHiddenState();
            nativeChatHidden = splitLayout && isNativeChatHidden();
            if (nativeChatHidden) stopSplitDrag();
            const commentsVisible = splitLayout || commentsSelected;
            if (commentOnly) selectedTab = "comments";
            tablist?.setAttribute("role", splitLayout ? "group" : "tablist");
            if (chatTab) chatTab.hidden = splitLayout;
            if (commentTab) commentTab.hidden = splitLayout;
            if (splitTitle) {
                splitTitle.hidden = !splitLayout;
                splitTitle.textContent = !splitLayout
                    ? ""
                    : nativeChatHidden
                      ? "댓글"
                      : splitTop === "chat"
                        ? "채팅 · 댓글"
                        : "댓글 · 채팅";
            }
            chatTab?.setAttribute("aria-selected", String(!commentsSelected));
            commentTab?.setAttribute("aria-selected", String(commentsSelected));
            if (chatTab) chatTab.tabIndex = commentsSelected ? -1 : 0;
            if (commentTab) commentTab.tabIndex = commentsSelected ? 0 : -1;
            if (mountedChatLog) {
                if (commentsSelected && !splitLayout && !mountedChatLog.hasAttribute("data-bcvc-tab-hidden")) {
                    originalChatAriaHidden = mountedChatLog.getAttribute("aria-hidden");
                    mountedChatLog.setAttribute("data-bcvc-tab-hidden", "1");
                    mountedChatLog.setAttribute("aria-hidden", "true");
                } else if (!commentsSelected || splitLayout) restoreChatTabHiddenState();
            }
            if (commentPanel) {
                commentPanel.hidden = !commentsVisible;
                commentPanel.setAttribute("role", splitLayout ? "region" : "tabpanel");
                if (splitLayout) {
                    commentPanel.removeAttribute("aria-labelledby");
                    commentPanel.setAttribute("aria-label", "댓글");
                } else {
                    commentPanel.setAttribute("aria-labelledby", COMMENT_TAB_ID);
                    commentPanel.removeAttribute("aria-label");
                }
            }
            if (!commentsVisible) {
                dismissPhotoViewer();
                disconnectLoadMoreObserver();
            }
            syncNativeHeaderAppearance();
            if (focus) (commentsSelected ? commentTab : chatTab)?.focus();
        }

        function setSelectedTab(tab, options = {}) {
            selectedTab = tab === "comments" ? "comments" : "chat";
            updateTabState(options);
        }

        function onTabClick(event) {
            const button = event.target.closest?.("button[role='tab']");
            if (button === chatTab) onTabChange("chat");
            else if (button === commentTab) onTabChange("comments");
        }

        function onTabKeyDown(event) {
            if (isSplit()) return;
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            if (!chatTab) {
                commentTab?.focus();
                return;
            }
            if (event.key === "Home") {
                onTabChange("chat", { focus: true });
                return;
            }
            if (event.key === "End") {
                onTabChange("comments", { focus: true });
                return;
            }
            const currentIndex = event.target === commentTab ? 1 : 0;
            const direction = event.key === "ArrowRight" ? 1 : -1;
            const nextIndex = (currentIndex + direction + 2) % 2;
            onTabChange(nextIndex === 0 ? "chat" : "comments", { focus: true });
        }

        function detachMountedChatLog() {
            stopSplitDrag();
            clearSplitChatMarkers();
            chatVisibilityObserver?.disconnect();
            chatVisibilityObserver = null;
            nativeChatHidden = false;
            const chatLog = mountedChatLog;
            restoreChatTabHiddenState();
            chatLog?.removeAttribute("data-bcvc-native-log");
            if (assignedChatLogId && chatLog?.id === CHAT_PANEL_ID) chatLog.removeAttribute("id");
            mountedChatLog = null;
            assignedChatLogId = false;
            originalChatAriaHidden = null;
        }

        function attachMountedChatLog(chatLog) {
            if (!(chatLog instanceof HTMLElement)) return false;
            mountedChatLog = chatLog;
            originalChatAriaHidden = mountedChatLog.getAttribute("aria-hidden");
            mountedChatLog.setAttribute("data-bcvc-native-log", "1");
            if (!mountedChatLog.id) {
                mountedChatLog.id = CHAT_PANEL_ID;
                assignedChatLogId = true;
            }
            chatTab?.setAttribute("aria-controls", mountedChatLog.id);
            chatVisibilityObserver = new MutationObserver(syncChatVisibility);
            observeChatAncestors();
            return true;
        }

        function clearMountedNativeMarkers() {
            mountedHeading?.removeAttribute("data-bcvc-heading");
            mountedHeader?.removeAttribute("data-bcvc-header");
            mountedContainer?.removeAttribute("data-bcvc-container");
            mountedContainer?.removeAttribute("data-bcvc-layout");
            for (const name of ["chat-top", "chat-height", "comment-top", "comment-height", "divider-top"])
                mountedContainer?.style.removeProperty(`--bcvc-${name}`);
            splitBounds = null;
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
            if (mountedAppearanceHeading?.isConnected && mountedAppearanceHeading !== mountedHeading) {
                resizeObserver.observe(mountedAppearanceHeading);
            }
        }

        function syncMountedAnchors(anchors) {
            if (mountedChatLog !== anchors.chatLog) replaceChatLog(anchors.chatLog);
            else if (chatVisibilityObserver) {
                // The site can keep the log and header while replacing any wrapper between them.
                observeChatAncestors();
                syncChatVisibility();
            }
            const heading = anchors.appearanceHeading;
            const nextHeading = heading instanceof HTMLElement ? heading : mountedHeading;
            if (mountedAppearanceHeading === nextHeading) {
                scheduleNativeHeaderSync();
                return;
            }
            mountedAppearanceHeading = nextHeading;
            observeMountedLayout();
            syncNativeHeaderAppearance();
            scheduleNativeHeaderSync();
        }

        function mountTabs(anchors) {
            injectStyles();
            mountedAside = anchors.aside;
            mountedContainer = anchors.container;
            mountedHeader = anchors.header;
            mountedHeading = anchors.heading;
            mountedAppearanceHeading =
                anchors.appearanceHeading instanceof HTMLElement ? anchors.appearanceHeading : mountedHeading;
            const hasChat = attachMountedChatLog(anchors.chatLog);

            mountedAside.setAttribute("data-bcvc-mounted", "1");
            mountedContainer.setAttribute("data-bcvc-container", "1");
            mountedHeader.setAttribute("data-bcvc-header", "1");
            mountedHeading.setAttribute("data-bcvc-heading", "1");

            tablist = document.createElement("div");
            tablist.id = TABLIST_ID;
            tablist.setAttribute("role", "tablist");
            tablist.setAttribute("aria-label", "다시보기 보조 패널");
            chatTab = hasChat ? createTabButton(CHAT_TAB_ID, "채팅", mountedChatLog.id) : null;
            commentTab = createTabButton(COMMENT_TAB_ID, "댓글", COMMENT_PANEL_ID);
            if (chatTab) tablist.appendChild(chatTab);
            tablist.appendChild(commentTab);
            splitTitle = document.createElement("span");
            splitTitle.className = "bcvc-split-title";
            splitTitle.hidden = true;
            tablist.appendChild(splitTitle);
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
            splitter = document.createElement("div");
            splitter.id = SPLITTER_ID;
            splitter.hidden = true;
            splitter.tabIndex = 0;
            splitter.setAttribute("role", "separator");
            splitter.setAttribute("aria-orientation", "horizontal");
            splitter.setAttribute("aria-label", "채팅과 댓글 크기 조절");
            splitter.setAttribute("aria-valuemin", "20");
            splitter.setAttribute("aria-valuemax", "80");
            splitter.addEventListener("pointerdown", onSplitterPointerDown);
            splitter.addEventListener("keydown", onSplitterKeyDown);
            splitter.addEventListener("dblclick", () => {
                stopSplitDrag();
                setSplitRatio(50);
            });
            mountedContainer.appendChild(splitter);

            observeMountedLayout();
            syncNativeHeaderAppearance();
            scheduleNativeHeaderSync();
            updateTabState();
            return true;
        }

        function reattach(anchors) {
            if (!canReattach()) return false;
            dismissPhotoViewer();
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
            mountedAppearanceHeading =
                anchors.appearanceHeading instanceof HTMLElement ? anchors.appearanceHeading : mountedHeading;
            attachMountedChatLog(anchors.chatLog);

            mountedAside.setAttribute("data-bcvc-mounted", "1");
            mountedContainer.setAttribute("data-bcvc-container", "1");
            mountedHeader.setAttribute("data-bcvc-header", "1");
            mountedHeading.setAttribute("data-bcvc-heading", "1");
            chatTab.textContent = "채팅";
            mountedHeader.insertBefore(tablist, mountedHeading);
            mountedContainer.appendChild(commentPanel);
            mountedContainer.appendChild(splitter);

            observeMountedLayout();
            syncNativeHeaderAppearance();
            scheduleNativeHeaderSync();
            updateTabState();
            return true;
        }

        function replaceChatLog(chatLog) {
            if (!(chatLog instanceof HTMLElement) || !chatTab) return false;
            detachMountedChatLog();
            attachMountedChatLog(chatLog);
            updateTabState();
            scheduleNativeHeaderSync();
            return true;
        }

        function destroy() {
            dismissPhotoViewer();
            stopSplitDrag();
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
            splitter?.remove();

            detachMountedChatLog();
            clearMountedNativeMarkers();

            mountedAside = null;
            mountedContainer = null;
            mountedHeader = null;
            mountedHeading = null;
            mountedAppearanceHeading = null;
            tablist = null;
            chatTab = null;
            commentTab = null;
            commentPanel = null;
            splitter = null;
            splitTitle = null;
        }

        function canReattach() {
            return (
                tablist instanceof HTMLElement &&
                commentPanel instanceof HTMLElement &&
                chatTab instanceof HTMLButtonElement &&
                commentTab instanceof HTMLButtonElement
            );
        }

        function hasMount() {
            return Boolean(mountedAside || mountedChatLog || tablist || commentPanel);
        }

        function matchesShell(anchors) {
            return (
                mountedAside === anchors?.aside &&
                mountedContainer === anchors?.container &&
                mountedHeader === anchors?.header &&
                mountedHeading === anchors?.heading
            );
        }

        function ownedNodesConnected() {
            return Boolean(tablist?.isConnected && commentPanel?.isConnected && splitter?.isConnected);
        }

        function isDisconnected() {
            return (
                hasMount() &&
                (!mountedAside?.isConnected ||
                    (Boolean(chatTab) && !mountedChatLog?.isConnected) ||
                    !tablist?.isConnected ||
                    !commentPanel?.isConnected ||
                    !splitter?.isConnected)
            );
        }

        function getPanel() {
            return commentPanel;
        }

        function getChatLog() {
            return mountedChatLog;
        }

        function getScrollTop() {
            return commentPanel?.scrollTop || 0;
        }

        function setScrollTop(value) {
            if (commentPanel) commentPanel.scrollTop = Number(value) || 0;
        }

        function setActiveOrder(order) {
            activeOrder = model.isCommentOrder(order) ? order : model.DEFAULT_ORDER;
        }

        function showState(state, { focusRequest = null } = {}) {
            if (isRenderedViewCurrent(state)) {
                setScrollTop(state.scrollTop);
                connectLoadMoreObserver();
            } else {
                renderState(state);
            }
            restoreCommentControlFocus(focusRequest);
        }

        return Object.freeze({
            appendRows,
            applyNativeMeasurements,
            canReattach,
            destroy,
            getChatLog,
            getPanel,
            getScrollTop,
            hasMount,
            isDisconnected,
            isCommentsVisible,
            matchesShell,
            mount: mountTabs,
            ownedNodesConnected,
            reattach,
            renderState,
            restoreFocus: restoreCommentControlFocus,
            scheduleLayoutSync: scheduleNativeHeaderSync,
            setActiveOrder,
            syncMountedAnchors,
            setLayout,
            setSelectedTab,
            showState,
            updateState,
        });
    }

    namespace.view = Object.freeze({ createCommentView });
})();
