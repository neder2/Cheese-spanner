/**
 * features/chatTools.js — 실시간 채팅에 블라인드 원문 보기와 방송자/채팅 운영자 모아보기를 붙인다.
 *
 * 동작 위치: 치지직 방송 시청 페이지(라이브)의 실시간 채팅 리스트 DOM.
 * 하는 일: MutationObserver 로 채팅 행을 감지해 작성자/본문/역할/블라인드 여부를 파싱한다.
 *   블라인드 처리된 메시지는 숨겨진 원문을 찾아 취소선 텍스트로 보여주고,
 *   방송자·채팅 운영자 메시지는 별도 패널에 모아 보여주는 트리거 버튼과 박스를 채팅 헤더에 삽입한다.
 *   모아보기 대상으로 확정된 원본 채팅 행은 닉네임 색의 옅은 배경과 테두리로 강조한다.
 *   옵션 변경(bindFeatureOptions)과 라우트 변경(startPageChangeDetection) 시 런타임을 재시작한다.
 * 의존: BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, createThrottledDomSync, injectStyleOnce, isLiveRoute, normSpace,
 *   onReady, startPageChangeDetection), chrome.storage.local(레거시 캐시 정리용).
 * 옵션 키: chatWelcomeMessageRemovalEnabled, chatToolsShowBlindEnabled, chatToolsModeratorBoxEnabled,
 *   chatToolsMaxModeratorMessages.
 * DOM 마커: id=betterchzzk-chat-welcome-message-style, id=betterchzzk-chat-tools-style,
 *   data-bcct-blind-processed, data-bcct-blind-masked,
 *   data-bcct-moderator-collected, data-bcct-moderator-box, data-bcct-moderator-row,
 *   data-bcct-moderator-trigger, data-bcct-moderator-panel-host, data-bcct-moderator-actions,
 *   class bcct-blind-reveal / bcct-moderator-*.
 * 통신: root.chatTools(parseChatMessage, renderModeratorBox, syncBlindReveal)를
 *   window.BetterChzzk 에 공개해 다른 파일이 참조할 수 있게 한다.
 * 구조:
 *   상수와 STYLE_TEXT — DOM 마커, 선택자, 판별 정규식, 모아보기 UI CSS.
 *   전역 상태와 파싱 유틸 — 작성자/본문/역할/블라인드 판정, 행 소유 원문 캐시.
 *   모아보기 수집 — 행-메시지 바인딩, 재사용 후보 안정화, 뱃지/색상 백필.
 *   UI — 닉네임별 목록·미확인 알림·화면에 표시된 채팅 확인 처리와 모아보기 렌더링.
 *   DOM 수명주기 — mutation 기반 dirty row 추적, 행 정규화, observer 재연결.
 *   런타임 — install/uninstallRuntime, 옵션·라우트 반영, root.chatTools 공개.
 */
