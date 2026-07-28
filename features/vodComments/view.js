/**
 * features/vodComments/view.js — VOD 댓글 탭과 댓글 목록 DOM을 관리한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: BetterChzzk.vodComments.model, BetterChzzk.utils.injectStyleOnce(주입).
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const namespace = (root.vodComments = root.vodComments || {});
    if (namespace.view) return;

    const model = namespace.model;
    const STYLE_ID = "betterchzzk-vod-comment-tabs-style";
    const TABLIST_ID = "betterchzzk-vod-comment-tabs";
    const CHAT_TAB_ID = "betterchzzk-vod-comment-chat-tab";
    const COMMENT_TAB_ID = "betterchzzk-vod-comment-comment-tab";
    const CHAT_PANEL_ID = "betterchzzk-vod-comment-chat-panel";
    const COMMENT_PANEL_ID = "betterchzzk-vod-comment-panel";
    const NATIVE_ACTION_HINT_ID = "betterchzzk-vod-comment-native-action-hint";
    const { MAX_COMMENTS_PER_ORDER, MAX_REPLIES_PER_COMMENT, MAX_REPLIES_PER_ORDER, SORT_OPTIONS, TIMECODE_SCAN_RE } =
        model;

    function createCommentView({
        injectStyleOnce,
        onLoadMore = () => {},
        onNativeAction = () => {},
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
        let tablist = null;
        let chatTab = null;
        let commentTab = null;
        let commentPanel = null;
        let selectedTab = "chat";
        let activeOrder = model.DEFAULT_ORDER;
        let nativeMeasurements = {};
        const messageToggleStates = new WeakMap();

        function injectStyles() {
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
#betterchzzk-vod-comment-aside{
  --bcvc-surface:var(--Background-Neutral-Base,var(--Surface-Neutral-Weakest,#fff));
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#292c33);
  --bcvc-border:var(--Border-Neutral-Alpha-Weak,rgba(0,0,0,.08));
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
  color-scheme:light;
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
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#292c33);
  --bcvc-text-base:var(--Content-Neutral-Cool-Base,#444a55);
  --bcvc-text-weak:var(--Content-Neutral-Cool-Weak,#707784);
  --bcvc-hover:var(--Surface-Interaction-Lighten-Hovered,rgba(0,0,0,.04));
  display:flex;
  flex:1 1 auto;
  align-self:stretch;
  min-width:0;
  height:var(--bcvc-header-height,44px);
  container-name:bcvc-tabs;
  container-type:inline-size;
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
  flex:1 1 50%;
  justify-content:center;
  overflow:hidden;
  padding:0 10px;
  text-align:center;
  text-overflow:ellipsis;
  white-space:nowrap;
}
@container bcvc-tabs (max-width:240px){
  #${CHAT_TAB_ID}{flex:1 1 auto;justify-content:flex-start;padding-right:2px;padding-left:2px;text-align:left}
  #${COMMENT_TAB_ID}{flex:0 0 52px;padding-right:3px;padding-left:3px}
}
#${TABLIST_ID} button:hover{
  background:var(--bcvc-hover);
  color:var(--bcvc-text-base);
}
#${TABLIST_ID} button[aria-selected="true"]{
  color:var(--bcvc-text);
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
#betterchzzk-vod-comment-aside #${TABLIST_ID}{
  background:var(--bcvc-surface);
}
#betterchzzk-vod-comment-aside #${COMMENT_TAB_ID}{
  flex:1 1 auto;
  justify-content:flex-start;
  padding:0 20px;
  color:var(--bcvc-text);
  text-align:left;
  cursor:default;
}
#betterchzzk-vod-comment-aside #${COMMENT_TAB_ID}:hover{
  background:transparent;
  color:var(--bcvc-text);
}
#betterchzzk-vod-comment-aside #${COMMENT_TAB_ID}::after{
  display:none;
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
[data-bcvc-native-log="1"]{
  min-height:0!important;
}
#${COMMENT_PANEL_ID}{
  --bcvc-font-family:inherit;
  --bcvc-toolbar-font-family:var(--bcvc-font-family,inherit);
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
  --bcvc-message-line-height:20px;
  --bcvc-message-letter-spacing:normal;
  --bcvc-surface:var(--Background-Neutral-Base,var(--Surface-Neutral-Weakest,#fff));
  --bcvc-surface-raised:var(--Surface-Neutral-Weakest,#f7f8fa);
  --bcvc-surface-soft:var(--Surface-Neutral-Weaker,#eef0f3);
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#292c33);
  --bcvc-text-base:var(--Content-Neutral-Cool-Base,#444a55);
  --bcvc-text-weak:var(--Content-Neutral-Cool-Weak,#707784);
  --bcvc-border:var(--Border-Neutral-Alpha-Weak,rgba(0,0,0,.08));
  --bcvc-brand:var(--Content-Brand-Strong,var(--Content-Brand-Base,#00e693));
  --bcvc-hover:var(--Surface-Interaction-Lighten-Hovered,rgba(0,0,0,.04));
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
  color-scheme:light;
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
  flex:1 1 72px;
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
  flex:0 1 auto;
  align-items:center;
  gap:2px;
  padding:2px;
  border-radius:8px;
  max-width:100%;
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
  font-size:11px;
  font-weight:600;
  line-height:18px;
  white-space:nowrap;
  cursor:pointer;
}
.bcvc-sort-button{font-family:var(--bcvc-toolbar-font-family,var(--bcvc-font-family,inherit))}
.bcvc-sort-button:hover,
.bcvc-icon-button:hover{background:var(--bcvc-hover);color:var(--bcvc-text)}
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
  border:0;
  border-radius:50%;
  padding:0;
  appearance:none;
  background:var(--Surface-Neutral-Base,var(--bcvc-surface-soft));
}
.bcvc-avatar:not(:disabled){cursor:pointer}
.bcvc-avatar:not(:disabled):hover::after{border-color:var(--bcvc-brand)}
.bcvc-avatar:disabled{cursor:default}
.bcvc-avatar::after{content:"";position:absolute;inset:0;border:1px solid var(--Border-Neutral-Alpha-Weakest,rgba(0,0,0,.05));border-radius:inherit;pointer-events:none}
.bcvc-avatar-image,.bcvc-avatar-native-visual{display:block;width:100%;height:100%;border-radius:inherit}
.bcvc-avatar-image{object-fit:cover}
.bcvc-avatar-native-visual{background-position:center;background-repeat:no-repeat;background-size:cover}
.bcvc-avatar-fallback{background-image:url("https://ssl.pstatic.net/static/nng/glive/image/default_profile_light.png");background-position:center;background-repeat:no-repeat;background-size:cover}
html[dark] .bcvc-avatar-fallback,
body[theme="dark"] .bcvc-avatar-fallback,
.theme_dark .bcvc-avatar-fallback{background-image:url("https://ssl.pstatic.net/static/nng/glive/image/default_profile_dark.png")}
.bcvc-meta{display:flex;align-items:center;gap:6px;min-width:0;min-height:18px}
.bcvc-author{display:block;min-width:0;overflow:hidden;border:0;padding:0;background:transparent;color:var(--bcvc-text);font-family:inherit;font-size:var(--bcvc-author-font-size,14px);font-weight:var(--bcvc-author-font-weight,700);line-height:var(--bcvc-author-line-height,18px);letter-spacing:var(--bcvc-author-letter-spacing,normal);text-align:left;text-overflow:ellipsis;white-space:nowrap;appearance:none}
.bcvc-author:not(:disabled){cursor:pointer}
.bcvc-author:not(:disabled):hover{text-decoration:underline}
.bcvc-author:disabled{cursor:default}
.bcvc-date{flex:0 0 auto;color:var(--bcvc-text-weak);font-family:inherit;font-size:var(--bcvc-date-font-size,12px);font-weight:var(--bcvc-date-font-weight,400);line-height:var(--bcvc-date-line-height,18px);letter-spacing:var(--bcvc-date-letter-spacing,normal);white-space:nowrap}
.bcvc-badge{flex:0 0 auto;border-radius:4px;padding:0 4px;font-family:inherit;font-size:9px;font-weight:700;line-height:15px}
.bcvc-writer{background:var(--Surface-Brand-Alpha-Weaker,rgba(0,230,147,.12));color:var(--bcvc-brand)}
.bcvc-message{min-width:0;margin-top:2px;color:var(--bcvc-text);font-family:inherit;font-size:var(--bcvc-message-font-size,15px);font-weight:var(--bcvc-message-font-weight,400);line-height:var(--bcvc-message-line-height,20px);letter-spacing:var(--bcvc-message-letter-spacing,normal);overflow-wrap:anywhere;white-space:pre-wrap}
.bcvc-message-content{display:inline}
.bcvc-message-toggle{display:block;min-height:24px;border:0;padding:2px 0;background:transparent;color:var(--bcvc-brand);font-family:inherit;font-size:12px;font-weight:600;line-height:20px;text-align:left;cursor:pointer}
.bcvc-message-toggle:hover{text-decoration:underline}
.bcvc-best{display:inline-flex;align-items:center;justify-content:center;min-width:39px;height:18px;margin:1px 6px 0 0;border-radius:5px;padding:0 4px;background:#41bd53;color:#fff;font-family:inherit;font-size:9px;font-weight:700;line-height:18px;vertical-align:top}
.bcvc-timecode{display:inline-block;min-height:0;margin:2px 8px 0 0;border:0;border-radius:4px;padding:0 3px;background:var(--Surface-Brand-Alpha-Weaker,rgba(0,255,163,.1));color:var(--Content-Brand-Base,#00e693);font-family:inherit;font-size:15px;font-weight:600;line-height:16px;vertical-align:top;cursor:pointer}
.bcvc-comment-footer{display:flex;align-items:flex-start;justify-content:space-between;min-height:25px;margin-top:2px}
.bcvc-reply-toggle{display:block;margin:0 0 0 4px;border:0;padding:3px 4px 2px 6px;background:transparent;color:var(--Content-Brand-Base,var(--bcvc-brand));font-family:inherit;font-size:13px;font-weight:700;line-height:16px;text-align:left;cursor:pointer}
.bcvc-reply-toggle svg{display:inline-block;width:14px;height:14px;margin:1px 0 0;vertical-align:top}
.bcvc-reply-toggle[aria-expanded="false"] svg{transform:rotate(180deg)}
.bcvc-buff{display:inline-flex;align-items:flex-start;min-height:23px;border:0;padding:0;background:transparent;color:var(--bcvc-text-weak);font-family:inherit;appearance:none}
.bcvc-buff{margin-left:auto}
.bcvc-buff:not(:disabled){cursor:pointer}
.bcvc-buff:not(:disabled):hover,.bcvc-buff[aria-pressed="true"]{color:var(--bcvc-brand)}
.bcvc-buff:disabled{cursor:default}
.bcvc-buff-icon{display:block;flex:0 0 47px;width:47px;height:23px}
.bcvc-buff-native-icon{font-style:normal}
.bcvc-buff-label{display:inline-flex;align-items:center;justify-content:center;width:47px;height:23px;border:2px solid var(--Border-Neutral-Alpha-Weak,rgba(128,137,156,.2));border-radius:12px;font-size:11px;font-weight:700;line-height:19px}
.bcvc-buff-label::after{content:"↑";margin-left:2px;font-size:12px;line-height:1}
.bcvc-buff-count{display:inline-block;margin:5px 3px 0;color:var(--color-content-04,var(--bcvc-text-weak));font-family:inherit;font-size:13px;font-weight:500;line-height:16px}
.bcvc-buff[aria-pressed="true"] .bcvc-buff-count{color:rgb(44,213,136);font-weight:600}
.bcvc-replies{min-width:0;margin:4px 0 0 12px}
.bcvc-replies[hidden]{display:none!important}
.bcvc-replies .bcvc-comment{padding:9px 0 5px 30px}
.bcvc-replies .bcvc-avatar{top:9px;width:22px;height:22px}
.bcvc-replies .bcvc-message{font-size:14px;line-height:18px}
.bcvc-mention{display:inline-block;margin-right:5px;color:var(--Content-Brand-Base,var(--bcvc-brand));font-size:15px;font-weight:700;line-height:20px}
.bcvc-reply-limit{margin:3px 0 4px 20px;color:var(--bcvc-text-weak);font-size:12px;line-height:18px}
.bcvc-reply-limit[hidden]{display:none!important}
.bcvc-comment[data-bcvc-deleted="1"]{padding-left:0}
.bcvc-attachments{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:4px;margin-top:8px;overflow:hidden;border-radius:8px}
.bcvc-attachments[data-count="1"]{display:block}
.bcvc-attachment{display:block;width:100%;height:96px;border-radius:6px;background:var(--bcvc-surface-soft);object-fit:cover}
.bcvc-attachments[data-count="1"] .bcvc-attachment{height:auto;max-height:190px;object-fit:contain}
.bcvc-attachment[data-type="STICKER"],.bcvc-attachment[data-type="EMOTICON"]{object-fit:contain}
.bcvc-state{display:grid;place-items:center;gap:10px;min-height:168px;margin:0;padding:28px 18px;color:var(--bcvc-text-weak);text-align:center}
.bcvc-state p{margin:0;font-family:inherit;font-size:13px;font-weight:500;line-height:20px}
.bcvc-state-button,.bcvc-more-button{min-height:36px;border:0;border-radius:8px;padding:8px 14px;background:color-mix(in srgb,var(--bcvc-surface-soft) 65%,transparent);color:var(--bcvc-text);font-family:inherit;font-size:13px;font-weight:700;line-height:18px;cursor:pointer}
.bcvc-state-button:hover,.bcvc-more-button:hover{background:var(--bcvc-hover)}
.bcvc-skeleton-list{padding:0 6px 0 8px}
.bcvc-skeleton{position:relative;min-height:72px;padding:12px 0 12px 46px;overflow:hidden}
.bcvc-skeleton::before{content:"";position:absolute;top:12px;left:0;width:36px;height:36px;border-radius:50%;background:var(--bcvc-surface-soft)}
.bcvc-skeleton-line{height:10px;margin:2px 0 10px;border-radius:5px;background:var(--bcvc-surface-soft)}
.bcvc-skeleton-line:first-child{width:44%}.bcvc-skeleton-line:last-child{width:82%;margin-bottom:0}
.bcvc-skeleton::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent);animation:bcvc-shimmer 1.4s infinite}
.bcvc-footer{display:grid;gap:8px;justify-items:stretch;min-width:0;padding:12px}
.bcvc-footer:empty{display:none}
.bcvc-footer-status{margin:0;color:var(--bcvc-text-weak);font-family:inherit;font-size:12px;font-weight:500;line-height:18px;text-align:center}
.bcvc-sr-only{position:absolute!important;width:1px!important;height:1px!important;margin:-1px!important;padding:0!important;overflow:hidden!important;clip:rect(0 0 0 0)!important;clip-path:inset(50%)!important;white-space:nowrap!important;border:0!important}
.bcvc-more-button{width:100%;min-height:40px}
.bcvc-sentinel{width:100%;height:1px}
@keyframes bcvc-shimmer{to{transform:translateX(100%)}}
html[dark] #${TABLIST_ID},
body[theme="dark"] #${TABLIST_ID},
.theme_dark #${TABLIST_ID}{
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#dfe2ea);
  --bcvc-text-base:var(--Content-Neutral-Cool-Base,#c9cedc);
  --bcvc-text-weak:var(--Content-Neutral-Cool-Weak,#8b909b);
  --bcvc-hover:var(--Surface-Interaction-Lighten-Hovered,rgba(255,255,255,.06));
}
html[dark] #betterchzzk-vod-comment-aside,
body[theme="dark"] #betterchzzk-vod-comment-aside,
.theme_dark #betterchzzk-vod-comment-aside{
  --bcvc-surface:var(--Background-Neutral-Base,var(--Surface-Neutral-Weakest,#141517));
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#dfe2ea);
  --bcvc-border:var(--Border-Neutral-Alpha-Weak,rgba(255,255,255,.06));
  color-scheme:dark;
}
html[dark] #${COMMENT_PANEL_ID},
body[theme="dark"] #${COMMENT_PANEL_ID},
.theme_dark #${COMMENT_PANEL_ID}{
  --bcvc-surface:var(--Background-Neutral-Base,var(--Surface-Neutral-Weakest,#141517));
  --bcvc-surface-raised:var(--Surface-Neutral-Weakest,#1b1c1f);
  --bcvc-surface-soft:var(--Surface-Neutral-Weaker,#2e3033);
  --bcvc-text:var(--Content-Neutral-Cool-Strong,#dfe2ea);
  --bcvc-text-base:var(--Content-Neutral-Cool-Base,#c9cedc);
  --bcvc-text-weak:var(--Content-Neutral-Cool-Weak,#8b909b);
  --bcvc-border:var(--Border-Neutral-Alpha-Weak,rgba(255,255,255,.06));
  --bcvc-hover:var(--Surface-Interaction-Lighten-Hovered,rgba(255,255,255,.06));
  color-scheme:dark;
}
@container (max-width:300px){
  .bcvc-toolbar{align-items:stretch}
  .bcvc-count{flex:1 1 calc(100% - 34px)}
  .bcvc-sort{order:2;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));flex:1 1 100%}
  .bcvc-sort-button{width:100%;padding-right:3px;padding-left:3px}
  .bcvc-icon-button{margin-left:auto}
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
            const appearanceHeading =
                mountedAppearanceHeading instanceof HTMLElement && mountedAppearanceHeading.isConnected
                    ? mountedAppearanceHeading
                    : mountedHeading;
            const headingStyle = appearanceHeading instanceof HTMLElement ? getComputedStyle(appearanceHeading) : null;
            const fallbackFontFamily = headingStyle?.fontFamily || "";
            const fontFamily = measurements.fontFamily || fallbackFontFamily;
            const toolbarFontFamily = measurements.toolbarFontFamily || fontFamily;
            if (fontFamily) commentPanel.style.setProperty("--bcvc-font-family", fontFamily);
            if (toolbarFontFamily) commentPanel.style.setProperty("--bcvc-toolbar-font-family", toolbarFontFamily);
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
        }

        function scheduleNativeHeaderSync() {
            if (layoutFrameId) return;
            layoutFrameId = requestAnimationFrame(() => {
                layoutFrameId = 0;
                syncNativeHeaderAppearance();
            });
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
                const seconds = model.parseTimecodeSeconds(label);
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
            avatar.title = "하단 원본 댓글이 표시되면 프로필을 볼 수 있습니다.";
            avatar.setAttribute("aria-describedby", NATIVE_ACTION_HINT_ID);

            const apiUrl = model.normalizeImageUrl(item?.row?.user?.profileImageUrl, location.href);
            if (apiUrl && !isNativeDefaultProfileUrl(apiUrl)) {
                avatar.setAttribute("data-bcvc-api-avatar-url", apiUrl);
                const image = document.createElement("img");
                image.className = "bcvc-avatar-image";
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

        function createAttachments(comment) {
            const attachments = model.normalizeAttachments(comment, { baseUrl: location.href, maxItems: 5 });
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
            buff.title = "하단 원본 댓글이 표시되면 버프할 수 있습니다.";
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

        function renderCommentMessage(record, expanded) {
            const { allowTimecodes, collapsedText, content, fullText, toggle } = record;
            content.replaceChildren();
            appendCommentText(content, expanded ? fullText : collapsedText, { allowTimecodes });
            toggle.setAttribute("aria-expanded", String(expanded));
            toggle.textContent = expanded ? "접기" : "더보기";
        }

        function createMessageToggle(message, fullText, allowTimecodes, commentId) {
            const collapsedText = model.getCollapsedCommentText(fullText);
            const content = document.createElement("span");
            content.className = "bcvc-message-content";
            message.appendChild(content);
            if (!collapsedText) {
                appendCommentText(content, fullText, { allowTimecodes });
                return null;
            }

            const toggle = document.createElement("button");
            toggle.type = "button";
            toggle.className = "bcvc-message-toggle";
            toggle.setAttribute("data-bcvc-action", "message-toggle");
            const record = { allowTimecodes, collapsedText, commentId, content, fullText, toggle };
            messageToggleStates.set(toggle, record);
            renderCommentMessage(record, false);
            return toggle;
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
                author.title = "하단 원본 댓글이 표시되면 프로필을 볼 수 있습니다.";
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
            if (item.best) {
                const best = document.createElement("span");
                best.className = "bcvc-best";
                best.textContent = "BEST";
                message.appendChild(best);
            }
            let messageText = deleted
                ? "삭제된 댓글입니다."
                : !hasComment
                  ? "내용을 표시할 수 없는 댓글입니다."
                  : cleanBotHidden
                    ? "클린봇이 부적절한 표현을 감지한 댓글입니다."
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
            const messageToggle = createMessageToggle(message, messageText, !deleted && !cleanBotHidden, commentId);
            row.appendChild(message);
            if (messageToggle) row.appendChild(messageToggle);
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
                        replyLimit.hidden = true;
                        replyLimit.textContent =
                            replyBudget?.remaining === 0 || visibleReplies.length < replies.length
                                ? `이 정렬에서는 답글을 ${MAX_REPLIES_PER_ORDER}개까지만 표시합니다.`
                                : `한 댓글의 답글은 ${MAX_REPLIES_PER_COMMENT}개까지만 표시합니다.`;
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
            nativeActionHint.textContent =
                "프로필과 버프는 같은 댓글이 하단 원본 댓글 영역에 표시되어 있을 때 사용할 수 있습니다.";
            view.appendChild(nativeActionHint);
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
            if (selectedTab !== "comments" || typeof IntersectionObserver !== "function" || !commentPanel) return;
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
            if (!commentPanel || selectedTab !== "comments") return;
            disconnectLoadMoreObserver();
            commentPanel.setAttribute("aria-busy", String(state.loading));
            commentPanel.replaceChildren(createCommentStateView(state));
            if (restoreScroll) commentPanel.scrollTop = state.scrollTop;
            connectLoadMoreObserver();
            onRendered();
        }

        function updateState(state) {
            if (!commentPanel || selectedTab !== "comments") return;
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
            if (!commentPanel || selectedTab !== "comments") return;
            const list = commentPanel.querySelector("[data-bcvc-list='1']");
            if (!(list instanceof HTMLElement) || !added.length) {
                renderState(state);
                return;
            }
            const fragment = document.createDocumentFragment();
            const renderedReplies = list.querySelectorAll("[data-bcvc-reply='1']").length;
            const replyBudget = { remaining: Math.max(0, MAX_REPLIES_PER_ORDER - renderedReplies) };
            added.forEach((item) => fragment.appendChild(createCommentRow(item, { replyBudget })));
            list.appendChild(fragment);
            const count = commentPanel.querySelector("[data-bcvc-count='1']");
            if (count)
                count.textContent = Number.isFinite(state.totalCount)
                    ? `댓글 ${state.totalCount.toLocaleString()}`
                    : "댓글";
            updateState(state);
            onRendered();
        }

        function toggleCommentMessage(control) {
            const record = messageToggleStates.get(control);
            if (!record) return;
            renderCommentMessage(record, control.getAttribute("aria-expanded") !== "true");
            if (record.commentId) onRowRendered(record.commentId);
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
            if (!request || selectedTab !== "comments" || !commentPanel?.isConnected) return;
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
                toggleCommentMessage(control);
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

        function onCommentPanelScroll() {
            onScroll(commentPanel?.scrollTop || 0);
        }

        function updateTabState({ focus = false } = {}) {
            const commentOnly = Boolean(commentTab) && !chatTab;
            const commentsSelected = commentOnly || selectedTab === "comments";
            if (commentOnly) selectedTab = "comments";
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
            if (!(chatLog instanceof HTMLElement)) return false;
            mountedChatLog = chatLog;
            originalChatAriaHidden = mountedChatLog.getAttribute("aria-hidden");
            mountedChatLog.setAttribute("data-bcvc-native-log", "1");
            if (!mountedChatLog.id) {
                mountedChatLog.id = CHAT_PANEL_ID;
                assignedChatLogId = true;
            }
            chatTab?.setAttribute("aria-controls", mountedChatLog.id);
            return true;
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
            if (mountedAppearanceHeading?.isConnected && mountedAppearanceHeading !== mountedHeading) {
                resizeObserver.observe(mountedAppearanceHeading);
            }
        }

        function setHeaderAppearanceSource(heading) {
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
            chatTab = hasChat
                ? createTabButton(
                      CHAT_TAB_ID,
                      model.compactText(mountedHeading.textContent) || "라이브 채팅 다시보기",
                      mountedChatLog.id
                  )
                : null;
            commentTab = createTabButton(COMMENT_TAB_ID, "댓글", COMMENT_PANEL_ID);
            if (chatTab) tablist.appendChild(chatTab);
            tablist.appendChild(commentTab);
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
            return true;
        }

        function reattach(anchors) {
            if (!canReattach()) return false;
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
            chatTab.textContent = model.compactText(mountedHeading.textContent) || "라이브 채팅 다시보기";
            mountedHeader.insertBefore(tablist, mountedHeading);
            mountedContainer.appendChild(commentPanel);

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
            mountedAppearanceHeading = null;
            tablist = null;
            chatTab = null;
            commentTab = null;
            commentPanel = null;
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
            return Boolean(tablist?.isConnected && commentPanel?.isConnected);
        }

        function isDisconnected() {
            return (
                hasMount() &&
                (!mountedAside?.isConnected ||
                    (Boolean(chatTab) && !mountedChatLog?.isConnected) ||
                    !tablist?.isConnected ||
                    !commentPanel?.isConnected)
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
            matchesShell,
            mount: mountTabs,
            ownedNodesConnected,
            reattach,
            renderState,
            replaceChatLog,
            restoreFocus: restoreCommentControlFocus,
            scheduleLayoutSync: scheduleNativeHeaderSync,
            setActiveOrder,
            setHeaderAppearanceSource,
            setSelectedTab,
            showState,
            updateState,
        });
    }

    namespace.view = Object.freeze({ createCommentView });
})();