(() => {
    const WELCOME_MESSAGE_STYLE_ID = "betterchzzk-chat-welcome-message-style";
    const STYLE_ID = "betterchzzk-chat-tools-style";
    const BLIND_PROCESSED_ATTR = "data-bcct-blind-processed";
    // 블라인드 문구 가림 표시. 치지직(React)이 리스트를 재렌더하면서 className 을
    // 다시 설정하면 classList.add 로 붙인 클래스는 소실되지만, React 가 관리하지
    // 않는 data 속성은 유지되므로 클래스 대신 data 속성으로 가림 상태를 표시한다.
    const BLIND_MASKED_ATTR = "data-bcct-blind-masked";
    const MODERATOR_COLLECTED_ATTR = "data-bcct-moderator-collected";
    const MODERATOR_HIGHLIGHT_ATTR = "data-bcct-moderator-highlight";
    const MODERATOR_HIGHLIGHT_COLOR = "--bcct-moderator-highlight-color";
    const MODERATOR_BOX_ATTR = "data-bcct-moderator-box";
    const MODERATOR_ROW_ATTR = "data-bcct-moderator-row";
    const MODERATOR_TRIGGER_ATTR = "data-bcct-moderator-trigger";
    const MODERATOR_PANEL_HOST_ATTR = "data-bcct-moderator-panel-host";
    const MODERATOR_ACTION_GROUP_ATTR = "data-bcct-moderator-actions";
    const CHAT_TIMESTAMP_ATTR = "data-bcmt-time";
    const CHAT_TIMESTAMP_VALUE_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
    const PLACEHOLDER_TEXT = "[블라인드 메시지: 원문 없음]";
    const MODERATOR_TITLE = "방송자/채팅 운영자 채팅";
    const ROLE_SCORE_THRESHOLD = 80;
    const DEFAULT_MAX_MODERATOR_MESSAGES = 100;
    // 제거된 「방송 중 모아보기 유지」 옵션이 남긴 이전 캐시 데이터를 지우기 위한 키.
    const MODERATOR_CACHE_STORAGE_KEY = "betterChzzkChatToolsModeratorCache";
    const CHAT_SYNC_THROTTLE_MS = 120;
    const MODERATOR_REUSE_STABILITY_CHECK_MS = 100;
    const MODERATOR_REUSE_REQUIRED_STABLE_PASSES = 2;
    const CHAT_ROOT_FIND_THROTTLE_MS = 600;
    const MESSAGE_ID_ATTRS = ["data-chat-id", "data-message-id", "data-id"];
    const ROW_REUSE_SIGNAL_ATTRIBUTES = [
        "data-key",
        "data-index",
        "data-position",
        "data-virtual-key",
        "data-virtual-index",
        "data-virtual-position",
        "data-row-key",
        "data-row-index",
        "data-row-position",
        "data-item-key",
        "data-item-index",
        "data-item-position",
        "data-list-key",
        "data-list-index",
        "data-list-position",
        "aria-posinset",
    ];
    const ROW_REUSE_SIGNAL_ATTR_RE = /^(?:data-(?:(?:virtual|row|item|list)-)?(?:key|index|position)|aria-posinset)$/i;
    const CHAT_DIRTY_ATTRIBUTE_FILTER = [
        "class",
        "style",
        "hidden",
        "aria-label",
        "title",
        "aria-hidden",
        "alt",
        "aria-expanded",
        CHAT_TIMESTAMP_ATTR,
        ...MESSAGE_ID_ATTRS,
        ...ROW_REUSE_SIGNAL_ATTRIBUTES,
    ];
    const CHAT_ROOT_SELECTORS = [
        "[role='log']",
        "[role='list'][class*='chat']",
        "[class*='live_chatting']",
        "[class*='chatting'][class*='list']",
        "[class*='chat'][class*='list']",
        "[class*='chat_area']",
        "[class*='chatting_area']",
        "[class*='chat-room']",
        "[class*='chatroom']",
    ];
    const CHAT_ROW_SELECTORS = [
        "[data-chat-id]",
        "[data-message-id]",
        "[data-testid*='chat']",
        "[role='listitem']",
        "[class*='chat'][class*='row']",
        "[class*='chat'][class*='item']",
        "[class*='chat'][class*='message']",
        "[class*='message']",
        "[class*='comment']",
    ].join(",");
    // 가상 채팅 목록 wrapper 가 한 mutation 에 통째로 추가될 수 있다. 이때 wrapper 를
    // 한 메시지로 파싱하지 않도록 실제 행 후보만 제한된 범위에서 펼치고, 더 큰 트리는
    // 기존 전체 스캔 경로로 넘긴다.
    const MAX_MUTATION_SUBTREE_ELEMENTS = 512;
    const MESSAGE_TEXT_SELECTORS = [
        "[data-message-text]",
        "[data-chat-text]",
        "[data-content]",
        "[class*='message']",
        "[class*='content']",
        "[class*='text']",
        "[class*='comment']",
    ].join(",");
    const AUTHOR_SELECTORS = [
        "[data-author-name]",
        "[class*='nickname']",
        "[class*='nick']",
        "[class*='author']",
        "[class*='name']",
    ].join(",");
    const EXCLUDED_TEXT_SELECTOR = [
        "script",
        "style",
        "noscript",
        "svg",
        `[${MODERATOR_BOX_ATTR}]`,
        ".bcct-blind-reveal",
        // 치지직(네이버)의 sr-only 클래스. clip/absolute 로 화면에 보이지 않는
        // 뱃지 설명 텍스트("명예훈장" 등)라 닉네임/본문에 섞이면 안 된다.
        // display:none 이 아니어서 isElementHidden 으로는 걸러지지 않는다.
        // 우리 확장의 블라인드 기능(bcct-blind-*)과는 이름만 비슷할 뿐 무관하다.
        ".blind",
    ].join(",");
    const ROLE_ATTR_RE = /방장|방송자|스트리머|streamer|owner|broadcaster|매니저|운영자|manager|moderator|\bmod\b/i;
    const ROLE_LABEL_EXACT_RE =
        /^(?:방장|방송자|스트리머|매니저|운영자|채팅 운영자|streamer|owner|broadcaster|manager|moderator|mod)$/i;
    const BROADCASTER_RE = /방장|방송자|스트리머|streamer|owner|broadcaster/i;
    const MANAGER_RE = /매니저|운영자|manager|moderator|\bmod\b/i;
    const ROLE_CLASS_RE = /(^|[\s_-])(manager|moderator|mod|owner|streamer|broadcaster)([\s_-]|$)/i;
    const ROLE_SIGNAL_ELEMENT_RE = /badge|role|manager|moderator|owner|streamer|broadcaster/i;
    const BLIND_SIGNAL_RE =
        /블라인드|숨김|삭제|차단|가림|클린봇이\s*부적절한\s*표현을\s*감지|blind|hidden|deleted|blocked|moderated/i;
    const SERVICE_BLIND_NOTICE_RE =
        /^(?:클린봇이\s*부적절한\s*표현을\s*감지했습니다|(?:관리자|운영자)에\s*의해\s*(?:블라인드|숨김|삭제|차단|가림)(?:\s*처리)?된\s*(?:메시지|채팅)입니다)[\s.!?…]*$/i;
    const GENERIC_BLIND_TEXT_RE =
        /^(?:\[?\s*)?(?:(?:메시지가|채팅이)\s*)?(블라인드|숨김|삭제|차단|가림|blind|hidden|deleted|blocked|moderated)(?:\s*(메시지|채팅|message|chat|처리|처리된|됨|된|되었습니다|됩니다|입니다|글|내용|원문 없음|no text|unavailable))*[\]\s.:：-]*$/i;
    const CLIENT_TEXT_ATTR_RE = /message|content|text|body|comment|original/i;
    const HIDDEN_NON_MESSAGE_UI_RE =
        /profile|popover|tooltip|menu|toolbar|control|action|button|dialog|nickname|author|avatar|프로필|메뉴|도구|버튼/i;
    const HIDDEN_NON_MESSAGE_UI_SELECTOR =
        "button,a,input,textarea,select,option,[role='button'],[role='menu'],[role='menuitem'],[role='dialog'],[aria-haspopup]";
    const CHAT_TITLE_RE = /chat|\uCC44\uD305/i;
    const CHAT_INPUT_RE = /input|textarea|editor|composer|write|\uC785\uB825/i;
    const PINNED_NOTICE_RE = /pin|pinned|fixed|sticky|notice|announcement|announce|\uACE0\uC815|\uACF5\uC9C0/i;
    const ID_ATTRS = [...MESSAGE_ID_ATTRS, "id"];
    // 채팅을 다시 불러올 때 연달아 나타나는 환영 행과 클린 채팅 필터링 안내 행을
    // 같은 옵션으로 숨긴다. `_container_`와 `_filter_`를 함께 가진 실제 채팅 목록
    // item의 직계 자식만 잡아 채팅 헤더나 입력부의 필터 UI까지 숨기지 않는다.
    const WELCOME_MESSAGE_STYLE_TEXT = `
aside#aside-chatting [class*="_item_"]:has(> [class*="_welcome_"]),
aside[class*="live_chatting"] [class*="_item_"]:has(> [class*="_welcome_"]),
aside#aside-chatting [class*="_item_"]:has(> [class*="_container_"][class*="_filter_"]),
aside[class*="live_chatting"] [class*="_item_"]:has(> [class*="_container_"][class*="_filter_"]),
aside#aside-chatting [class*="_welcome_"],
aside[class*="live_chatting"] [class*="_welcome_"],
aside#aside-chatting [class*="_item_"] > [class*="_container_"][class*="_filter_"],
aside[class*="live_chatting"] [class*="_item_"] > [class*="_container_"][class*="_filter_"]{
  display:none!important;
}
`;
    const STYLE_TEXT = `
[${MODERATOR_HIGHLIGHT_ATTR}="1"]{
  --bcct-highlight-tint:color-mix(in srgb, var(${MODERATOR_HIGHLIGHT_COLOR}, currentColor) 85%, #000);
  background-color:color-mix(in srgb, var(--bcct-highlight-tint) 10%, transparent)!important;
  border-radius:4px;
  box-shadow:0 0 0 1px color-mix(in srgb, var(--bcct-highlight-tint) 32%, transparent);
}
/* 2026-09-05 치지직의 루트 theme_dark 클래스·data-theme 기준. 본문색과 행 크기는 유지한다. */
html:is(.theme_dark, [data-theme="theme_dark"]) [${MODERATOR_HIGHLIGHT_ATTR}="1"]{
  --bcct-highlight-tint:color-mix(in srgb, var(${MODERATOR_HIGHLIGHT_COLOR}, currentColor) 85%, #fff);
  background-color:color-mix(in srgb, var(--bcct-highlight-tint) 12%, transparent)!important;
  box-shadow:0 0 0 1px color-mix(in srgb, var(--bcct-highlight-tint) 40%, transparent);
}
[data-bcct-blind-masked="1"]{
  display:none!important;
}
.bcct-blind-reveal{
  color:inherit;
  font:inherit;
  opacity:.72;
  text-decoration:line-through;
  word-break:break-word;
}
.bcct-blind-reveal:hover{
  opacity:1;
  text-decoration:none;
}
.bcct-moderator-panel-host{
  position:relative!important;
}
.bcct-moderator-trigger{
  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 auto;
  width:30px;
  height:30px;
  margin:0 2px 0 0;
  padding:0;
  border:0;
  border-radius:8px;
  background:transparent;
  color:#69737f;
  cursor:pointer;
  font:inherit;
  transition:background-color .12s ease,color .12s ease;
}
.bcct-moderator-trigger:hover,
.bcct-moderator-trigger[aria-expanded="true"]{
  background:rgba(0,0,0,0.05);
  color:#00c471;
}
.bcct-moderator-trigger svg{
  width:19px;
  height:19px;
  display:block;
  pointer-events:none;
}
.bcct-moderator-trigger__count{
  position:absolute;
  top:0;
  right:0;
  display:flex;
  align-items:center;
  justify-content:center;
  min-width:13px;
  height:13px;
  padding:0 3px;
  border:2px solid #fff;
  border-radius:999px;
  background:#00c471;
  color:#fff;
  font-size:9px;
  font-weight:800;
  line-height:1;
  box-sizing:border-box;
}
.bcct-moderator-trigger__count[data-empty="1"]{
  display:none;
}
.bcct-moderator-trigger[data-unread="1"]{
  background:rgba(0,196,113,.14);
  color:#00a86b;
  box-shadow:inset 0 0 0 1px rgba(0,196,113,.4);
}
.bcct-moderator-actions{
  display:inline-flex!important;
  align-items:center!important;
  justify-content:center!important;
  gap:0!important;
  flex:0 0 auto!important;
  height:36px!important;
  align-self:center!important;
  margin-left:auto;
  line-height:0!important;
  transform:translateY(2px);
}
.bcct-moderator-actions > button{
  display:inline-flex!important;
  align-items:center!important;
  justify-content:center!important;
  align-self:center!important;
  margin-top:0!important;
  margin-bottom:0!important;
}
.bcct-moderator-box{
  display:flex;
  flex-direction:column;
  position:absolute;
  top:42px;
  right:8px;
  z-index:2147483646;
  width:min(344px, calc(100vw - 24px));
  max-height:min(420px, calc(100vh - 120px));
  border:1px solid rgba(0,0,0,0.1);
  border-radius:8px;
  background:#fff;
  color:#151619;
  box-shadow:0 10px 28px rgba(15,18,22,0.14);
  font-family:inherit;
  overflow:hidden;
}
.bcct-moderator-box[data-open="0"]{
  display:none;
}
.bcct-moderator-box__header{
  flex:none;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  border:0;
  padding:10px 12px;
  border-bottom:1px solid #eef1f4;
  background:#fff;
  font:inherit;
  font-size:14px;
  font-weight:700;
}
.bcct-moderator-box__heading{
  display:flex;
  align-items:center;
  gap:5px;
  min-width:0;
}
.bcct-moderator-box__title{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.bcct-moderator-box__count{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:18px;
  height:18px;
  padding:0 6px;
  border-radius:999px;
  background:#e9fff5;
  color:#00a86b;
  font-size:12px;
  font-weight:800;
  line-height:1;
  box-sizing:border-box;
}
.bcct-moderator-box__close{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:28px;
  height:28px;
  flex:0 0 auto;
  border:0;
  border-radius:8px;
  background:transparent;
  color:#8a94a1;
  cursor:pointer;
  font-size:16px;
  font-weight:600;
  line-height:1;
  padding:0;
  transition:background-color .12s ease,color .12s ease;
}
.bcct-moderator-box__close:hover{
  background:#f1f3f5;
  color:#151619;
}
.bcct-moderator-box__list{
  display:flex;
  flex-direction:column;
  max-height:276px;
  overflow:auto;
  overscroll-behavior:contain;
  min-height:0;
}
.bcct-moderator-authors{
  display:flex;
  flex:none;
  flex-wrap:wrap;
  gap:6px;
  max-height:84px;
  overflow:auto;
  padding:8px 12px;
  border-bottom:1px solid rgba(128,128,128,.2);
}
.bcct-moderator-author,
.bcct-moderator-bottom{
  border:1px solid rgba(128,128,128,.35);
  border-radius:6px;
  background:transparent;
  color:inherit;
  font:inherit;
  font-size:12px;
  cursor:pointer;
  padding:4px 7px;
}
.bcct-moderator-author{
  display:inline-flex;
  align-items:center;
  gap:5px;
  max-width:100%;
}
.bcct-moderator-bottom{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:none;
  width:28px;
  height:28px;
  padding:0;
}
.bcct-moderator-bottom svg{
  width:16px;
  height:16px;
  pointer-events:none;
}
.bcct-moderator-author__name{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.bcct-moderator-author[aria-pressed="true"]{
  background:rgba(0,196,113,.16);
  border-color:#00a86b;
}
.bcct-moderator-author__unread{
  flex:none;
  padding:0 4px;
  border-radius:4px;
  background:rgba(0,196,113,.18);
  font-weight:700;
}
.bcct-moderator-summary{
  display:flex;
  flex:none;
  align-items:center;
  justify-content:space-between;
  gap:6px;
  padding:6px 12px;
  font-size:12px;
  min-height:28px;
}
.bcct-moderator-bottom[hidden],
.bcct-moderator-row[hidden],
.bcct-moderator-author__unread[hidden]{
  display:none!important;
}
.bcct-moderator-row{
  display:block;
  width:100%;
  border:0;
  border-bottom:1px solid #f1f3f5;
  background:transparent;
  color:inherit;
  cursor:text;
  flex:none;
  box-sizing:border-box;
  -webkit-user-select:text;
  user-select:text;
  font:inherit;
  padding:7px 12px;
  text-align:left;
  transition:background-color .12s ease;
}
.bcct-moderator-row:hover{
  background:#f4fbf8;
}
.bcct-moderator-row[data-unread="1"]{
  box-shadow:inset 3px 0 #00a86b;
}
.bcct-moderator-row:focus-visible,
.bcct-moderator-author:focus-visible,
.bcct-moderator-bottom:focus-visible{
  outline:2px solid #00a86b;
  outline-offset:-2px;
}
.bcct-moderator-row:last-child{
  border-bottom:0;
}
.bcct-moderator-row__meta{
  display:inline;
  margin-right:6px;
  color:#00a86b;
  font-size:12px;
  font-weight:700;
  line-height:18px;
}
.bcct-moderator-row__time{
  display:inline;
  margin-right:4px;
  color:var(--Content-Neutral-Cool-Base,#9da5b6);
  font-size:12px;
  font-weight:400;
  font-variant-numeric:tabular-nums;
  line-height:18px;
  white-space:nowrap;
}
.bcct-moderator-row__badge{
  display:inline-block;
  width:18px;
  height:18px;
  margin-right:4px;
  vertical-align:-4px;
}
.bcct-moderator-row__text{
  display:inline;
  color:#25282d;
  font-size:13px;
  line-height:18px;
  white-space:normal;
  word-break:break-word;
}
.bcct-moderator-box__empty{
  padding:18px 12px;
  color:#8a94a1;
  font-size:12px;
  line-height:18px;
  text-align:center;
}
@media (max-width:420px){
  .bcct-moderator-box{
    right:4px;
    width:calc(100vw - 16px);
  }
}
html[dark] .bcct-moderator-box,
body[theme="dark"] .bcct-moderator-box,
[class*="dark"] .bcct-moderator-box{
  border-color:rgba(255,255,255,0.14);
  background:#1f2125;
  color:#f1f3f5;
}
html[dark] .bcct-moderator-trigger,
body[theme="dark"] .bcct-moderator-trigger,
[class*="dark"] .bcct-moderator-trigger{
  color:#c9cdd3;
}
html[dark] .bcct-moderator-trigger:hover,
html[dark] .bcct-moderator-trigger[aria-expanded="true"],
body[theme="dark"] .bcct-moderator-trigger:hover,
body[theme="dark"] .bcct-moderator-trigger[aria-expanded="true"],
[class*="dark"] .bcct-moderator-trigger:hover,
[class*="dark"] .bcct-moderator-trigger[aria-expanded="true"]{
  background:rgba(255,255,255,0.1);
  color:#00c471;
}
html[dark] .bcct-moderator-trigger__count,
body[theme="dark"] .bcct-moderator-trigger__count,
[class*="dark"] .bcct-moderator-trigger__count{
  border-color:#1f2125;
}
html[dark] .bcct-moderator-box__header,
body[theme="dark"] .bcct-moderator-box__header,
[class*="dark"] .bcct-moderator-box__header{
  border-bottom-color:rgba(255,255,255,0.1);
  background:#1f2125;
}
html[dark] .bcct-moderator-box__count,
body[theme="dark"] .bcct-moderator-box__count,
[class*="dark"] .bcct-moderator-box__count{
  background:rgba(0,196,113,0.15);
  color:#00c471;
}
html[dark] .bcct-moderator-box__close,
body[theme="dark"] .bcct-moderator-box__close,
[class*="dark"] .bcct-moderator-box__close{
  color:#c9cdd3;
}
html[dark] .bcct-moderator-box__close:hover,
body[theme="dark"] .bcct-moderator-box__close:hover,
[class*="dark"] .bcct-moderator-box__close:hover{
  background:rgba(255,255,255,0.09);
  color:#f1f3f5;
}
html[dark] .bcct-moderator-row,
body[theme="dark"] .bcct-moderator-row,
[class*="dark"] .bcct-moderator-row{
  border-bottom-color:rgba(255,255,255,0.08);
}
html[dark] .bcct-moderator-row:hover,
body[theme="dark"] .bcct-moderator-row:hover,
[class*="dark"] .bcct-moderator-row:hover{
  background:rgba(0,196,113,0.12);
}
html[dark] .bcct-moderator-row__text,
body[theme="dark"] .bcct-moderator-row__text,
[class*="dark"] .bcct-moderator-row__text{
  color:#f1f3f5;
}
html[dark] .bcct-moderator-box__empty,
body[theme="dark"] .bcct-moderator-box__empty,
[class*="dark"] .bcct-moderator-box__empty{
  color:#9aa3ad;
}
`;

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        injectStyleOnce,
        isLiveRoute,
        normSpace,
        onReady,
        startPageChangeDetection,
    } = root.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let chatRoot = null;
    let observer = null;
    let removePageChangeDetection = null;
    let moderatorBox = null;
    let moderatorList = null;
    let moderatorCount = null;
    let moderatorToggle = null;
    let moderatorTriggerCount = null;
    let moderatorAuthors = null;
    let moderatorSummary = null;
    let moderatorBottomButton = null;
    let moderatorAuthorFilter = "";
    let moderatorReadFrame = null;
    let moderatorResizeObserver = null;
    let moderatorActivityRenderKey = "";
    const moderatorRenderedRows = new Map();
    let moderatorPanelHost = null;
    let moderatorHeader = null;
    let moderatorMenuButton = null;
    let moderatorMenuButtonConfirmed = false;
    let moderatorAnchorObserver = null;
    let moderatorAnchorRoot = null;
    let moderatorAnchorDirty = false;
    let moderatorPanelOpen = false;
    let moderatorMessages = [];
    let collectedMessageIds = new Set();
    let moderatorRowBindings = new WeakMap();
    let pendingModeratorRemounts = [];
    const moderatorRowTransitions = new Map();
    const moderatorTransitionOwnerships = new Map();
    let rowMutationRevisions = new WeakMap();
    let legacyModeratorCachePurged = false;
    const dirtyChatRows = new Set();
    let parsedChatRows = new WeakSet();
    let forceFullChatScan = true;
    let forceReparseChatRows = true;
    let chatMutationBatchShouldSchedule = false;
    let lastChatRootFindAt = 0;
    let lastChatRootFindResult = null;
    const rowIds = new WeakMap();
    const rowOriginalTexts = new WeakMap();
    let nextRowId = 1;
    let nextModeratorTransitionId = 1;

    const scheduleSync = createThrottledDomSync(syncChatTools, CHAT_SYNC_THROTTLE_MS);

    function isFeatureEnabled() {
        return Boolean(featureOptions.chatToolsShowBlindEnabled || featureOptions.chatToolsModeratorBoxEnabled);
    }

    function syncWelcomeMessageRemoval() {
        if (featureOptions.chatWelcomeMessageRemovalEnabled) {
            injectStyleOnce(WELCOME_MESSAGE_STYLE_ID, WELCOME_MESSAGE_STYLE_TEXT);
            return;
        }
        document.getElementById(WELCOME_MESSAGE_STYLE_ID)?.remove();
    }

    function isBlindRevealEnabled() {
        return Boolean(featureOptions.chatToolsShowBlindEnabled);
    }

    function isModeratorBoxEnabled() {
        return Boolean(featureOptions.chatToolsModeratorBoxEnabled);
    }

    function isChatTimestampEnabled() {
        return featureOptions.chatTimestampEnabled === true;
    }

    function getMaxModeratorMessages() {
        const value = Number(featureOptions.chatToolsMaxModeratorMessages);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_MODERATOR_MESSAGES;
    }

    function isOwnUi(node) {
        const el = node instanceof Element ? node : node?.parentElement;
        return Boolean(
            el?.closest(
                `[${MODERATOR_BOX_ATTR}], [${MODERATOR_TRIGGER_ATTR}], [${MODERATOR_ACTION_GROUP_ATTR}], .bcct-blind-reveal`
            )
        );
    }

    function getAttr(el, name) {
        return el instanceof Element ? el.getAttribute(name) || "" : "";
    }

    function getClassText(el) {
        return getAttr(el, "class");
    }

    function getElementAttrText(el) {
        if (!(el instanceof Element)) return "";
        return [
            getAttr(el, "class"),
            getAttr(el, "id"),
            getAttr(el, "role"),
            getAttr(el, "aria-label"),
            getAttr(el, "title"),
            getAttr(el, "data-role"),
            getAttr(el, "data-badge"),
            getAttr(el, "data-author-type"),
            getAttr(el, "data-user-role"),
            getAttr(el, "data-message-type"),
            getAttr(el, "alt"),
        ].join(" ");
    }

    function isExplicitHiddenOriginalElement(el) {
        if (!(el instanceof Element)) return false;
        const marker = [getClassText(el), getAttr(el, "id"), getAttr(el, "data-testid")].join(" ");
        if (
            /(?:message|chat|comment|content|text)[\s_-]*(?:original|hidden)|(?:original|hidden)[\s_-]*(?:message|chat|comment|content|text)/i.test(
                marker
            )
        ) {
            return true;
        }
        return Array.from(el.attributes).some((attr) => /original/i.test(attr.name));
    }

    function isHiddenNonMessageUi(el, row) {
        if (!(el instanceof Element)) return false;
        const explicitOriginal = isExplicitHiddenOriginalElement(el);
        const interactive = el.closest(HIDDEN_NON_MESSAGE_UI_SELECTOR);
        if (interactive && interactive !== row && row.contains(interactive)) return true;

        for (let current = el; current instanceof Element && current !== row; current = current.parentElement) {
            if (
                HIDDEN_NON_MESSAGE_UI_RE.test(getElementAttrText(current)) ||
                (!explicitOriginal && isElementHidden(current) && current.querySelector(HIDDEN_NON_MESSAGE_UI_SELECTOR))
            ) {
                return true;
            }
        }
        return false;
    }

    function createRowParseContext(row) {
        const elements = row instanceof Element ? [row, ...Array.from(row.querySelectorAll("*")).slice(0, 160)] : [];
        return {
            row,
            elements,
            hiddenCache: new WeakMap(),
            visibleTextCache: new WeakMap(),
            rawTextCache: new WeakMap(),
            treeAttrText: "",
            attributeTextCandidates: null,
            hiddenElements: null,
            authorElements: null,
            firstMessageEl: undefined,
            roleSignalElements: null,
            rowSignalsScanned: false,
        };
    }

    function scanRowSignals(row, context) {
        if (context?.row !== row || context.rowSignalsScanned) return;

        const attrCandidates = [];
        const hiddenElements = [];
        const authorElements = [];
        const roleCandidates = [];
        const attrChunks = [];
        let firstMessageEl = null;

        for (const el of context.elements) {
            if (!(el instanceof Element)) continue;
            if (isOwnUi(el)) continue;

            attrChunks.push(getElementAttrText(el));

            const roleDecoration = isRoleDecoration(el, context);
            const hidden = el !== row && !roleDecoration && isHiddenWithin(el, row, context);
            const hiddenNonMessageUi = hidden && isHiddenNonMessageUi(el, row);

            if (!roleDecoration && !hiddenNonMessageUi) {
                for (const attr of Array.from(el.attributes)) {
                    const name = attr.name.toLowerCase();
                    if (!CLIENT_TEXT_ATTR_RE.test(name) && name !== "aria-label" && name !== "title") continue;
                    if ((name === "aria-label" || name === "title") && !hidden && !BLIND_SIGNAL_RE.test(attr.value)) {
                        continue;
                    }
                    parseClientTextValue(attr.value, attrCandidates);
                }
            }

            if (hidden && !roleDecoration && !hiddenNonMessageUi) hiddenElements.push(el);
            if (el !== row && el.matches(AUTHOR_SELECTORS) && !hidden && !roleDecoration) authorElements.push(el);
            if (!firstMessageEl && isMessageTextElement(el, row)) firstMessageEl = el;
            roleCandidates.push(el);
        }

        context.treeAttrText = attrChunks.join(" ");
        context.attributeTextCandidates = attrCandidates;
        context.hiddenElements = hiddenElements;
        context.authorElements = authorElements;
        context.firstMessageEl = firstMessageEl;
        context.roleSignalElements = roleCandidates.filter((el) =>
            isRoleSignalElement(el, row, authorElements, firstMessageEl, context)
        );
        context.rowSignalsScanned = true;
    }

    function getContextElements(context, rootEl, limit = 160) {
        if (context?.row === rootEl && Array.isArray(context.elements)) {
            return context.elements.slice(0, limit + 1);
        }
        if (!(rootEl instanceof Element)) return [];
        return [rootEl, ...Array.from(rootEl.querySelectorAll("*")).slice(0, limit)];
    }

    function getTreeAttrText(rootEl, limit = 120, context = null) {
        if (!(rootEl instanceof Element)) return "";
        if (context?.row === rootEl) {
            scanRowSignals(rootEl, context);
            return context.treeAttrText;
        }

        const chunks = [];
        for (const el of getContextElements(context, rootEl, limit)) {
            if (isOwnUi(el)) continue;
            chunks.push(getElementAttrText(el));
        }

        const text = chunks.join(" ");
        if (context?.row === rootEl) context.treeAttrText = text;
        return text;
    }

    function isElementHidden(el, context = null) {
        if (!(el instanceof HTMLElement)) return false;
        if (context?.hiddenCache?.has(el)) return context.hiddenCache.get(el);
        // 우리가 가린 블라인드 문구는 파싱 관점에서는 계속 보이는 것으로 취급해야
        // 재파싱 때 블라인드 판정과 본문 선택이 흔들리지 않는다.
        if (el.hasAttribute(BLIND_MASKED_ATTR)) {
            context?.hiddenCache?.set(el, false);
            return false;
        }
        if (el.hidden || el.getAttribute("aria-hidden") === "true") {
            context?.hiddenCache?.set(el, true);
            return true;
        }
        const style = getComputedStyle(el);
        const opacity = style.opacity;
        const hidden =
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            (opacity !== "" && Number(opacity) === 0);
        context?.hiddenCache?.set(el, hidden);
        return hidden;
    }

    function isHiddenWithin(el, boundary, context = null) {
        let current = el;
        while (current && current instanceof Element && current !== boundary.parentElement) {
            if (isElementHidden(current, context)) return true;
            if (current === boundary) break;
            current = current.parentElement;
        }
        return false;
    }

    function collectText(node, out, { includeHidden = false, boundary = null, context = null } = {}) {
        if (node.nodeType === Node.TEXT_NODE) {
            out.push(node.nodeValue || "");
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = /** @type {Element} */ (node);
        if (isOwnUi(el) || el.matches(EXCLUDED_TEXT_SELECTOR)) return;
        if (!includeHidden && boundary && isHiddenWithin(el, boundary, context)) return;

        for (const child of el.childNodes) collectText(child, out, { includeHidden, boundary, context });
    }

    function getVisibleText(el, context = null) {
        if (!(el instanceof Element)) return "";
        if (context?.visibleTextCache?.has(el)) return context.visibleTextCache.get(el);
        const chunks = [];
        collectText(el, chunks, { boundary: el, context });
        const text = normSpace(chunks.join(" "));
        context?.visibleTextCache?.set(el, text);
        return text;
    }

    function getRawText(el, context = null) {
        if (!(el instanceof Element)) return "";
        if (context?.rawTextCache?.has(el)) return context.rawTextCache.get(el);
        const chunks = [];
        collectText(el, chunks, { includeHidden: true, boundary: el, context });
        const text = normSpace(chunks.join(" "));
        context?.rawTextCache?.set(el, text);
        return text;
    }

    function isRoleDecoration(el, context = null) {
        if (!(el instanceof Element)) return false;
        const marker = getElementAttrText(el);
        if (!/badge|role|manager|moderator|owner|streamer|broadcaster|닉네임|nickname|author|name/i.test(marker))
            return false;
        if (ROLE_ATTR_RE.test(marker)) return true;
        return ROLE_LABEL_EXACT_RE.test(getVisibleText(el, context));
    }

    function pickMessageTextTarget(row, context = null) {
        const candidates = getContextElements(context, row).filter((el) => {
            if (el === row || !(el instanceof Element) || !el.matches(MESSAGE_TEXT_SELECTORS)) return false;
            if (isOwnUi(el) || isRoleDecoration(el, context)) return false;
            if (isAuthorCandidateElement(el) || hasAuthorAncestor(el, row)) return false;
            if (el.querySelector(AUTHOR_SELECTORS)) return false;
            return !isHiddenWithin(el, row, context);
        });
        let bestEl = null;
        let bestText = "";

        for (const el of candidates) {
            const text = getVisibleText(el, context);
            if (text.length > bestText.length) {
                bestEl = el;
                bestText = text;
            }
        }

        return { el: bestEl, text: bestText };
    }

    function pickAuthorTarget(row, context = null) {
        const attrAuthor = normSpace(getAttr(row, "data-author-name"));
        if (attrAuthor) return { el: null, text: attrAuthor };

        const candidates = getContextElements(context, row).filter(
            (el) => el !== row && el.matches?.(AUTHOR_SELECTORS)
        );
        for (const el of candidates) {
            if (isOwnUi(el) || isRoleDecoration(el, context) || isHiddenWithin(el, row, context)) continue;
            const dataAuthor = normSpace(getAttr(el, "data-author-name"));
            if (dataAuthor) return { el, text: dataAuthor };
            const text = getVisibleText(el, context);
            if (text) return { el, text };
        }

        return { el: null, text: "" };
    }

    function getAuthorBadges(authorEl) {
        if (!(authorEl instanceof Element)) return [];
        const badges = [];
        for (const img of Array.from(authorEl.querySelectorAll("img")).slice(0, 8)) {
            const src = getAttr(img, "src");
            if (!/^https:\/\//.test(src)) continue;
            badges.push({ src: src.slice(0, 500), alt: normSpace(getAttr(img, "alt")).slice(0, 80) });
        }
        return badges;
    }

    function getAuthorColor(authorEl) {
        if (!(authorEl instanceof Element)) return "";
        const candidates = [authorEl, ...Array.from(authorEl.querySelectorAll("[style]")).slice(0, 20)];
        for (const el of candidates) {
            const inlineColor = normSpace(el.style?.color || "");
            if (!inlineColor) continue;
            // 치지직이 color: var(--...) 형태를 쓰면 모아보기 박스 컨텍스트에서
            // 변수가 해석되지 않으므로, rgb 로 해석된 computed 값을 우선 저장한다.
            // 인라인 color 가 없는 요소는 계속 건너뛴다 (기본 텍스트색을 잘못
            // 저장하면 다크모드 채팅색이 라이트 박스에서 안 보일 수 있음).
            try {
                const computedColor = normSpace(getComputedStyle(el).color || "");
                if (computedColor) return computedColor.slice(0, 60);
            } catch (_) {
                // computed style 조회가 실패하면 인라인 원문으로 폴백한다.
            }
            return inlineColor.slice(0, 60);
        }
        return "";
    }

    function getChatTimestamp(row, textEl) {
        if (!(row instanceof Element)) return "";

        let timestampTarget = null;
        if (textEl instanceof Element) {
            const closestTarget = textEl.closest(`[${CHAT_TIMESTAMP_ATTR}]`);
            if (closestTarget && row.contains(closestTarget)) timestampTarget = closestTarget;
        }
        if (!timestampTarget) {
            timestampTarget = row.hasAttribute(CHAT_TIMESTAMP_ATTR)
                ? row
                : row.querySelector(`[${CHAT_TIMESTAMP_ATTR}]`);
        }

        const timestamp = normSpace(timestampTarget?.getAttribute(CHAT_TIMESTAMP_ATTR));
        return CHAT_TIMESTAMP_VALUE_RE.test(timestamp) ? timestamp : "";
    }

    function parseClientTextValue(value, out, depth = 0) {
        const text = normSpace(value);
        if (!text || text.length > 2000) return;

        if (depth < 2 && /^[{[]/.test(text)) {
            try {
                const parsed = JSON.parse(text);
                collectClientTextFromValue(parsed, out, depth + 1);
                return;
            } catch (_) {
                // Non-JSON strings are still valid client-side text candidates.
            }
        }

        out.push(text);
    }

    function collectClientTextFromValue(value, out, depth = 0) {
        if (typeof value === "string") {
            parseClientTextValue(value, out, depth);
            return;
        }
        if (!value || typeof value !== "object" || depth > 2) return;

        if (Array.isArray(value)) {
            for (const item of value.slice(0, 20)) collectClientTextFromValue(item, out, depth + 1);
            return;
        }

        for (const [key, item] of Object.entries(value)) {
            if (!CLIENT_TEXT_ATTR_RE.test(key)) continue;
            collectClientTextFromValue(item, out, depth + 1);
        }
    }

    function collectAttributeTextCandidates(row, out, context = null) {
        if (context?.row === row) {
            scanRowSignals(row, context);
            out.push(...context.attributeTextCandidates);
            return;
        }

        const candidates = [];
        for (const el of getContextElements(context, row, 160)) {
            if (
                !(el instanceof Element) ||
                isOwnUi(el) ||
                isRoleDecoration(el, context) ||
                isHiddenNonMessageUi(el, row)
            ) {
                continue;
            }
            for (const attr of Array.from(el.attributes)) {
                const name = attr.name.toLowerCase();
                if (!CLIENT_TEXT_ATTR_RE.test(name) && name !== "aria-label" && name !== "title") continue;
                if (
                    (name === "aria-label" || name === "title") &&
                    !isHiddenWithin(el, row, context) &&
                    !BLIND_SIGNAL_RE.test(attr.value)
                ) {
                    continue;
                }
                parseClientTextValue(attr.value, candidates);
            }
        }
        if (context?.row === row) context.attributeTextCandidates = candidates;
        out.push(...candidates);
    }

    function isBlindNoticeText(text) {
        const normalized = normSpace(text);
        if (!normalized) return false;
        return (
            SERVICE_BLIND_NOTICE_RE.test(normalized) ||
            GENERIC_BLIND_TEXT_RE.test(normalized) ||
            normalized === PLACEHOLDER_TEXT
        );
    }

    function isRoleOnlyText(text) {
        const normalized = normSpace(text);
        return Boolean(normalized && ROLE_ATTR_RE.test(normalized) && normalized.length <= 12);
    }

    function isAuthorCandidateElement(el) {
        return (
            el instanceof Element &&
            (Boolean(normSpace(getAttr(el, "data-author-name"))) || el.matches(AUTHOR_SELECTORS))
        );
    }

    function getRoleDataText(el) {
        if (!(el instanceof Element)) return "";
        return [
            getAttr(el, "data-role"),
            getAttr(el, "data-badge"),
            getAttr(el, "data-author-type"),
            getAttr(el, "data-user-role"),
            getAttr(el, "alt"),
        ].join(" ");
    }

    function getRoleLabelText(el) {
        if (!(el instanceof Element)) return "";
        return [getAttr(el, "aria-label"), getAttr(el, "title")].join(" ");
    }

    function getRoleSignalAttrText(el) {
        if (!(el instanceof Element)) return "";
        return [getClassText(el), getAttr(el, "id"), getAttr(el, "data-testid")].join(" ");
    }

    function hasAuthorAncestor(el, row) {
        let current = el instanceof Element ? el.parentElement : null;
        while (current instanceof Element && current !== row) {
            if (isAuthorCandidateElement(current)) return true;
            current = current.parentElement;
        }
        return false;
    }

    function isMessageTextElement(el, row) {
        if (!(el instanceof Element) || el === row || isAuthorCandidateElement(el)) return false;
        if (hasAuthorAncestor(el, row) || el.querySelector(AUTHOR_SELECTORS)) return false;
        if (ROLE_ATTR_RE.test(getRoleDataText(el))) return false;
        return el.matches(MESSAGE_TEXT_SELECTORS);
    }

    function getAuthorCandidateElements(row, context = null) {
        if (context?.row === row) {
            scanRowSignals(row, context);
            return context.authorElements;
        }
        const elements = getContextElements(context, row).filter(
            (el) =>
                el !== row &&
                el instanceof Element &&
                el.matches(AUTHOR_SELECTORS) &&
                !isOwnUi(el) &&
                !isHiddenWithin(el, row, context)
        );
        if (context?.row === row) context.authorElements = elements;
        return elements;
    }

    function getFirstMessageTextElement(row, context = null) {
        if (context?.row === row) {
            scanRowSignals(row, context);
            return context.firstMessageEl;
        }
        const first = getContextElements(context, row).find((el) => isMessageTextElement(el, row)) || null;
        if (context?.row === row) context.firstMessageEl = first;
        return first;
    }

    function isInsideMessageTextElement(el, row) {
        const messageEl = el instanceof Element ? el.closest(MESSAGE_TEXT_SELECTORS) : null;
        return Boolean(messageEl && isMessageTextElement(messageEl, row));
    }

    function isBeforeElement(el, target) {
        return Boolean(
            el instanceof Element &&
            target instanceof Element &&
            el !== target &&
            el.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING
        );
    }

    function isAuthorRoleAreaElement(el, authorElements, firstMessageEl) {
        if (!(el instanceof Element) || isOwnUi(el)) return false;
        if (authorElements.some((authorEl) => el === authorEl || el.contains(authorEl) || authorEl.contains(el))) {
            return true;
        }
        return Boolean(firstMessageEl && isBeforeElement(el, firstMessageEl));
    }

    function isRoleSignalElement(el, row, authorElements, firstMessageEl, context = null) {
        if (!(el instanceof Element) || isOwnUi(el)) return false;
        if (isInsideMessageTextElement(el, row)) return false;
        if (el !== row && !isAuthorRoleAreaElement(el, authorElements, firstMessageEl)) return false;

        const roleDataText = getRoleDataText(el);
        if (ROLE_ATTR_RE.test(roleDataText)) return true;
        if (ROLE_CLASS_RE.test(getClassText(el))) return true;

        const roleSignalAttrText = getRoleSignalAttrText(el);
        if (!ROLE_SIGNAL_ELEMENT_RE.test(roleSignalAttrText)) return false;
        if (ROLE_ATTR_RE.test(getRoleLabelText(el))) return true;
        return isRoleOnlyText(getVisibleText(el, context));
    }

    function pickHiddenOriginalText(row, visibleText, author, context = null) {
        const candidates = [];
        collectAttributeTextCandidates(row, candidates, context);

        let hiddenElements = context?.row === row ? context.hiddenElements : null;
        if (!hiddenElements) {
            hiddenElements = getContextElements(context, row).filter((el) => {
                if (el === row || !(el instanceof Element) || isOwnUi(el) || isRoleDecoration(el, context))
                    return false;
                return isHiddenWithin(el, row, context);
            });
            if (context?.row === row) context.hiddenElements = hiddenElements;
        }

        for (const el of hiddenElements) {
            const text = getRawText(el, context);
            if (text) candidates.push(text);
        }

        const seen = new Set();
        let best = "";
        for (const candidate of candidates) {
            const text = normSpace(candidate);
            if (!text || seen.has(text)) continue;
            seen.add(text);
            if (isBlindNoticeText(text) || isRoleOnlyText(text)) continue;
            if (author && text === author) continue;
            if (visibleText && text === visibleText) continue;
            if (text.length > best.length) best = text;
        }

        return best;
    }

    function hasBlindSignal(row, messageText, hiddenText, context = null) {
        if (isBlindNoticeText(messageText)) return true;
        const attrText = getTreeAttrText(row, 120, context);
        return Boolean(hiddenText && BLIND_SIGNAL_RE.test(attrText));
    }

    function getRoleSignalElements(row, context = null) {
        if (context?.row === row) {
            scanRowSignals(row, context);
            return context.roleSignalElements;
        }
        const authorElements = getAuthorCandidateElements(row, context);
        const firstMessageEl = getFirstMessageTextElement(row, context);
        const elements = getContextElements(context, row, 120);
        const roleElements = elements.filter((el) =>
            isRoleSignalElement(el, row, authorElements, firstMessageEl, context)
        );
        if (context?.row === row) context.roleSignalElements = roleElements;
        return roleElements;
    }

    function getRoleBadgeSrc(row, context = null) {
        for (const el of getRoleSignalElements(row, context)) {
            if (el.tagName !== "IMG" || !ROLE_ATTR_RE.test(getAttr(el, "alt"))) continue;
            const src = getAttr(el, "src");
            if (/^https:\/\//.test(src)) return src.slice(0, 500);
        }
        return "";
    }

    function detectRole(row, context = null) {
        let managerScore = 0;
        let broadcasterScore = 0;

        for (const el of getRoleSignalElements(row, context)) {
            const roleDataText = getRoleDataText(el);
            const roleSignalAttrText = getRoleSignalAttrText(el);
            const canUseLabelText = ROLE_SIGNAL_ELEMENT_RE.test(roleSignalAttrText);
            const labelText = canUseLabelText ? getRoleLabelText(el) : "";
            const classText = getClassText(el);
            const visibleText = getVisibleText(el, context);
            const hasVisibleRoleSignal = canUseLabelText && isRoleOnlyText(visibleText);

            if (BROADCASTER_RE.test(roleDataText)) broadcasterScore += 100;
            if (MANAGER_RE.test(roleDataText)) managerScore += 80;
            if (BROADCASTER_RE.test(labelText)) broadcasterScore += 100;
            if (MANAGER_RE.test(labelText)) managerScore += 80;
            if (ROLE_CLASS_RE.test(classText)) {
                if (BROADCASTER_RE.test(classText)) broadcasterScore += 50;
                if (MANAGER_RE.test(classText)) managerScore += 50;
            }
            if (hasVisibleRoleSignal && BROADCASTER_RE.test(visibleText)) broadcasterScore += 80;
            if (hasVisibleRoleSignal && MANAGER_RE.test(visibleText)) managerScore += 80;
        }

        if (broadcasterScore >= ROLE_SCORE_THRESHOLD && broadcasterScore >= managerScore) return "broadcaster";
        if (managerScore >= ROLE_SCORE_THRESHOLD) return "manager";
        return "";
    }

    function getMessageFingerprint(parsed) {
        return `${parsed.role}:${parsed.author}:${parsed.text}`;
    }

    function getMessageId(row, parsed) {
        for (const attr of ID_ATTRS) {
            const value = normSpace(getAttr(row, attr));
            if (value) return `${attr}:${value}`;
        }

        const rowReuseSignal = getCacheRowReuseSignal(row);
        const messageFingerprint = getMessageFingerprint(parsed);
        const cached = rowIds.get(row);
        const binding = moderatorRowBindings.get(row);
        const keepsCollectedIdentity =
            cached &&
            cached.rowReuseSignal === rowReuseSignal &&
            cached.role === parsed.role &&
            cached.author === parsed.author &&
            parsed.isBlind === true &&
            binding?.messageId === cached.id;
        if (
            !cached ||
            cached.rowReuseSignal !== rowReuseSignal ||
            (!keepsCollectedIdentity && cached.messageFingerprint !== messageFingerprint)
        ) {
            rowIds.set(row, {
                id: `row:${nextRowId}`,
                rowReuseSignal,
                messageFingerprint,
                role: parsed.role,
                author: parsed.author,
            });
            nextRowId += 1;
        } else if (keepsCollectedIdentity) {
            cached.messageFingerprint = messageFingerprint;
        }

        return rowIds.get(row)?.id || `${parsed.role}:${parsed.author}:${parsed.text}`;
    }

    function parseChatMessage(row) {
        const context = createRowParseContext(row);
        const authorTarget = pickAuthorTarget(row, context);
        const author = authorTarget.text;
        const textTarget = pickMessageTextTarget(row, context);
        let text = textTarget.text || getVisibleText(row, context);
        if (!textTarget.text && author && text === author) text = "";
        const hiddenText = pickHiddenOriginalText(row, text, author, context);
        const isBlind = hasBlindSignal(row, text, hiddenText, context);
        const role = detectRole(row, context);
        let badges = role ? getAuthorBadges(authorTarget.el) : [];
        if (role && !badges.length) {
            // 역할 뱃지가 닉네임 영역 밖에 있는 마크업 폴백.
            const roleBadgeSrc = getRoleBadgeSrc(row, context);
            if (roleBadgeSrc) badges = [{ src: roleBadgeSrc, alt: roleLabel(role) }];
        }
        const authorColor = role ? getAuthorColor(authorTarget.el) : "";
        const parsed = {
            author,
            role,
            text,
            isBlind,
            hiddenText,
            badges,
            authorColor,
            timestamp: getChatTimestamp(row, textTarget.el),
            node: row,
            textEl: textTarget.el,
        };
        parsed.id = getMessageId(row, parsed);
        return parsed;
    }

    function getCacheMessageIdentity(row, textEl) {
        let current = textEl instanceof Element && row.contains(textEl) ? textEl : row;
        while (current instanceof Element) {
            for (const attr of MESSAGE_ID_ATTRS) {
                const value = normSpace(getAttr(current, attr));
                if (value) return `${attr}:${value}`;
            }
            if (current === row) break;
            current = current.parentElement;
        }
        return "";
    }

    function getCacheRowReuseSignal(row) {
        if (!(row instanceof Element)) return "";
        return Array.from(row.attributes)
            .filter((attr) => ROW_REUSE_SIGNAL_ATTR_RE.test(attr.name))
            .map((attr) => `${attr.name.toLowerCase()}:${normSpace(attr.value)}`)
            .sort()
            .join("|");
    }

    function cacheOriginalMessageText(row, parsed) {
        if (parsed.isBlind || !parsed.text || isBlindNoticeText(parsed.text)) return;
        const rowReuseSignal = getCacheRowReuseSignal(row);
        const cached = rowOriginalTexts.get(row);
        if (
            cached &&
            cached.rowReuseSignal !== rowReuseSignal &&
            cached.author === parsed.author &&
            cached.sourceTextEl === parsed.textEl &&
            cached.text === parsed.text
        ) {
            // 재사용 표식만 먼저 바뀐 행을 기존 메시지 상태로 다시 파싱해도
            // 낡은 원문을 새 행 소유 캐시로 덮어쓰지 않는다.
            rowOriginalTexts.delete(row);
            return;
        }
        rowOriginalTexts.set(row, {
            author: parsed.author,
            identity: getCacheMessageIdentity(row, parsed.textEl),
            rowReuseSignal,
            root: chatRoot,
            sourceTextEl: parsed.textEl instanceof Element ? parsed.textEl : null,
            text: parsed.text,
        });
    }

    function lookupCachedOriginalText(row, parsed) {
        const cached = rowOriginalTexts.get(row);
        if (!cached) return "";

        const identity = getCacheMessageIdentity(row, parsed.textEl);
        const hasIdentityMismatch = cached.identity || identity ? cached.identity !== identity : false;
        const hasRowReuseSignalMismatch = cached.rowReuseSignal !== getCacheRowReuseSignal(row);
        const hasAuthorMismatch = cached.author && parsed.author && cached.author !== parsed.author;
        const hasUnownedTextElement =
            !cached.identity &&
            (!(cached.sourceTextEl instanceof Element) ||
                !(parsed.textEl instanceof Element) ||
                cached.sourceTextEl !== parsed.textEl);
        if (
            cached.root !== chatRoot ||
            hasIdentityMismatch ||
            hasRowReuseSignalMismatch ||
            hasAuthorMismatch ||
            hasUnownedTextElement
        ) {
            rowOriginalTexts.delete(row);
            return "";
        }

        return cached.text;
    }

    function removeBlindReveal(row) {
        row.querySelector(".bcct-blind-reveal")?.remove();
        for (const el of Array.from(row.querySelectorAll(`[${BLIND_MASKED_ATTR}]`))) {
            el.removeAttribute(BLIND_MASKED_ATTR);
        }
        row.removeAttribute(BLIND_PROCESSED_ATTR);
    }

    function syncBlindReveal(row, parsed) {
        if (!isBlindRevealEnabled() || !parsed.isBlind) {
            removeBlindReveal(row);
            return;
        }

        const original = parsed.hiddenText || lookupCachedOriginalText(row, parsed);
        if (!original) {
            // 원문을 모르면 치지직의 블라인드 문구를 그대로 둔다.
            removeBlindReveal(row);
            return;
        }

        // 프로필 카드 같은 다른 UI 를 본문으로 오인해 가리지 않도록,
        // 실제 블라인드 안내 문구가 표시된 요소일 때만 원문으로 교체한다.
        const target = parsed.textEl instanceof Element && parsed.textEl !== row ? parsed.textEl : null;
        if (!target || !isBlindNoticeText(getVisibleText(target))) {
            removeBlindReveal(row);
            return;
        }

        let reveal = row.querySelector(".bcct-blind-reveal");
        if (!reveal) {
            reveal = document.createElement("span");
            reveal.className = "bcct-blind-reveal";
            reveal.title = "블라인드된 메시지의 원문입니다.";
        }
        if (reveal.textContent !== original) reveal.textContent = original;

        // React 가 className 을 재설정해도 data 속성은 살아남는다 (재렌더 깜빡임 방지).
        target.setAttribute(BLIND_MASKED_ATTR, "1");
        if (reveal.previousElementSibling !== target || reveal.parentElement !== target.parentElement) {
            target.after(reveal);
        }
        row.setAttribute(BLIND_PROCESSED_ATTR, "1");
    }

    function roleLabel(role) {
        return role === "broadcaster" ? "방송자" : "채팅 운영자";
    }

    function purgeLegacyModeratorCache() {
        if (legacyModeratorCachePurged) return;
        legacyModeratorCachePurged = true;
        try {
            globalThis.chrome?.storage?.local?.remove(MODERATOR_CACHE_STORAGE_KEY, () => {
                // Callback 안에서만 유효한 lastError 를 읽어 잔존 캐시 정리 실패가
                // 처리되지 않은 확장 오류로 남지 않게 한다.
                void globalThis.chrome?.runtime?.lastError;
            });
        } catch (_) {
            // 잔존 캐시 정리는 best-effort 라 실패는 조용히 무시한다.
        }
    }

    function getModeratorRenderKey(message) {
        const badgeKey = (Array.isArray(message.badges) ? message.badges : [])
            .map((badge) => `${badge?.src}|${badge?.alt}`)
            .join(",");
        const timestamp = isChatTimestampEnabled() ? message.timestamp : "";
        return [message.id, message.role, message.author, message.text, badgeKey, message.authorColor, timestamp]
            .map((value) => String(value || ""))
            .join("\u001f");
    }

    function buildModeratorSnapshot(parsed) {
        const rowReuseSignal = getCacheRowReuseSignal(parsed.node);
        const identityKey = [parsed.id, rowReuseSignal, parsed.author, parsed.role, parsed.text]
            .map((value) => String(value || ""))
            .join("\u001f");
        return {
            messageId: parsed.id,
            identityKey,
            author: parsed.author,
            role: parsed.role,
            text: parsed.text,
            rowReuseSignal,
            root: chatRoot,
        };
    }

    function isExplicitModeratorMessageId(messageId) {
        return Boolean(messageId && !String(messageId).startsWith("row:"));
    }

    function finalizeModeratorTransitionOwnership(row, expectedOwnership = null) {
        const ownership = moderatorTransitionOwnerships.get(row);
        if (!ownership || (expectedOwnership && ownership !== expectedOwnership)) return;
        moderatorTransitionOwnerships.delete(row);
        const binding = moderatorRowBindings.get(row);
        if (binding?.transitionId === ownership.transitionId) delete binding.transitionId;
    }

    function clearModeratorTransitionOwnerships() {
        for (const [row, ownership] of moderatorTransitionOwnerships) {
            finalizeModeratorTransitionOwnership(row, ownership);
        }
    }

    function retractModeratorTransitionOwnerships({ deferRender = false } = {}) {
        const messages = new Set(
            Array.from(moderatorTransitionOwnerships.values(), (ownership) => ownership.message).filter(Boolean)
        );
        let removed = false;
        for (const message of messages) {
            removed = removeModeratorMessage(message, { deferRender: true }) || removed;
        }
        if (removed && !deferRender) renderModeratorList();
    }

    function cancelModeratorTransition(row) {
        const transition = moderatorRowTransitions.get(row);
        if (!transition) return;
        if (transition.timerId !== null) clearTimeout(transition.timerId);
        moderatorRowTransitions.delete(row);
    }

    function clearModeratorTransitions() {
        for (const transition of moderatorRowTransitions.values()) {
            if (transition.timerId !== null) clearTimeout(transition.timerId);
        }
        moderatorRowTransitions.clear();
    }

    function removeModeratorHighlight(row) {
        if (!(row instanceof HTMLElement)) return;
        if (row.hasAttribute(MODERATOR_HIGHLIGHT_ATTR)) row.removeAttribute(MODERATOR_HIGHLIGHT_ATTR);
        if (row.style.getPropertyValue(MODERATOR_HIGHLIGHT_COLOR)) row.style.removeProperty(MODERATOR_HIGHLIGHT_COLOR);
    }

    function syncModeratorHighlight(parsed) {
        const row = parsed.node;
        if (!(row instanceof HTMLElement)) return;
        if (!isModeratorBoxEnabled()) {
            removeModeratorHighlight(row);
            return;
        }
        const color = parsed.authorColor || "currentColor";
        // style도 원본 채팅 observer가 보므로 실제 색이 달라진 경우에만 쓴다.
        if (row.style.getPropertyValue(MODERATOR_HIGHLIGHT_COLOR) !== color) {
            row.style.setProperty(MODERATOR_HIGHLIGHT_COLOR, color);
        }
        if (row.getAttribute(MODERATOR_HIGHLIGHT_ATTR) !== "1") row.setAttribute(MODERATOR_HIGHLIGHT_ATTR, "1");
    }

    function clearModeratorHighlights() {
        for (const row of document.querySelectorAll(`[${MODERATOR_HIGHLIGHT_ATTR}]`)) removeModeratorHighlight(row);
    }

    function detachModeratorRowBinding(row) {
        const binding = moderatorRowBindings.get(row);
        moderatorRowBindings.delete(row);
        row?.removeAttribute?.(MODERATOR_COLLECTED_ATTR);
        removeModeratorHighlight(row);
        if (binding?.message?.node === row) binding.message.node = null;
        return binding || null;
    }

    function bindModeratorRow(row, message, snapshot) {
        moderatorRowBindings.set(row, {
            ...snapshot,
            message,
        });
        row.setAttribute(MODERATOR_COLLECTED_ATTR, "1");
        message.node = row;
        message.sourceIdentityKey = snapshot.identityKey;
    }

    function registerModeratorTransitionOwnership(row, message, snapshot, transition) {
        if (!transition || !message) return;
        const ownership = {
            transitionId: transition.transitionId,
            sourceRow: row,
            sourceReuseSignal: snapshot.rowReuseSignal,
            sourceIdentityKey: snapshot.identityKey,
            message,
            messageId: snapshot.messageId,
            author: snapshot.author,
            role: snapshot.role,
            text: snapshot.text,
            root: chatRoot,
            retractable: true,
        };
        moderatorTransitionOwnerships.set(row, ownership);
        const binding = moderatorRowBindings.get(row);
        if (binding?.message === message) binding.transitionId = ownership.transitionId;
    }

    function getModeratorTransitionDisposition(ownership, parsed) {
        if (!ownership?.retractable || ownership.sourceRow !== parsed.node || ownership.root !== chatRoot) {
            return "retract";
        }

        const snapshot = buildModeratorSnapshot(parsed);
        if (
            ownership.sourceReuseSignal !== snapshot.rowReuseSignal &&
            (ownership.sourceReuseSignal || snapshot.rowReuseSignal)
        ) {
            return "finalize";
        }

        const ownedExplicitId = isExplicitModeratorMessageId(ownership.messageId);
        const currentExplicitId = isExplicitModeratorMessageId(snapshot.messageId);
        if (
            (ownedExplicitId || currentExplicitId) &&
            String(ownership.messageId || "") !== String(snapshot.messageId || "")
        ) {
            return "retract";
        }
        if (!parsed.role || !parsed.text) return "retract";

        const matchesOwnedIdentity =
            ownership.author === parsed.author && ownership.role === parsed.role && ownership.text === parsed.text;
        if (matchesOwnedIdentity) return "keep";

        // 명시적인 재사용 신호가 같은데 역할·작성자·본문 조합이 달라졌다면
        // 이번 세대의 중간 혼합 상태로 수집된 항목이다. 신호가 없는 행은 별도
        // mutation batch의 완전히 다른 운영자 fingerprint를 다음 세대로 본다.
        return ownership.sourceReuseSignal || snapshot.rowReuseSignal ? "retract" : "finalize";
    }

    function removeModeratorMessage(message, { deferRender = false } = {}) {
        const messageIndex = moderatorMessages.indexOf(message);
        if (messageIndex < 0) return false;

        moderatorMessages.splice(messageIndex, 1);
        collectedMessageIds.delete(message.id);

        const boundRow = message.node;
        if (boundRow instanceof Element && moderatorRowBindings.get(boundRow)?.message === message) {
            detachModeratorRowBinding(boundRow);
        } else {
            message.node = null;
        }

        for (const [row, ownership] of moderatorTransitionOwnerships) {
            if (ownership.message !== message) continue;
            if (moderatorRowBindings.get(row)?.message === message) detachModeratorRowBinding(row);
            finalizeModeratorTransitionOwnership(row, ownership);
        }
        pendingModeratorRemounts = pendingModeratorRemounts.filter((candidate) => candidate.message !== message);

        if (!deferRender) renderModeratorList();
        return true;
    }

    function evictModeratorMessageForCapacity(message) {
        const messageIndex = moderatorMessages.indexOf(message);
        if (messageIndex < 0) return false;

        moderatorMessages.splice(messageIndex, 1);
        collectedMessageIds.delete(message.id);
        for (const [row, ownership] of moderatorTransitionOwnerships) {
            if (ownership.message === message) finalizeModeratorTransitionOwnership(row, ownership);
        }
        return true;
    }

    function trimModeratorMessages() {
        const max = getMaxModeratorMessages();
        if (moderatorMessages.length <= max) return;

        const removed = moderatorMessages.slice(0, moderatorMessages.length - max);
        // 용량 제한은 목록에서만 오래된 항목을 내보낸다. 살아 있는 원본 행의
        // binding/marker까지 지우면 늦은 style·동일 본문 mutation이 그 항목을
        // 새 메시지로 다시 수집해 최근 항목을 밀어낼 수 있다.
        for (const message of removed) {
            evictModeratorMessageForCapacity(message);
        }
    }

    function isSameBoundModeratorMessage(binding, parsed) {
        if (!binding || binding.messageId !== parsed.id) return false;
        if (binding.author !== parsed.author || binding.role !== parsed.role) return false;
        return binding.text === parsed.text || parsed.isBlind === true;
    }

    function backfillModeratorMessage(existing, parsed, { deferRender = false } = {}) {
        existing.node = parsed.node;
        // text/author/role 은 블라인드 전환이나 단계적 DOM 재사용으로 오염될 수
        // 있으므로 변경하지 않고, 늦게 붙는 뱃지와 닉네임 색만 보충한다.
        let backfilled = false;
        const parsedBadges = Array.isArray(parsed.badges) ? parsed.badges : [];
        const existingBadges = Array.isArray(existing.badges) ? existing.badges : [];
        if (!existingBadges.length && parsedBadges.length) {
            existing.badges = parsedBadges;
            backfilled = true;
        }
        if (!existing.authorColor && parsed.authorColor) {
            existing.authorColor = parsed.authorColor;
            backfilled = true;
        }
        if (
            parsed.timestamp &&
            existing.timestamp !== parsed.timestamp &&
            (!existing.timestamp || !String(existing.id || "").startsWith("row:"))
        ) {
            existing.timestamp = parsed.timestamp;
            backfilled = true;
        }
        if (backfilled && !deferRender) renderModeratorList();
    }

    function isMatchingModeratorRemount(binding, parsed) {
        if (!binding?.message || !String(binding.message.id || "").startsWith("row:")) return false;
        if (!String(parsed.id || "").startsWith("row:") || binding.root !== chatRoot) return false;
        if (binding.author !== parsed.author || binding.role !== parsed.role || binding.text !== parsed.text)
            return false;

        const nextRowReuseSignal = getCacheRowReuseSignal(parsed.node);
        return !(binding.rowReuseSignal && nextRowReuseSignal && binding.rowReuseSignal !== nextRowReuseSignal);
    }

    function takeModeratorRemount(parsed) {
        const matchingIndex = pendingModeratorRemounts.findIndex(
            (candidate) =>
                candidate.addedRoots.some((root) => root === parsed.node || root.contains(parsed.node)) &&
                isMatchingModeratorRemount(candidate, parsed)
        );
        if (matchingIndex < 0) return null;

        // 같은 내용의 행이 여러 개 함께 재마운트돼도 제거·추가 순서대로 한 번씩만
        // 넘겨준다. 후보는 같은 childList 교체의 추가 subtree 안에서만 쓸 수 있다.
        const [binding] = pendingModeratorRemounts.splice(matchingIndex, 1);
        const message = binding.message;
        const rowReuseSignal = getCacheRowReuseSignal(parsed.node);
        parsed.id = message.id;
        rowIds.set(parsed.node, {
            id: message.id,
            rowReuseSignal,
            messageFingerprint: getMessageFingerprint(parsed),
            role: parsed.role,
            author: parsed.author,
        });
        return message;
    }

    function commitModeratorMessage(parsed, { deferRender = false, transition = null } = {}) {
        if (!isModeratorBoxEnabled() || !parsed.role || !parsed.text) return false;

        let message = moderatorMessages.find((item) => item.id === parsed.id);
        if (!message) message = takeModeratorRemount(parsed);
        const added = !message;
        if (message) {
            backfillModeratorMessage(message, parsed, { deferRender });
        } else {
            collectedMessageIds.add(parsed.id);
            message = {
                id: parsed.id,
                author: parsed.author,
                role: parsed.role,
                text: parsed.text,
                badges: Array.isArray(parsed.badges) ? parsed.badges : [],
                authorColor: parsed.authorColor || "",
                timestamp: parsed.timestamp || "",
                node: parsed.node,
                sourceIdentityKey: "",
                unread: true,
            };
            moderatorMessages.push(message);
        }

        bindModeratorRow(parsed.node, message, buildModeratorSnapshot(parsed));
        syncModeratorHighlight(parsed);
        if (added && transition) {
            registerModeratorTransitionOwnership(parsed.node, message, buildModeratorSnapshot(parsed), transition);
        }
        if (added) {
            trimModeratorMessages();
            if (!deferRender) renderModeratorList();
        }
        return added;
    }

    function scheduleModeratorTransitionCheck(row, transition) {
        if (transition.timerId !== null) clearTimeout(transition.timerId);
        transition.timerId = setTimeout(() => confirmReusedModeratorCandidate(row), MODERATOR_REUSE_STABILITY_CHECK_MS);
    }

    function stageReusedModeratorCandidate(parsed, sourceBinding = null) {
        const row = parsed.node;
        if (!(row instanceof HTMLElement) || !parsed.role || !parsed.text) {
            cancelModeratorTransition(row);
            return false;
        }

        const snapshot = buildModeratorSnapshot(parsed);
        const revision = rowMutationRevisions.get(row) || 0;
        let transition = moderatorRowTransitions.get(row);
        if (
            transition &&
            transition.generationReuseSignal !== snapshot.rowReuseSignal &&
            (transition.generationReuseSignal || snapshot.rowReuseSignal)
        ) {
            cancelModeratorTransition(row);
            transition = null;
        }
        if (!transition) {
            transition = {
                transitionId: nextModeratorTransitionId,
                sourceRow: row,
                previousReuseSignal: sourceBinding?.rowReuseSignal || "",
                sourceIdentityKey: sourceBinding?.identityKey || "",
                generationReuseSignal: snapshot.rowReuseSignal,
                root: chatRoot,
                snapshotKey: snapshot.identityKey,
                mutationRevision: revision,
                stablePasses: 0,
                timerId: null,
            };
            nextModeratorTransitionId += 1;
            moderatorRowTransitions.set(row, transition);
        } else {
            transition.root = chatRoot;
            transition.generationReuseSignal = snapshot.rowReuseSignal;
            transition.snapshotKey = snapshot.identityKey;
            transition.mutationRevision = revision;
            transition.stablePasses = 0;
        }
        scheduleModeratorTransitionCheck(row, transition);
        return false;
    }

    function confirmReusedModeratorCandidate(row) {
        const transition = moderatorRowTransitions.get(row);
        if (!transition) return;
        transition.timerId = null;

        if (!row.isConnected || transition.root !== chatRoot || !chatRoot?.contains(row)) {
            cancelModeratorTransition(row);
            return;
        }
        if (row.querySelector("[aria-haspopup='true'][aria-expanded='true']")) {
            scheduleModeratorTransitionCheck(row, transition);
            return;
        }

        const parsed = parseChatMessage(row);
        if (!parsed.role || !parsed.text) {
            cancelModeratorTransition(row);
            return;
        }

        const snapshot = buildModeratorSnapshot(parsed);
        const revision = rowMutationRevisions.get(row) || 0;
        if (snapshot.identityKey !== transition.snapshotKey || revision !== transition.mutationRevision) {
            transition.snapshotKey = snapshot.identityKey;
            transition.mutationRevision = revision;
            transition.stablePasses = 0;
            scheduleModeratorTransitionCheck(row, transition);
            return;
        }

        transition.stablePasses += 1;
        if (transition.stablePasses < MODERATOR_REUSE_REQUIRED_STABLE_PASSES) {
            scheduleModeratorTransitionCheck(row, transition);
            return;
        }

        moderatorRowTransitions.delete(row);
        commitModeratorMessage(parsed, { transition });
    }

    function collectModeratorMessage(parsed, { deferRender = false } = {}) {
        const row = parsed.node;
        let binding = moderatorRowBindings.get(row);
        if (binding && isSameBoundModeratorMessage(binding, parsed)) {
            cancelModeratorTransition(row);
            backfillModeratorMessage(binding.message, parsed, { deferRender });
            row.setAttribute(MODERATOR_COLLECTED_ATTR, "1");
            syncModeratorHighlight(parsed);
            return false;
        }

        const ownership = moderatorTransitionOwnerships.get(row);
        if (ownership && binding?.message !== ownership.message) {
            removeModeratorMessage(ownership.message, { deferRender });
            binding = moderatorRowBindings.get(row);
        } else if (ownership) {
            const disposition = getModeratorTransitionDisposition(ownership, parsed);
            if (disposition === "retract") {
                removeModeratorMessage(ownership.message, { deferRender });
                cancelModeratorTransition(row);
                if (!parsed.role || !parsed.text) return false;
                return stageReusedModeratorCandidate(parsed);
            }
            if (disposition === "finalize") {
                finalizeModeratorTransitionOwnership(row, ownership);
            }
        }

        if (binding) {
            const sourceBinding = detachModeratorRowBinding(row);
            if (!parsed.role || !parsed.text) {
                cancelModeratorTransition(row);
                return false;
            }
            return stageReusedModeratorCandidate(parsed, sourceBinding);
        }

        if (moderatorRowTransitions.has(row)) {
            return stageReusedModeratorCandidate(parsed);
        }

        if (row?.hasAttribute?.(MODERATOR_COLLECTED_ATTR)) {
            row.removeAttribute(MODERATOR_COLLECTED_ATTR);
            removeModeratorHighlight(row);
        }
        return commitModeratorMessage(parsed, { deferRender });
    }

    function scrollToOriginalMessage(message) {
        if (!message.node?.isConnected || !chatRoot?.contains(message.node)) return;
        const binding = moderatorRowBindings.get(message.node);
        if (binding?.message !== message || binding.messageId !== message.id) return;
        if (
            binding.rowReuseSignal !== getCacheRowReuseSignal(message.node) ||
            !isSameBoundModeratorMessage(binding, parseChatMessage(message.node))
        )
            return;
        try {
            message.node.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch (_) {
            message.node.scrollIntoView();
        }
    }

    function buildModeratorRow(message) {
        const row = document.createElement("div");
        row.setAttribute("role", "button");
        row.tabIndex = 0;
        row.className = "bcct-moderator-row";
        row.setAttribute(MODERATOR_ROW_ATTR, message.id);
        row.title = "클릭하면 원본 채팅으로 이동 · 드래그해서 복사";

        const meta = document.createElement("span");
        meta.className = "bcct-moderator-row__meta";

        const author = document.createElement("span");
        author.className = "bcct-moderator-row__author";
        author.textContent = message.author || roleLabel(message.role);
        const authorColor = normSpace(message.authorColor || "");
        if (authorColor) author.style.color = authorColor;

        // 치지직 본 채팅창처럼 그 행에 있던 뱃지 아이콘(역할/구독/후원 등)을
        // 순서대로 붙이고, 뱃지가 하나도 없을 때만 역할 라벨 텍스트로 표시한다.
        const badges = (Array.isArray(message.badges) ? message.badges : []).filter((badge) =>
            /^https:\/\//.test(normSpace(badge?.src))
        );
        if (badges.length) {
            for (const badge of badges.slice(0, 8)) {
                const icon = document.createElement("img");
                icon.className = "bcct-moderator-row__badge";
                icon.src = normSpace(badge.src);
                icon.alt = normSpace(badge.alt) || roleLabel(message.role);
                icon.width = 18;
                icon.height = 18;
                icon.draggable = false;
                meta.appendChild(icon);
            }
            meta.appendChild(author);
        } else if (message.author) {
            meta.append(`${roleLabel(message.role)} · `, author);
        } else {
            meta.textContent = roleLabel(message.role);
        }

        const text = document.createElement("span");
        text.className = "bcct-moderator-row__text";
        text.textContent = message.text;

        if (isChatTimestampEnabled() && CHAT_TIMESTAMP_VALUE_RE.test(message.timestamp || "")) {
            const timestamp = document.createElement("span");
            timestamp.className = "bcct-moderator-row__time";
            timestamp.textContent = message.timestamp;
            row.appendChild(timestamp);
        }
        row.append(meta, " ", text);
        row.addEventListener("click", () => {
            if (!hasModeratorTextSelection()) scrollToOriginalMessage(message);
        });
        row.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            scrollToOriginalMessage(message);
        });
        return row;
    }

    function hasModeratorTextSelection() {
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || !moderatorList) return false;
        for (let index = 0; index < selection.rangeCount; index += 1) {
            if (selection.getRangeAt(index).intersectsNode(moderatorList)) return true;
        }
        return false;
    }

    function getModeratorAuthorKey(message) {
        // 현재 DOM에서 확인한 닉네임으로만 묶는다. 이름 없는 행을 같은 사용자로 추정하지 않는다.
        return message.author ? `name:${message.author}` : `message:${message.id}`;
    }

    function getModeratorActors() {
        const actors = new Map();
        for (const message of moderatorMessages) {
            const key = getModeratorAuthorKey(message);
            let actor = actors.get(key);
            if (!actor) {
                actor = { name: message.author || roleLabel(message.role), total: 0, unread: 0 };
                actors.set(key, actor);
            }
            actor.total += 1;
            if (message.unread) actor.unread += 1;
        }
        return actors;
    }

    function syncModeratorText(element, text) {
        if (element && element.textContent !== text) element.textContent = text;
    }

    function renderModeratorActivity(actors = getModeratorActors()) {
        if (!moderatorAuthors || !moderatorToggle) return;
        const renderKey = JSON.stringify([
            moderatorAuthorFilter,
            moderatorMessages.map((message) => [message.id, message.author, message.role, message.unread]),
        ]);
        if (moderatorActivityRenderKey === renderKey) return;
        moderatorActivityRenderKey = renderKey;
        const unread = moderatorMessages.filter((message) => message.unread).length;
        syncModeratorText(moderatorCount, `${moderatorMessages.length}`);
        syncModeratorText(moderatorTriggerCount, `${unread}`);
        moderatorTriggerCount.dataset.empty = unread ? "0" : "1";
        moderatorToggle.dataset.unread = unread ? "1" : "0";
        const entries = new Map([["", { name: "전체", total: moderatorMessages.length, unread }], ...actors]);
        const buttons = new Map(Array.from(moderatorAuthors.children, (button) => [button.dataset.authorKey, button]));
        for (const [key, button] of buttons) {
            if (!entries.has(key)) button.remove();
        }
        for (const [key, actor] of entries) {
            let button = buttons.get(key);
            if (!button) {
                button = document.createElement("button");
                button.type = "button";
                button.className = "bcct-moderator-author";
                button.dataset.authorKey = key;
                const name = document.createElement("span");
                name.className = "bcct-moderator-author__name";
                const badge = document.createElement("span");
                badge.className = "bcct-moderator-author__unread";
                badge.setAttribute("aria-hidden", "true");
                button.append(name, badge);
                button.addEventListener("click", () => {
                    moderatorAuthorFilter = key;
                    renderModeratorList();
                    scrollModeratorListToBottom();
                    scheduleModeratorReadCheck();
                });
                moderatorAuthors.appendChild(button);
            }
            syncModeratorText(button.firstElementChild, actor.name);
            syncModeratorText(button.lastElementChild, `새 ${actor.unread}`);
            if (button.lastElementChild.hidden !== !actor.unread) button.lastElementChild.hidden = !actor.unread;
            const pressed = String(moderatorAuthorFilter === key);
            if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
            const label = `${actor.name}, 보관 ${actor.total}개, 미확인 ${actor.unread}개`;
            if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
            if (button.title !== label) button.title = label;
        }
        const visibleUnread = moderatorMessages.filter(
            (message) =>
                message.unread && (!moderatorAuthorFilter || getModeratorAuthorKey(message) === moderatorAuthorFilter)
        ).length;
        syncModeratorText(moderatorSummary, visibleUnread ? `미확인 채팅 ${visibleUnread}개` : "새 채팅 없음");
        for (const { row, message } of moderatorRenderedRows.values()) {
            const value = message.unread ? "1" : "0";
            if (row.dataset.unread !== value) row.dataset.unread = value;
        }
        setModeratorPanelOpen(moderatorPanelOpen);
    }

    function scheduleModeratorReadCheck() {
        if (!moderatorPanelOpen || !moderatorList || moderatorReadFrame !== null) return;
        moderatorReadFrame = requestAnimationFrame(markVisibleModeratorMessagesRead);
    }

    function markVisibleModeratorMessagesRead() {
        moderatorReadFrame = null;
        if (!moderatorPanelOpen || !moderatorList?.isConnected || document.visibilityState === "hidden") return;
        syncModeratorBottomButton();
        const bounds = moderatorList.getBoundingClientRect();
        const top = Math.max(0, bounds.top);
        const bottom = Math.min(window.innerHeight, bounds.bottom);
        const left = Math.max(0, bounds.left);
        const right = Math.min(window.innerWidth, bounds.right);
        if (bottom <= top || right <= left) return;
        let changed = false;
        for (const { row, message } of moderatorRenderedRows.values()) {
            if (!message.unread || row.hidden) continue;
            const rect = row.getBoundingClientRect();
            if (rect.height <= 0 || rect.right <= left || rect.left >= right) continue;
            const visibleHeight = Math.min(bottom, rect.bottom) - Math.max(top, rect.top);
            // 긴 메시지는 목록 높이를 기준으로, 그 외에는 행의 절반 이상이 보여야 확인 처리한다.
            if (visibleHeight < Math.min(rect.height, bottom - top) / 2) continue;
            message.unread = false;
            changed = true;
        }
        if (changed) renderModeratorActivity();
    }

    function syncModeratorBottomButton() {
        if (!moderatorBottomButton || !moderatorList) return;
        const hidden = !moderatorPanelOpen || moderatorList.clientHeight <= 0 || isModeratorListNearBottom(2);
        if (moderatorBottomButton.hidden !== hidden) moderatorBottomButton.hidden = hidden;
    }

    function updateModeratorRowAppearance(row, message) {
        // 백필은 본문/닉네임 텍스트 노드를 교체하지 않아 드래그 선택을 유지한다.
        const fresh = buildModeratorRow(message);
        const author = row.querySelector(".bcct-moderator-row__author");
        if (author && message.authorColor) author.style.color = message.authorColor;
        const meta = row.querySelector(".bcct-moderator-row__meta");
        if (meta && !meta.querySelector("img") && fresh.querySelector(".bcct-moderator-row__badge")) {
            for (const node of Array.from(meta.childNodes)) {
                if (node.nodeType === Node.TEXT_NODE) node.remove();
            }
            for (const badge of fresh.querySelectorAll(".bcct-moderator-row__badge")) {
                meta.insertBefore(badge, author?.parentNode === meta ? author : null);
            }
        }
        const nextTime = fresh.querySelector(".bcct-moderator-row__time");
        const time = row.querySelector(".bcct-moderator-row__time");
        if (time && nextTime) syncModeratorText(time, nextTime.textContent);
        else if (nextTime) row.prepend(nextTime);
        else time?.remove();
    }

    function renderModeratorList() {
        if (!moderatorList || !moderatorCount || !moderatorTriggerCount) return;
        const actors = getModeratorActors();
        if (moderatorAuthorFilter && !actors.has(moderatorAuthorFilter)) moderatorAuthorFilter = "";
        const stickToBottom = moderatorPanelOpen && !hasModeratorTextSelection() && isModeratorListNearBottom();
        const nextMessages = new Set(moderatorMessages);
        for (const [id, entry] of moderatorRenderedRows) {
            if (nextMessages.has(entry.message)) continue;
            entry.row.remove();
            moderatorRenderedRows.delete(id);
        }
        let changed = false;
        for (const message of moderatorMessages) {
            const key = getModeratorRenderKey(message);
            let entry = moderatorRenderedRows.get(message.id);
            if (!entry) {
                entry = { row: buildModeratorRow(message), message, key };
                moderatorRenderedRows.set(message.id, entry);
                moderatorList.appendChild(entry.row);
                changed = true;
            } else if (entry.key !== key) {
                updateModeratorRowAppearance(entry.row, message);
                entry.key = key;
            }
            const hidden = Boolean(moderatorAuthorFilter && getModeratorAuthorKey(message) !== moderatorAuthorFilter);
            if (entry.row.hidden !== hidden) {
                entry.row.hidden = hidden;
                changed = true;
            }
        }
        let empty = moderatorList.querySelector(".bcct-moderator-box__empty");
        if (!moderatorMessages.length && !empty) {
            empty = document.createElement("div");
            empty.className = "bcct-moderator-box__empty";
            empty.textContent = "아직 수집된 메시지가 없습니다.";
            moderatorList.appendChild(empty);
        } else if (moderatorMessages.length) empty?.remove();
        renderModeratorActivity(actors);
        if (changed && stickToBottom) scrollModeratorListToBottom();
        scheduleModeratorReadCheck();
    }

    function isModeratorListNearBottom(threshold = 40) {
        if (!moderatorList) return false;
        const distance = moderatorList.scrollHeight - moderatorList.scrollTop - moderatorList.clientHeight;
        return distance <= threshold;
    }

    function scrollModeratorListToBottom() {
        if (!moderatorList) return;
        moderatorList.scrollTop = moderatorList.scrollHeight;
        syncModeratorBottomButton();
        scheduleModeratorReadCheck();
    }

    function setModeratorPanelOpen(open) {
        const wasOpen = moderatorPanelOpen;
        moderatorPanelOpen = open;
        if (!moderatorBox || !moderatorToggle) return;
        const openValue = open ? "1" : "0";
        const expandedValue = open ? "true" : "false";
        const unread = moderatorMessages.filter((message) => message.unread).length;
        const label = `${MODERATOR_TITLE} ${moderatorMessages.length}개, 미확인 ${unread}개 ${open ? "닫기" : "열기"}`;
        if (moderatorBox.dataset.open !== openValue) moderatorBox.dataset.open = openValue;
        if (moderatorToggle.getAttribute("aria-expanded") !== expandedValue) {
            moderatorToggle.setAttribute("aria-expanded", expandedValue);
        }
        if (moderatorToggle.getAttribute("aria-label") !== label) moderatorToggle.setAttribute("aria-label", label);
        // 패널이 새로 열릴 때(닫힘→열림)만 최신 메시지가 보이도록 맨 아래로 내린다.
        // display:none 인 동안에는 scrollHeight 가 0 이라 dataset.open="1" 로 표시된
        // 뒤에 실행해야 한다.
        if (open && !wasOpen) scrollModeratorListToBottom();
        if (open && !wasOpen) scheduleModeratorReadCheck();
        syncModeratorBottomButton();
        if (!open && moderatorReadFrame !== null) {
            cancelAnimationFrame(moderatorReadFrame);
            moderatorReadFrame = null;
        }
    }

    function removeModeratorBox() {
        if (moderatorReadFrame !== null) cancelAnimationFrame(moderatorReadFrame);
        moderatorReadFrame = null;
        moderatorResizeObserver?.disconnect();
        moderatorResizeObserver = null;
        moderatorActivityRenderKey = "";
        document.removeEventListener("visibilitychange", scheduleModeratorReadCheck);
        window.removeEventListener("resize", scheduleModeratorReadCheck);
        if (moderatorAnchorObserver) {
            moderatorAnchorObserver.disconnect();
            moderatorAnchorObserver = null;
        }
        moderatorAnchorRoot = null;
        moderatorAnchorDirty = false;
        document.removeEventListener("keydown", onModeratorDocumentKeydown, true);
        const actionGroup = moderatorToggle?.closest?.(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
        if (moderatorBox) {
            moderatorBox.remove();
            moderatorBox = null;
            moderatorList = null;
            moderatorCount = null;
        }
        moderatorRenderedRows.clear();
        moderatorAuthors = null;
        moderatorSummary = null;
        moderatorBottomButton = null;
        if (moderatorToggle) {
            moderatorToggle.remove();
            moderatorToggle = null;
            moderatorTriggerCount = null;
        }
        if (actionGroup?.parentElement) {
            while (actionGroup.firstChild) {
                actionGroup.parentElement.insertBefore(actionGroup.firstChild, actionGroup);
            }
            actionGroup.remove();
        }
        for (const host of Array.from(document.querySelectorAll(`[${MODERATOR_PANEL_HOST_ATTR}]`))) {
            host.removeAttribute(MODERATOR_PANEL_HOST_ATTR);
        }
        moderatorPanelHost = null;
        moderatorHeader = null;
        moderatorMenuButton = null;
        moderatorMenuButtonConfirmed = false;
    }

    function onModeratorDocumentKeydown(event) {
        if (event.key === "Escape" && moderatorPanelOpen) {
            setModeratorPanelOpen(false);
        }
    }

    function createModeratorIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "2");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        svg.setAttribute("aria-hidden", "true");

        const bubble = document.createElementNS("http://www.w3.org/2000/svg", "path");
        bubble.setAttribute(
            "d",
            "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.6-.8L3 20l1.1-4.1A8.1 8.1 0 0 1 3 11.5 8.6 8.6 0 0 1 12 3a8.6 8.6 0 0 1 9 8.5Z"
        );

        const line1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        line1.setAttribute("d", "M8 10h8");

        const line2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
        line2.setAttribute("d", "M8 14h5");

        svg.append(bubble, line1, line2);
        return svg;
    }

    function buttonText(button) {
        return normSpace(
            [
                getAttr(button, "aria-label"),
                getAttr(button, "title"),
                getAttr(button, "data-testid"),
                getClassText(button),
                getVisibleText(button),
            ].join(" ")
        );
    }

    function hasMenuButtonSignal(button) {
        if (!(button instanceof HTMLButtonElement)) return false;
        const text = buttonText(button);
        if (/더보기|메뉴|설정|more|menu|option|setting|ellipsis/i.test(text)) return true;
        return /^[\s⋮⋯…·•・]+$/.test(getVisibleText(button));
    }

    function isMenuButton(button) {
        return button instanceof HTMLButtonElement && !isOwnUi(button) && hasMenuButtonSignal(button);
    }

    function findChatPanelRoot(rootEl) {
        let current = rootEl.parentElement || rootEl;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
            if (!(current instanceof Element) || current === document.body) break;
            const marker = `${getClassText(current)} ${getAttr(current, "role")} ${getAttr(current, "aria-label")}`;
            if (/chat|chatting|채팅|live_chatting/i.test(marker)) return current;
        }
        return rootEl.parentElement || rootEl;
    }

    function isPinnedNoticeElement(element) {
        let current = element;
        for (let depth = 0; current instanceof Element && depth < 4; depth += 1, current = current.parentElement) {
            const marker = [
                getClassText(current),
                getAttr(current, "role"),
                getAttr(current, "aria-label"),
                getAttr(current, "title"),
                getAttr(current, "data-testid"),
            ].join(" ");
            if (PINNED_NOTICE_RE.test(marker)) return true;
        }
        return false;
    }

    function isChatInputElement(element) {
        let current = element;
        for (let depth = 0; current instanceof Element && depth < 4; depth += 1, current = current.parentElement) {
            const marker = [
                getClassText(current),
                getAttr(current, "role"),
                getAttr(current, "aria-label"),
                getAttr(current, "title"),
                getAttr(current, "data-testid"),
            ].join(" ");
            if (CHAT_INPUT_RE.test(marker)) return true;
        }
        return false;
    }

    function isChatHeaderCandidate(candidate, rootEl) {
        return (
            candidate instanceof Element &&
            !candidate.contains(rootEl) &&
            !isOwnUi(candidate) &&
            !isPinnedNoticeElement(candidate) &&
            !isChatInputElement(candidate)
        );
    }

    function findChatHeader(rootEl) {
        const panelRoot = findChatPanelRoot(rootEl);
        const candidates = [
            ...Array.from(
                panelRoot.querySelectorAll(
                    "header,[class*='header'],[class*='Header'],[class*='toolbar'],[class*='Toolbar']"
                )
            ),
            ...Array.from(panelRoot.children || []),
        ];

        for (const candidate of candidates) {
            if (!isChatHeaderCandidate(candidate, rootEl)) continue;
            const text = getVisibleText(candidate);
            const buttons = Array.from(candidate.querySelectorAll("button"));
            if (CHAT_TITLE_RE.test(text) && buttons.some(isMenuButton)) return candidate;
        }

        for (const candidate of candidates) {
            if (
                !(candidate instanceof Element) ||
                candidate.contains(rootEl) ||
                isOwnUi(candidate) ||
                isPinnedNoticeElement(candidate) ||
                isChatInputElement(candidate)
            ) {
                continue;
            }
            const text = getVisibleText(candidate);
            const buttons = Array.from(candidate.querySelectorAll("button"));
            if ((/채팅|chat/i.test(text) || buttons.some(isMenuButton)) && buttons.length) return candidate;
        }

        const menuButton = Array.from(panelRoot.querySelectorAll("button")).find(
            (button) => isMenuButton(button) && !isPinnedNoticeElement(button) && !isChatInputElement(button)
        );
        return menuButton?.parentElement || panelRoot;
    }

    function findMenuButton(header) {
        const buttons = Array.from(header?.querySelectorAll?.("button") || []).filter(
            (button) => !isOwnUi(button) && !isPinnedNoticeElement(button) && !isChatInputElement(button)
        );
        return buttons.find(isMenuButton) || buttons[buttons.length - 1] || null;
    }

    function ensureModeratorActionGroup(menuButton, header) {
        if (!(menuButton instanceof HTMLButtonElement)) return null;
        const existing = menuButton.closest(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
        if (existing instanceof Element) return existing;

        const group = document.createElement("span");
        group.className = "bcct-moderator-actions";
        group.setAttribute(MODERATOR_ACTION_GROUP_ATTR, "1");

        const parent = menuButton.parentElement || header;
        parent.insertBefore(group, menuButton);
        group.appendChild(menuButton);
        return group;
    }

    function isPotentialModeratorAnchorNode(node, rootEl) {
        const element = resolveMutationElement(node);
        if (!(element instanceof Element) || element === rootEl || rootEl.contains(element)) return false;
        if (moderatorMenuButton && (element === moderatorMenuButton || element.contains(moderatorMenuButton))) {
            return true;
        }
        if (element.closest(`[${MODERATOR_BOX_ATTR}], [${MODERATOR_TRIGGER_ATTR}]`)) return false;
        if (isPinnedNoticeElement(element) || isChatInputElement(element)) return false;
        if (element.matches("header,[class*='header'],[class*='Header'],[class*='toolbar'],[class*='Toolbar']")) {
            return true;
        }

        const buttons = [
            ...(element instanceof HTMLButtonElement ? [element] : []),
            ...Array.from(element.querySelectorAll("button")),
        ];
        return buttons.some(
            (button) =>
                button !== moderatorToggle &&
                hasMenuButtonSignal(button) &&
                !isPinnedNoticeElement(button) &&
                !isChatInputElement(button)
        );
    }

    function observeProvisionalModeratorAnchor(host, rootEl, menuButtonConfirmed) {
        if (moderatorAnchorObserver) moderatorAnchorObserver.disconnect();
        moderatorAnchorObserver = null;
        moderatorAnchorRoot = null;
        moderatorAnchorDirty = false;
        if (menuButtonConfirmed || !(host instanceof Element) || !(rootEl instanceof Element)) return;

        const observedHost = host;
        const observedRoot = rootEl;
        moderatorAnchorRoot = rootEl;
        moderatorAnchorObserver = new MutationObserver((mutations) => {
            if (moderatorPanelHost !== observedHost || chatRoot !== observedRoot) return;
            const anchorChanged = mutations.some((mutation) => {
                const target = resolveMutationElement(mutation.target);
                if (!(target instanceof Element)) return false;
                if (target.closest(`[${MODERATOR_BOX_ATTR}], [${MODERATOR_TRIGGER_ATTR}], .bcct-blind-reveal`)) {
                    return false;
                }
                if (target === observedRoot || observedRoot.contains(target)) return false;
                if (moderatorMenuButton && (target === moderatorMenuButton || moderatorMenuButton.contains(target))) {
                    return true;
                }
                return [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some((node) =>
                    isPotentialModeratorAnchorNode(node, observedRoot)
                );
            });
            if (!anchorChanged) return;
            moderatorAnchorDirty = true;
            scheduleSync();
        });
        moderatorAnchorObserver.observe(host, { childList: true, subtree: true });
    }

    function isModeratorUiMountedForRoot(rootEl) {
        if (
            !moderatorBox?.isConnected ||
            !moderatorList?.isConnected ||
            !moderatorCount?.isConnected ||
            !moderatorToggle?.isConnected ||
            !moderatorTriggerCount?.isConnected ||
            !moderatorPanelHost?.isConnected ||
            !moderatorHeader?.isConnected
        ) {
            return false;
        }

        const hostOwnsRoot =
            moderatorPanelHost === rootEl || moderatorPanelHost.contains(rootEl) || rootEl.contains(moderatorPanelHost);
        if (
            !hostOwnsRoot ||
            moderatorBox.parentElement !== moderatorPanelHost ||
            !moderatorPanelHost.contains(moderatorHeader)
        ) {
            return false;
        }

        let placementValid = false;
        if (!moderatorMenuButton) {
            placementValid = moderatorToggle.parentElement === moderatorHeader;
        } else {
            const actionGroup = moderatorToggle.closest(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
            placementValid = Boolean(
                moderatorMenuButton.isConnected &&
                actionGroup?.isConnected &&
                actionGroup.parentElement &&
                moderatorHeader.contains(actionGroup) &&
                moderatorMenuButton.parentElement === actionGroup &&
                moderatorToggle.nextElementSibling === moderatorMenuButton
            );
        }
        if (!placementValid) return false;

        if (!moderatorMenuButtonConfirmed) {
            if (moderatorAnchorRoot !== rootEl) {
                observeProvisionalModeratorAnchor(moderatorPanelHost, rootEl, false);
                moderatorAnchorDirty = true;
            }
            return !moderatorAnchorDirty;
        }
        return true;
    }

    function ensureModeratorBox(rootEl) {
        if (!isModeratorBoxEnabled() || !(rootEl instanceof Element)) {
            removeModeratorBox();
            return;
        }

        if (isModeratorUiMountedForRoot(rootEl)) {
            renderModeratorList();
            return;
        }
        if (moderatorBox || moderatorToggle) removeModeratorBox();

        const panelRoot = findChatPanelRoot(rootEl);
        const header = findChatHeader(rootEl);
        const menuButton = findMenuButton(header);
        const menuButtonConfirmed = Boolean(menuButton && isMenuButton(menuButton));
        const host = panelRoot instanceof Element ? panelRoot : rootEl.parentElement || rootEl;
        host.setAttribute(MODERATOR_PANEL_HOST_ATTR, "1");

        if (!moderatorToggle?.isConnected) {
            const trigger = document.createElement("button");
            trigger.type = "button";
            trigger.className = "bcct-moderator-trigger";
            trigger.setAttribute(MODERATOR_TRIGGER_ATTR, "1");
            trigger.appendChild(createModeratorIcon());

            const count = document.createElement("span");
            count.className = "bcct-moderator-trigger__count";
            count.dataset.empty = "1";
            trigger.appendChild(count);

            trigger.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                setModeratorPanelOpen(!moderatorPanelOpen);
            });

            moderatorToggle = trigger;
            moderatorTriggerCount = count;
        }

        const actionGroup = ensureModeratorActionGroup(menuButton, header);
        if (actionGroup && moderatorToggle.nextElementSibling !== menuButton) {
            actionGroup.insertBefore(moderatorToggle, menuButton);
        } else if (!moderatorToggle.isConnected) {
            header.appendChild(moderatorToggle);
        }

        if (moderatorBox?.isConnected) {
            renderModeratorList();
            return;
        }

        const box = document.createElement("section");
        box.className = "bcct-moderator-box";
        box.setAttribute(MODERATOR_BOX_ATTR, "1");
        box.setAttribute("aria-label", MODERATOR_TITLE);
        box.dataset.open = "0";

        const headerRow = document.createElement("div");
        headerRow.className = "bcct-moderator-box__header";
        const title = document.createElement("span");
        title.className = "bcct-moderator-box__title";
        title.textContent = MODERATOR_TITLE;

        const count = document.createElement("span");
        count.className = "bcct-moderator-box__count";
        count.textContent = "0";

        const titleWrap = document.createElement("span");
        titleWrap.className = "bcct-moderator-box__heading";
        titleWrap.append(title, " ", count);

        const close = document.createElement("button");
        close.type = "button";
        close.className = "bcct-moderator-box__close";
        close.setAttribute("aria-label", `${MODERATOR_TITLE} 닫기`);
        close.textContent = "×";
        close.addEventListener("click", () => setModeratorPanelOpen(false));

        headerRow.append(titleWrap, close);

        const list = document.createElement("div");
        list.className = "bcct-moderator-box__list";
        list.addEventListener("scroll", scheduleModeratorReadCheck, { passive: true });
        list.addEventListener("focusin", scheduleModeratorReadCheck);

        const authors = document.createElement("div");
        authors.className = "bcct-moderator-authors";
        authors.setAttribute("role", "group");
        authors.setAttribute("aria-label", "식별된 사용자별 채팅 보기");
        const summaryRow = document.createElement("div");
        summaryRow.className = "bcct-moderator-summary";
        const summary = document.createElement("span");
        summary.setAttribute("role", "status");
        const bottomButton = document.createElement("button");
        bottomButton.type = "button";
        bottomButton.className = "bcct-moderator-bottom";
        bottomButton.setAttribute("aria-label", "맨 아래로");
        bottomButton.title = "맨 아래로";
        const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        chevron.setAttribute("viewBox", "0 0 24 24");
        chevron.setAttribute("fill", "none");
        chevron.setAttribute("stroke", "currentColor");
        chevron.setAttribute("stroke-width", "2");
        chevron.setAttribute("stroke-linecap", "round");
        chevron.setAttribute("stroke-linejoin", "round");
        chevron.setAttribute("aria-hidden", "true");
        const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        chevronPath.setAttribute("d", "M6 9l6 6 6-6");
        chevron.appendChild(chevronPath);
        bottomButton.appendChild(chevron);
        bottomButton.hidden = true;
        bottomButton.addEventListener("click", scrollModeratorListToBottom);
        summaryRow.append(summary, bottomButton);

        box.append(headerRow, authors, summaryRow, list);
        host.appendChild(box);

        moderatorBox = box;
        moderatorList = list;
        moderatorCount = count;
        moderatorAuthors = authors;
        moderatorSummary = summary;
        moderatorBottomButton = bottomButton;
        moderatorPanelHost = host;
        moderatorHeader = header;
        moderatorMenuButton = menuButton;
        moderatorMenuButtonConfirmed = menuButtonConfirmed;
        document.addEventListener("keydown", onModeratorDocumentKeydown, true);
        document.addEventListener("visibilitychange", scheduleModeratorReadCheck);
        window.addEventListener("resize", scheduleModeratorReadCheck);
        if (typeof ResizeObserver === "function") {
            moderatorResizeObserver = new ResizeObserver(scheduleModeratorReadCheck);
            moderatorResizeObserver.observe(list);
        }
        setModeratorPanelOpen(moderatorPanelOpen);
        renderModeratorList();
        observeProvisionalModeratorAnchor(host, rootEl, menuButtonConfirmed);
    }

    function removeAllBlindReveals() {
        for (const row of Array.from(document.querySelectorAll(`[${BLIND_PROCESSED_ATTR}]`))) {
            removeBlindReveal(row);
        }
    }

    function clearModeratorState() {
        clearModeratorTransitions();
        clearModeratorTransitionOwnerships();
        clearModeratorHighlights();
        for (const row of Array.from(document.querySelectorAll(`[${MODERATOR_COLLECTED_ATTR}]`))) {
            row.removeAttribute(MODERATOR_COLLECTED_ATTR);
        }
        moderatorMessages = [];
        collectedMessageIds = new Set();
        moderatorRowBindings = new WeakMap();
        pendingModeratorRemounts = [];
        rowMutationRevisions = new WeakMap();
        moderatorAuthorFilter = "";
        renderModeratorList();
    }

    function removeInjectedUi({ clearMessages = true } = {}) {
        clearModeratorTransitions();
        clearModeratorTransitionOwnerships();
        removeAllBlindReveals();
        removeModeratorBox();
        if (clearMessages) clearModeratorState();
        document.getElementById(STYLE_ID)?.remove();
    }

    function hasChatRowSignal(el) {
        const marker = getElementAttrText(el);
        return /chat|message|comment|채팅|댓글|blind|hidden|deleted|blocked|manager|moderator|owner|streamer/i.test(
            marker
        );
    }

    function normalizeCandidateRow(el, rootEl) {
        let identityRow = null;
        let structuralRow = null;
        let weakRow = el;
        let current = el;
        for (let depth = 0; current && current !== rootEl && depth < 8; depth += 1, current = current.parentElement) {
            if (!(current instanceof Element)) break;
            if (hasExplicitChatRowIdentity(current)) {
                identityRow = current;
            }

            const classText = getClassText(current);
            if (/(^|[\s_-])(row|item)(?=$|[\s_-])/i.test(classText) && getVisibleText(current)) {
                structuralRow = current;
                continue;
            }
            if (/(^|[\s_-])(message|chat|comment)(?=$|[\s_-])/i.test(classText) && getVisibleText(current)) {
                weakRow = current;
            }
        }
        return structuralRow || identityRow || weakRow;
    }

    function hasCandidateAncestor(row, candidateRows, rootEl) {
        for (let current = row?.parentElement; current && current !== rootEl; current = current.parentElement) {
            if (candidateRows.has(current)) return true;
        }
        return false;
    }

    function hasExplicitChatRowIdentity(row) {
        return (
            row instanceof Element &&
            (MESSAGE_ID_ATTRS.some((attr) => getAttr(row, attr)) || getAttr(row, "role") === "listitem")
        );
    }

    function filterNestedCandidateRows(rows, rootEl) {
        const distinctRows = Array.from(new Set(rows));
        // 서로 다른 실제 행을 품은 후보는 행이 아니라 가상 목록 컨테이너다. 클래스에
        // chat/message 같은 넓은 신호가 붙더라도 자식 행보다 우선되지 않게 한다. 다만
        // 명시적인 메시지 ID/역할을 가진 행은 자식의 구조 클래스만으로 버리지 않는다.
        const allCandidateRows = new Set(distinctRows.filter((row) => row instanceof Element));
        const containerRows = new Set();
        for (const row of allCandidateRows) {
            for (let current = row.parentElement; current && current !== rootEl; current = current.parentElement) {
                if (allCandidateRows.has(current) && !hasExplicitChatRowIdentity(current)) {
                    containerRows.add(current);
                }
            }
        }
        const rowList = distinctRows.filter((row) => !containerRows.has(row));
        const candidateRows = new Set(rowList.filter((row) => row instanceof Element));
        return rowList.filter((row) => {
            if (!(row instanceof HTMLElement) || row === rootEl || isOwnUi(row)) return false;
            if (!rootEl.contains(row) || hasCandidateAncestor(row, candidateRows, rootEl)) return false;
            return true;
        });
    }

    function resetChatProcessingState({ reparse = true } = {}) {
        dirtyChatRows.clear();
        parsedChatRows = new WeakSet();
        pendingModeratorRemounts = [];
        forceFullChatScan = true;
        forceReparseChatRows = reparse;
        chatMutationBatchShouldSchedule = false;
    }

    function bumpRowMutationRevision(row) {
        if (!(row instanceof HTMLElement)) return 0;
        const next = (rowMutationRevisions.get(row) || 0) + 1;
        rowMutationRevisions.set(row, next);
        return next;
    }

    function requestFullChatScan({ reparse = false } = {}) {
        forceFullChatScan = true;
        if (reparse) forceReparseChatRows = true;
    }

    function resolveMutationElement(node) {
        if (node instanceof Element) return node;
        return node?.parentElement instanceof Element ? node.parentElement : null;
    }

    function findChatRowsInMutationSubtree(node, rootEl = chatRoot) {
        const el = resolveMutationElement(node);
        if (!(el instanceof Element) || !(rootEl instanceof Element) || el === rootEl) {
            return { rows: [], overflow: false };
        }
        if (!rootEl.contains(el) || isOwnUi(el)) return { rows: [], overflow: false };

        const rows = new Set();
        const pending = [el];
        let visited = 0;
        while (pending.length > 0) {
            const current = pending.pop();
            if (!(current instanceof Element) || !rootEl.contains(current) || isOwnUi(current)) continue;

            visited += 1;
            if (visited > MAX_MUTATION_SUBTREE_ELEMENTS) return { rows: [], overflow: true };

            if (current.matches(CHAT_ROW_SELECTORS)) {
                const row = normalizeCandidateRow(current, rootEl);
                if (row instanceof HTMLElement && row !== rootEl && !isOwnUi(row)) rows.add(row);
            }

            const children = Array.from(current.children);
            for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
        }

        return {
            rows: filterNestedCandidateRows(rows, rootEl),
            overflow: false,
        };
    }

    function getChatRowForNode(node, rootEl = chatRoot) {
        const el = resolveMutationElement(node);
        if (!(el instanceof Element) || !(rootEl instanceof Element) || el === rootEl) return null;
        if (!rootEl.contains(el) || isOwnUi(el)) return null;

        const closestRow = el.closest(CHAT_ROW_SELECTORS);
        const candidate = closestRow && closestRow !== rootEl && rootEl.contains(closestRow) ? closestRow : el;
        const row = normalizeCandidateRow(candidate, rootEl);
        if (!(row instanceof HTMLElement) || row === rootEl || isOwnUi(row)) return null;
        return row;
    }

    function markDirtyChatRow(node, rootEl = chatRoot) {
        const subtreeRows = findChatRowsInMutationSubtree(node, rootEl);
        if (subtreeRows.overflow) {
            requestFullChatScan({ reparse: false });
            chatMutationBatchShouldSchedule = true;
            return true;
        }

        const fallbackRow = subtreeRows.rows.length === 0 ? getChatRowForNode(node, rootEl) : null;
        const rows = subtreeRows.rows.length > 0 ? subtreeRows.rows : fallbackRow ? [fallbackRow] : [];
        if (rows.length === 0) return false;

        for (const row of rows) {
            bumpRowMutationRevision(row);
            dirtyChatRows.add(row);
        }
        chatMutationBatchShouldSchedule = true;
        return true;
    }

    function getMutationSignalText(row, target) {
        const el = target instanceof Element ? target : target?.parentElement;
        return [
            el ? getElementAttrText(el) : "",
            el?.textContent || "",
            row instanceof Element ? getElementAttrText(row) : "",
            row?.textContent || "",
        ].join(" ");
    }

    function shouldTrackChatAttributeMutation(mutation, row) {
        const attrName = String(mutation.attributeName || "").toLowerCase();
        if (!CHAT_DIRTY_ATTRIBUTE_FILTER.includes(attrName)) return false;
        if (attrName === "aria-expanded" && getAttr(mutation.target, "aria-haspopup") === "true") return true;
        if (MESSAGE_ID_ATTRS.includes(attrName)) return true;
        if (ROW_REUSE_SIGNAL_ATTRIBUTES.includes(attrName)) return true;
        if (row?.hasAttribute(BLIND_PROCESSED_ATTR)) return true;

        // 이미 수집된 행도 계속 추적한다. 치지직이 메시지 삽입 직후 닉네임 색
        // 인라인 style 을 한 박자 늦게 적용하는 경우가 있어, 그 mutation 이
        // 재파싱을 일으켜야 뱃지/색상 백필이 발동한다. role 신호(img alt)는
        // 하위 요소에만 있어 signalText 로는 못 잡지만, 수집 표시 자체가 이미
        // 방송자/채팅 운영자 판정이다. 재파싱은 idempotent 라 (백필은 값이 실제로
        // 바뀔 때만 다시 그림) 루프를 만들지 않는다.
        if (isModeratorBoxEnabled() && getCollectedModeratorRow(row)) return true;

        const signalText = getMutationSignalText(row, mutation.target);
        if (isBlindRevealEnabled() && BLIND_SIGNAL_RE.test(signalText)) return true;
        if (isModeratorBoxEnabled() && ROLE_ATTR_RE.test(signalText)) return true;
        return false;
    }

    function shouldTrackChatTextMutation(mutation, row) {
        if (row?.hasAttribute(BLIND_PROCESSED_ATTR)) return true;
        // 수집된 행을 계속 추적하는 이유는 shouldTrackChatAttributeMutation 참고.
        if (isModeratorBoxEnabled() && getCollectedModeratorRow(row)) return true;

        const signalText = getMutationSignalText(row, mutation.target);
        if (isBlindRevealEnabled() && BLIND_SIGNAL_RE.test(signalText)) return true;
        if (isModeratorBoxEnabled() && ROLE_ATTR_RE.test(signalText)) return true;
        return false;
    }

    function getCollectedModeratorRow(row) {
        if (!(row instanceof Element)) return null;
        // 수집 표시는 바깥 wrapper 에 붙는데 mutation 경로의 row 는 안쪽
        // 컨테이너로 정규화될 수 있어서 조상까지 확인한다 (closest 는 자신 포함).
        const collectedRow = row.closest(`[${MODERATOR_COLLECTED_ATTR}]`);
        if (!collectedRow) return null;
        if (moderatorRowBindings.has(collectedRow)) return collectedRow;
        collectedRow.removeAttribute(MODERATOR_COLLECTED_ATTR);
        return null;
    }

    function markDirtyChatMutationTarget(mutation, rootEl, shouldTrack) {
        const row = getChatRowForNode(mutation.target, rootEl);
        if (!row || !shouldTrack(mutation, row)) return false;
        // 안쪽 컨테이너에는 본문이 없어 재파싱해도 백필로 이어지지 않으므로,
        // 수집 표시가 붙은 바깥 wrapper 가 있으면 그쪽을 dirty 에 넣는다.
        const collectedRow = getCollectedModeratorRow(row);
        const dirtyRow = collectedRow instanceof HTMLElement ? collectedRow : row;
        bumpRowMutationRevision(dirtyRow);
        dirtyChatRows.add(dirtyRow);
        chatMutationBatchShouldSchedule = true;
        return true;
    }

    function queueModeratorRemounts(bindings, addedNodes, root = chatRoot, { preserveAcrossEmptyScan = false } = {}) {
        const addedRoots = getTopLevelMutationElements(Array.from(addedNodes || []));
        if (!addedRoots.length) return;

        for (const binding of bindings) {
            if (!binding?.message || !String(binding.message.id || "").startsWith("row:")) continue;
            if (pendingModeratorRemounts.some((candidate) => candidate.message === binding.message)) continue;
            pendingModeratorRemounts.push({
                ...binding,
                root,
                addedRoots,
                preserveAcrossEmptyScan,
            });
        }
        const maxCandidates = getMaxModeratorMessages();
        if (pendingModeratorRemounts.length > maxCandidates) {
            pendingModeratorRemounts.splice(0, pendingModeratorRemounts.length - maxCandidates);
        }
    }

    function clearOriginalTextCachesInRemovedSubtree(node) {
        if (!(node instanceof Element)) return [];
        for (const row of Array.from(moderatorRowTransitions.keys())) {
            if (row === node || node.contains(row)) cancelModeratorTransition(row);
        }
        for (const [row, ownership] of moderatorTransitionOwnerships) {
            if (row === node || node.contains(row)) finalizeModeratorTransitionOwnership(row, ownership);
        }

        const boundRows = new Set();
        if (moderatorRowBindings.has(node) || node.hasAttribute(MODERATOR_COLLECTED_ATTR)) boundRows.add(node);
        for (const row of node.querySelectorAll(`[${MODERATOR_COLLECTED_ATTR}]`)) boundRows.add(row);
        const detachedBindings = [];
        for (const row of boundRows) {
            const binding = detachModeratorRowBinding(row);
            if (binding) detachedBindings.push(binding);
        }

        rowOriginalTexts.delete(node);
        for (const el of node.querySelectorAll("*")) rowOriginalTexts.delete(el);
        return detachedBindings;
    }

    function getContainingChatRow(node, rootEl) {
        const el = resolveMutationElement(node);
        if (!(el instanceof Element) || !(rootEl instanceof Element) || el === rootEl || isOwnUi(el)) return null;

        for (let current = el; current instanceof Element && current !== rootEl; current = current.parentElement) {
            const classText = getClassText(current);
            const isStructuralRow = /(^|[\s_-])(row|item)(?=$|[\s_-])/i.test(classText);
            if (!hasExplicitChatRowIdentity(current) && !isStructuralRow) continue;

            const row = normalizeCandidateRow(current, rootEl);
            if (row instanceof HTMLElement && row !== rootEl && rootEl.contains(row) && !isOwnUi(row)) return row;
            return null;
        }
        return null;
    }

    function markDirtyContainingChatRow(node, rootEl) {
        const row = getContainingChatRow(node, rootEl);
        if (!row) return false;
        bumpRowMutationRevision(row);
        dirtyChatRows.add(row);
        chatMutationBatchShouldSchedule = true;
        return true;
    }

    function getTopLevelMutationElements(nodes) {
        const elements = Array.from(
            new Set(
                nodes
                    .map((node) => resolveMutationElement(node))
                    .filter((node) => node instanceof Element && !isOwnUi(node))
            )
        );
        const elementSet = new Set(elements);
        return elements.filter((element) => {
            for (let parent = element.parentElement; parent instanceof Element; parent = parent.parentElement) {
                if (elementSet.has(parent)) return false;
            }
            return true;
        });
    }

    function collectDirtyChatRowsFromMutations(mutations) {
        chatMutationBatchShouldSchedule = false;
        const rootEl = chatRoot?.isConnected ? chatRoot : null;
        if (!(rootEl instanceof Element)) {
            requestFullChatScan({ reparse: false });
            chatMutationBatchShouldSchedule = true;
            return;
        }

        const mutationList = Array.from(mutations || []);
        const addedNodes = [];
        for (const mutation of mutationList) {
            if (mutation.type === "attributes") {
                markDirtyChatMutationTarget(mutation, rootEl, shouldTrackChatAttributeMutation);
                continue;
            }

            if (mutation.type === "characterData") {
                markDirtyChatMutationTarget(mutation, rootEl, shouldTrackChatTextMutation);
                continue;
            }

            if (mutation.type !== "childList") continue;

            const mutationAddedNodes = [];
            for (const node of mutation.addedNodes || []) {
                if (isOwnUi(node)) continue;
                addedNodes.push(node);
                mutationAddedNodes.push(node);
            }
            let removedRealNode = false;
            const detachedBindings = [];
            for (const node of mutation.removedNodes || []) {
                if (isOwnUi(node)) continue;
                removedRealNode = true;
                detachedBindings.push(...clearOriginalTextCachesInRemovedSubtree(node));
            }
            if (removedRealNode && mutationAddedNodes.length) {
                queueModeratorRemounts(detachedBindings, mutationAddedNodes);
            }
            if (removedRealNode) markDirtyContainingChatRow(mutation.target, rootEl);
        }

        for (const node of getTopLevelMutationElements(addedNodes)) markDirtyChatRow(node, rootEl);
    }

    function findChatRows(rootEl = chatRoot) {
        if (!(rootEl instanceof Element)) return [];

        const rows = new Set();
        for (const child of Array.from(rootEl.children)) {
            if (isOwnUi(child) || !getVisibleText(child)) continue;
            if (child.querySelector(CHAT_ROW_SELECTORS)) continue;
            rows.add(child);
        }

        for (const el of Array.from(rootEl.querySelectorAll(CHAT_ROW_SELECTORS))) {
            if (el === rootEl || isOwnUi(el)) continue;
            rows.add(normalizeCandidateRow(el, rootEl));
        }

        return filterNestedCandidateRows(rows, rootEl).filter((row) => {
            const text = getVisibleText(row);
            return Boolean(text || hasChatRowSignal(row));
        });
    }

    function expandDirtyChatRows(rows, rootEl) {
        const expandedRows = new Set();
        for (const candidate of rows) {
            const subtreeRows = findChatRowsInMutationSubtree(candidate, rootEl);
            if (subtreeRows.overflow) return null;
            if (subtreeRows.rows.length === 0) {
                expandedRows.add(candidate);
                continue;
            }
            for (const row of subtreeRows.rows) expandedRows.add(row);
        }
        return filterNestedCandidateRows(expandedRows, rootEl);
    }

    function findChatRoot() {
        if (typeof isLiveRoute === "function" && !isLiveRoute()) {
            lastChatRootFindResult = null;
            return null;
        }
        const now = performance.now();
        if (lastChatRootFindResult?.isConnected && now - lastChatRootFindAt < CHAT_ROOT_FIND_THROTTLE_MS) {
            return lastChatRootFindResult;
        }
        if (
            !lastChatRootFindResult &&
            lastChatRootFindAt > 0 &&
            now - lastChatRootFindAt < CHAT_ROOT_FIND_THROTTLE_MS
        ) {
            return null;
        }
        lastChatRootFindAt = now;

        for (const selector of CHAT_ROOT_SELECTORS) {
            const candidates = Array.from(document.querySelectorAll(selector)).filter((el) => {
                if (!(el instanceof HTMLElement) || isOwnUi(el)) return false;
                if (getAttr(el, "role") === "log") return true;
                return getVisibleText(el) || el.children.length > 0;
            });
            if (candidates.length) {
                lastChatRootFindResult = candidates[0];
                return lastChatRootFindResult;
            }
        }

        const rows = findChatRows(document.body).slice(0, 80);
        const counts = new Map();
        for (const row of rows) {
            const parent = row.parentElement;
            if (!parent || parent === document.body || isOwnUi(parent)) continue;
            counts.set(parent, (counts.get(parent) || 0) + 1);
        }

        let best = null;
        let bestCount = 1;
        for (const [parent, count] of counts) {
            if (count > bestCount) {
                best = parent;
                bestCount = count;
            }
        }

        lastChatRootFindResult = best;
        return lastChatRootFindResult;
    }

    function getRowsToProcess(rootEl) {
        if (forceFullChatScan) {
            const rows = findChatRows(rootEl);
            dirtyChatRows.clear();
            forceFullChatScan = false;
            if (forceReparseChatRows) {
                forceReparseChatRows = false;
                return rows;
            }
            return rows.filter((row) => !isProcessedChatRow(row));
        }

        const rows = Array.from(dirtyChatRows).filter(
            (row) => row instanceof HTMLElement && row.isConnected && row !== rootEl && rootEl.contains(row)
        );
        dirtyChatRows.clear();
        const expandedRows = expandDirtyChatRows(rows, rootEl);
        if (expandedRows) return expandedRows;
        return findChatRows(rootEl).filter((row) => !isProcessedChatRow(row));
    }

    function isProcessedChatRow(row) {
        if (!(row instanceof HTMLElement)) return false;
        if (parsedChatRows.has(row)) return true;
        if (row.hasAttribute(MODERATOR_COLLECTED_ATTR) && !moderatorRowBindings.has(row)) {
            row.removeAttribute(MODERATOR_COLLECTED_ATTR);
            removeModeratorHighlight(row);
        }
        return row.hasAttribute(BLIND_PROCESSED_ATTR) || moderatorRowBindings.has(row);
    }

    function syncChatTools() {
        if (!isFeatureEnabled()) {
            clearModeratorTransitions();
            clearModeratorTransitionOwnerships();
            pendingModeratorRemounts = [];
            return;
        }

        const rootEl = chatRoot?.isConnected ? chatRoot : findChatRoot();
        if (!rootEl) {
            clearModeratorTransitions();
            clearModeratorTransitionOwnerships();
            pendingModeratorRemounts = [];
            return;
        }
        chatRoot = rootEl;

        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        ensureModeratorBox(rootEl);

        let processedChatRows = false;
        try {
            const rows = getRowsToProcess(rootEl);
            processedChatRows = rows.length > 0;
            for (const row of rows) {
                // 닉네임 클릭 프로필 카드 등 팝업이 펼쳐진 행은 팝업 내용이 파싱을
                // 오염시키므로 팝업이 닫힌 뒤(다음 mutation)에 처리한다.
                if (row.querySelector("[aria-haspopup='true'][aria-expanded='true']")) {
                    removeModeratorHighlight(row);
                    continue;
                }
                const parsed = parseChatMessage(row);
                cacheOriginalMessageText(row, parsed);
                syncBlindReveal(row, parsed);
                collectModeratorMessage(parsed, { deferRender: true });
                parsedChatRows.add(row);
            }
        } finally {
            pendingModeratorRemounts = processedChatRows
                ? []
                : pendingModeratorRemounts.filter(
                      (candidate) =>
                          candidate.preserveAcrossEmptyScan === true && candidate.root === rootEl && rootEl.isConnected
                  );
        }

        trimModeratorMessages();
        renderModeratorList();
    }

    function adoptObservedChatRoot(node) {
        const rootChanged = chatRoot !== node;
        if (rootChanged) {
            clearModeratorTransitions();
            clearModeratorTransitionOwnerships();
            pendingModeratorRemounts = [];
        }
        const detachedBindings = [];
        for (const message of moderatorMessages) {
            const row = message.node;
            if (!(row instanceof Element)) continue;
            if (!node.contains(row)) {
                const binding = detachModeratorRowBinding(row);
                if (binding) detachedBindings.push(binding);
                continue;
            }
            if (rootChanged) {
                const binding = moderatorRowBindings.get(row);
                if (binding) binding.root = node;
            }
        }
        chatRoot = node;
        // 채팅 접기/펼치기나 플레이어 모드 전환은 목록 root를 통째로
        // 교체하면서 같은 id-less 백로그 행을 새 DOM으로 다시 만든다. 새 root의
        // 첫 full scan 안에서만 기존 binding을 후보로 넘겨 같은 메시지가 다시
        // 수집되지 않게 한다. 후보는 sync 종료 시 폐기되므로 이후 실제로 도착한
        // 동일 문구 메시지는 별도 메시지로 계속 수집된다. 단, 새 root가 빈 채로
        // 먼저 sync되면 실제 채팅 행을 처리할 첫 hydration까지 후보를 유지한다.
        if (rootChanged && detachedBindings.length) {
            queueModeratorRemounts(detachedBindings, [node], node, {
                preserveAcrossEmptyScan: true,
            });
        }
    }

    function startObserver() {
        if (observer) observer.disconnectAll?.();
        observer = createMutationObserverSync({
            target: () => (typeof isLiveRoute !== "function" || isLiveRoute() ? findChatRoot() : null),
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
                attributeFilter: CHAT_DIRTY_ATTRIBUTE_FILTER,
            },
            onMutations: collectDirtyChatRowsFromMutations,
            shouldSchedule: () => chatMutationBatchShouldSchedule,
            schedule: scheduleSync,
            onObserved: (_observer, node) => {
                adoptObservedChatRoot(node);
                requestFullChatScan({ reparse: false });
                scheduleSync();
            },
            onBodyReady: (_observer, node) => {
                adoptObservedChatRoot(node);
                requestFullChatScan({ reparse: false });
                scheduleSync();
            },
        });
    }

    function restartRuntime({ clearMessages = false } = {}) {
        if (!isFeatureEnabled()) return;
        clearModeratorTransitions();
        clearModeratorTransitionOwnerships();
        chatRoot = null;
        removeModeratorBox();
        resetChatProcessingState({ reparse: true });
        if (clearMessages) clearModeratorState();
        startObserver();
        scheduleSync();
    }

    function installRuntime() {
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        // 제거된 「방송 중 모아보기 유지」 옵션이 storage.local 에 남긴 캐시를 한 번 지운다.
        purgeLegacyModeratorCache();
        if (!observer) startObserver();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(() => restartRuntime({ clearMessages: true }));
        }
        scheduleSync();
    }

    function uninstallRuntime() {
        if (observer) {
            observer.disconnectAll?.();
            observer = null;
        }
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
        chatRoot = null;
        resetChatProcessingState({ reparse: true });
        removeInjectedUi();
    }

    function applyOptions(options) {
        featureOptions = options;
        syncWelcomeMessageRemoval();
        trimModeratorMessages();

        if (!isFeatureEnabled()) {
            uninstallRuntime();
            return;
        }

        installRuntime();
        requestFullChatScan({ reparse: true });
        if (!isModeratorBoxEnabled()) {
            clearModeratorTransitions();
            retractModeratorTransitionOwnerships({ deferRender: true });
            clearModeratorHighlights();
            removeModeratorBox();
        }
        if (!isBlindRevealEnabled()) removeAllBlindReveals();
        scheduleSync();
    }

    bindFeatureOptions(applyOptions);
    onReady(() => {
        if (isFeatureEnabled()) installRuntime();
    });

    root.chatTools = {
        parseChatMessage,
        renderModeratorBox: ensureModeratorBox,
        syncBlindReveal,
    };
})();
