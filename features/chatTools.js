/**
 * features/chatTools.js — 실시간 채팅에 블라인드 원문 보기와 방송자/채팅 운영자 모아보기를 붙인다.
 *
 * 동작 위치: 치지직 방송 시청 페이지(라이브)의 실시간 채팅 리스트 DOM.
 * 하는 일: MutationObserver 로 채팅 행을 감지해 작성자/본문/역할/블라인드 여부를 파싱한다.
 *   블라인드 처리된 메시지는 숨겨진 원문을 찾아 취소선 텍스트로 보여주고,
 *   방송자·채팅 운영자 메시지는 별도 패널에 모아 보여주는 트리거 버튼과 박스를 채팅 헤더에 삽입한다.
 *   옵션 변경(bindFeatureOptions)과 라우트 변경(startPageChangeDetection) 시 런타임을 재시작한다.
 * 의존: BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, createThrottledDomSync, injectStyleOnce, isLiveRoute, normSpace,
 *   onReady, startPageChangeDetection), chrome.storage.local(레거시 캐시 정리용).
 * 옵션 키: chatToolsEnabled, chatToolsShowBlindEnabled, chatToolsModeratorBoxEnabled,
 *   chatToolsMaxModeratorMessages.
 * DOM 마커: id=betterchzzk-chat-tools-style, data-bcct-blind-processed, data-bcct-blind-masked,
 *   data-bcct-moderator-collected, data-bcct-moderator-box, data-bcct-moderator-row,
 *   data-bcct-moderator-trigger, data-bcct-moderator-panel-host, data-bcct-moderator-actions,
 *   class bcct-blind-reveal / bcct-moderator-*.
 * 통신: root.chatTools(parseChatMessage, renderModeratorBox, syncBlindReveal)를
 *   window.BetterChzzk 에 공개해 다른 파일이 참조할 수 있게 한다.
 * 구조:
 *   1-135: 상수 — DOM 마커 attr, 채팅 root/row/본문/작성자 선택자, 역할/블라인드 판별 정규식.
 *   136-436: STYLE_TEXT — 모아보기 트리거/패널/행 CSS(다크모드 포함), injectStyleOnce 로 주입.
 *   437-475: 전역 상태(featureOptions, chatRoot, observer, moderatorMessages 등) 선언.
 *   476-1080: 채팅 행 파싱 유틸 — 작성자/본문 타겟 선택, 숨은 원문 탐색, 역할(detectRole) 판별.
 *   1081-1201: parseChatMessage 본체, 행 소유 원문 캐시와 블라인드 복원(syncBlindReveal).
 *   1202-1704: 모아보기 수집·렌더링·패널 토글과 채팅 헤더/트리거/박스 DOM 삽입.
 *   1705-2015: mutation 기반 dirty row 추적, 행 정규화와 syncChatTools 동기화 본체.
 *   2016-끝: observer 시작/재시작, install/uninstallRuntime, applyOptions, root.chatTools 공개.
 */
(() => {
    const STYLE_ID = "betterchzzk-chat-tools-style";
    const BLIND_PROCESSED_ATTR = "data-bcct-blind-processed";
    // 블라인드 문구 가림 표시. 치지직(React)이 리스트를 재렌더하면서 className 을
    // 다시 설정하면 classList.add 로 붙인 클래스는 소실되지만, React 가 관리하지
    // 않는 data 속성은 유지되므로 클래스 대신 data 속성으로 가림 상태를 표시한다.
    const BLIND_MASKED_ATTR = "data-bcct-blind-masked";
    const MODERATOR_COLLECTED_ATTR = "data-bcct-moderator-collected";
    const MODERATOR_BOX_ATTR = "data-bcct-moderator-box";
    const MODERATOR_ROW_ATTR = "data-bcct-moderator-row";
    const MODERATOR_TRIGGER_ATTR = "data-bcct-moderator-trigger";
    const MODERATOR_PANEL_HOST_ATTR = "data-bcct-moderator-panel-host";
    const MODERATOR_ACTION_GROUP_ATTR = "data-bcct-moderator-actions";
    const PLACEHOLDER_TEXT = "[블라인드 메시지: 원문 없음]";
    const MODERATOR_TITLE = "방송자/채팅 운영자 채팅";
    const ROLE_SCORE_THRESHOLD = 80;
    const DEFAULT_MAX_MODERATOR_MESSAGES = 100;
    // 제거된 「방송 중 모아보기 유지」 옵션이 남긴 이전 캐시 데이터를 지우기 위한 키.
    const MODERATOR_CACHE_STORAGE_KEY = "betterChzzkChatToolsModeratorCache";
    const CHAT_SYNC_THROTTLE_MS = 120;
    const CHAT_ROOT_FIND_THROTTLE_MS = 600;
    const MESSAGE_ID_ATTRS = ["data-chat-id", "data-message-id", "data-id"];
    const ROW_REUSE_SIGNAL_ATTR_RE = /^(?:data-(?:(?:virtual|row|item|list)-)?(?:key|index|position)|aria-posinset)$/i;
    const CHAT_DIRTY_ATTRIBUTE_FILTER = [
        "class",
        "style",
        "hidden",
        "aria-label",
        "title",
        "aria-hidden",
        ...MESSAGE_ID_ATTRS,
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
    const STYLE_TEXT = `
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
}
.bcct-moderator-row{
  display:block;
  width:100%;
  border:0;
  border-bottom:1px solid #f1f3f5;
  background:transparent;
  color:inherit;
  cursor:pointer;
  font:inherit;
  padding:7px 12px;
  text-align:left;
  transition:background-color .12s ease;
}
.bcct-moderator-row:hover{
  background:#f4fbf8;
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
    let moderatorPanelOpen = false;
    let moderatorMessages = [];
    let collectedMessageIds = new Set();
    let legacyModeratorCachePurged = false;
    const dirtyChatRows = new Set();
    let parsedChatRows = new WeakSet();
    let forceFullChatScan = true;
    let forceReparseChatRows = true;
    let chatMutationBatchShouldSchedule = false;
    let lastChatRootFindAt = 0;
    let lastChatRootFindResult = null;
    let moderatorListRenderKeys = [];
    const rowIds = new WeakMap();
    const rowOriginalTexts = new WeakMap();
    let nextRowId = 1;

    const scheduleSync = createThrottledDomSync(syncChatTools, CHAT_SYNC_THROTTLE_MS);

    function isFeatureEnabled() {
        return Boolean(featureOptions.chatToolsEnabled);
    }

    function isBlindRevealEnabled() {
        return isFeatureEnabled() && Boolean(featureOptions.chatToolsShowBlindEnabled);
    }

    function isModeratorBoxEnabled() {
        return isFeatureEnabled() && Boolean(featureOptions.chatToolsModeratorBoxEnabled);
    }

    function getMaxModeratorMessages() {
        const value = Number(featureOptions.chatToolsMaxModeratorMessages);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_MODERATOR_MESSAGES;
    }

    function isOwnUi(node) {
        const el = node instanceof Element ? node : node?.parentElement;
        return Boolean(el?.closest(`[${MODERATOR_BOX_ATTR}], .bcct-blind-reveal`));
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

    function getMessageId(row, parsed) {
        for (const attr of ID_ATTRS) {
            const value = normSpace(getAttr(row, attr));
            if (value) return `${attr}:${value}`;
        }

        if (!rowIds.has(row)) {
            const fallback = normSpace(`${parsed.role}:${parsed.author}:${parsed.text}`);
            rowIds.set(row, fallback ? `text:${fallback}` : `row:${nextRowId}`);
            nextRowId += 1;
        }

        return rowIds.get(row) || `${parsed.role}:${parsed.author}:${parsed.text}`;
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
            globalThis.chrome?.storage?.local?.remove(MODERATOR_CACHE_STORAGE_KEY);
        } catch (_) {
            // 잔존 캐시 정리는 best-effort 라 실패는 조용히 무시한다.
        }
    }

    function trimModeratorMessages() {
        const max = getMaxModeratorMessages();
        if (moderatorMessages.length <= max) return;

        const removed = moderatorMessages.splice(0, moderatorMessages.length - max);
        for (const message of removed) collectedMessageIds.delete(message.id);
    }

    function getModeratorRenderKey(message) {
        const badgeKey = (Array.isArray(message.badges) ? message.badges : [])
            .map((badge) => `${badge?.src}|${badge?.alt}`)
            .join(",");
        return [message.id, message.role, message.author, message.text, badgeKey, message.authorColor]
            .map((value) => String(value || ""))
            .join("\u001f");
    }

    function areArraysEqual(left, right) {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    function collectModeratorMessage(parsed) {
        if (!isModeratorBoxEnabled() || !parsed.role || !parsed.text) return false;
        if (collectedMessageIds.has(parsed.id)) {
            const existing = moderatorMessages.find((message) => message.id === parsed.id);
            if (existing) {
                existing.node = parsed.node;
                // 이전 버전에서 수집됐거나 구버전 캐시에서 복원된 항목은 뱃지/색상이
                // 비어 있을 수 있다. text/author/role 은 블라인드 전환 등으로 오염될 수
                // 있으니 건드리지 않고, 뱃지/색상만 재파싱 값으로 백필한다.
                let backfilled = false;
                if (parsed.role) {
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
                }
                if (backfilled) renderModeratorList();
            }
            return false;
        }

        collectedMessageIds.add(parsed.id);
        parsed.node.setAttribute(MODERATOR_COLLECTED_ATTR, "1");
        moderatorMessages.push({
            id: parsed.id,
            author: parsed.author,
            role: parsed.role,
            text: parsed.text,
            badges: Array.isArray(parsed.badges) ? parsed.badges : [],
            authorColor: parsed.authorColor || "",
            node: parsed.node,
        });
        trimModeratorMessages();
        renderModeratorList();
        return true;
    }

    function scrollToOriginalMessage(message) {
        if (!message.node?.isConnected) return;
        try {
            message.node.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch (_) {
            message.node.scrollIntoView();
        }
    }

    function buildModeratorRow(message) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "bcct-moderator-row";
        row.setAttribute(MODERATOR_ROW_ATTR, message.id);

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

        row.append(meta, text);
        row.addEventListener("click", () => scrollToOriginalMessage(message));
        return row;
    }

    function canAppendModeratorRows(nextKeys) {
        if (!moderatorListRenderKeys.length || nextKeys.length <= moderatorListRenderKeys.length) return false;
        for (let index = 0; index < moderatorListRenderKeys.length; index += 1) {
            if (nextKeys[index] !== moderatorListRenderKeys[index]) return false;
        }
        return true;
    }

    function renderModeratorList() {
        if (!moderatorList || !moderatorCount || !moderatorTriggerCount) return;

        const countText = `${moderatorMessages.length}`;
        if (moderatorCount.textContent !== countText) moderatorCount.textContent = countText;
        if (moderatorTriggerCount.textContent !== countText) moderatorTriggerCount.textContent = countText;
        moderatorTriggerCount.dataset.empty = moderatorMessages.length ? "0" : "1";
        setModeratorPanelOpen(moderatorPanelOpen);

        const renderKeys = moderatorMessages.map(getModeratorRenderKey);
        if (areArraysEqual(renderKeys, moderatorListRenderKeys)) return;
        if (canAppendModeratorRows(renderKeys)) {
            // 패널이 열려 있고 사용자가 바닥 근처를 보고 있었다면 새 메시지 append 후에도
            // 바닥으로 따라간다. 위로 스크롤해 과거를 보는 중이면 위치를 건드리지 않는다.
            const stickToBottom = moderatorPanelOpen && isModeratorListNearBottom();
            for (const message of moderatorMessages.slice(moderatorListRenderKeys.length)) {
                moderatorList.appendChild(buildModeratorRow(message));
            }
            moderatorListRenderKeys = renderKeys;
            if (stickToBottom) scrollModeratorListToBottom();
            return;
        }
        moderatorListRenderKeys = renderKeys;
        moderatorList.textContent = "";

        if (!moderatorMessages.length) {
            const empty = document.createElement("div");
            empty.className = "bcct-moderator-box__empty";
            empty.textContent = "아직 수집된 메시지가 없습니다.";
            moderatorList.appendChild(empty);
            return;
        }

        for (const message of moderatorMessages) {
            moderatorList.appendChild(buildModeratorRow(message));
        }
    }

    function isModeratorListNearBottom(threshold = 40) {
        if (!moderatorList) return false;
        const distance = moderatorList.scrollHeight - moderatorList.scrollTop - moderatorList.clientHeight;
        return distance <= threshold;
    }

    function scrollModeratorListToBottom() {
        if (!moderatorList) return;
        moderatorList.scrollTop = moderatorList.scrollHeight;
    }

    function setModeratorPanelOpen(open) {
        const wasOpen = moderatorPanelOpen;
        moderatorPanelOpen = open;
        if (!moderatorBox || !moderatorToggle) return;
        moderatorBox.dataset.open = open ? "1" : "0";
        moderatorToggle.setAttribute("aria-expanded", open ? "true" : "false");
        moderatorToggle.setAttribute(
            "aria-label",
            `${MODERATOR_TITLE} ${moderatorMessages.length}개 ${open ? "닫기" : "열기"}`
        );
        // 패널이 새로 열릴 때(닫힘→열림)만 최신 메시지가 보이도록 맨 아래로 내린다.
        // display:none 인 동안에는 scrollHeight 가 0 이라 dataset.open="1" 로 표시된
        // 뒤에 실행해야 한다.
        if (open && !wasOpen) scrollModeratorListToBottom();
    }

    function removeModeratorBox() {
        document.removeEventListener("keydown", onModeratorDocumentKeydown, true);
        const actionGroup = moderatorToggle?.closest?.(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
        if (moderatorBox) {
            moderatorBox.remove();
            moderatorBox = null;
            moderatorList = null;
            moderatorCount = null;
        }
        moderatorListRenderKeys = [];
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

    function isMenuButton(button) {
        if (!(button instanceof HTMLButtonElement) || isOwnUi(button)) return false;
        const text = buttonText(button);
        if (/더보기|메뉴|설정|more|menu|option|setting|ellipsis/i.test(text)) return true;
        return /^[\s⋮⋯…·•・]+$/.test(getVisibleText(button));
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

    function ensureModeratorBox(rootEl) {
        if (!isModeratorBoxEnabled() || !(rootEl instanceof Element)) {
            removeModeratorBox();
            return;
        }

        const panelRoot = findChatPanelRoot(rootEl);
        const header = findChatHeader(rootEl);
        const menuButton = findMenuButton(header);
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

        box.append(headerRow, list);
        host.appendChild(box);

        moderatorBox = box;
        moderatorList = list;
        moderatorCount = count;
        document.addEventListener("keydown", onModeratorDocumentKeydown, true);
        setModeratorPanelOpen(moderatorPanelOpen);
        renderModeratorList();
    }

    function removeAllBlindReveals() {
        for (const row of Array.from(document.querySelectorAll(`[${BLIND_PROCESSED_ATTR}]`))) {
            removeBlindReveal(row);
        }
    }

    function clearModeratorState() {
        for (const row of Array.from(document.querySelectorAll(`[${MODERATOR_COLLECTED_ATTR}]`))) {
            row.removeAttribute(MODERATOR_COLLECTED_ATTR);
        }
        moderatorMessages = [];
        collectedMessageIds = new Set();
        moderatorListRenderKeys = [];
        renderModeratorList();
    }

    function removeInjectedUi({ clearMessages = true } = {}) {
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
            if (MESSAGE_ID_ATTRS.some((attr) => getAttr(current, attr)) || getAttr(current, "role") === "listitem") {
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

    function resetChatProcessingState({ reparse = true } = {}) {
        dirtyChatRows.clear();
        parsedChatRows = new WeakSet();
        forceFullChatScan = true;
        forceReparseChatRows = reparse;
        chatMutationBatchShouldSchedule = false;
    }

    function requestFullChatScan({ reparse = false } = {}) {
        forceFullChatScan = true;
        if (reparse) forceReparseChatRows = true;
    }

    function resolveMutationElement(node) {
        if (node instanceof Element) return node;
        return node?.parentElement instanceof Element ? node.parentElement : null;
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
        const row = getChatRowForNode(node, rootEl);
        if (!row) return false;
        dirtyChatRows.add(row);
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
        if (MESSAGE_ID_ATTRS.includes(attrName)) return true;
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
        return row.closest(`[${MODERATOR_COLLECTED_ATTR}]`);
    }

    function markDirtyChatMutationTarget(mutation, rootEl, shouldTrack) {
        const row = getChatRowForNode(mutation.target, rootEl);
        if (!row || !shouldTrack(mutation, row)) return false;
        // 안쪽 컨테이너에는 본문이 없어 재파싱해도 백필로 이어지지 않으므로,
        // 수집 표시가 붙은 바깥 wrapper 가 있으면 그쪽을 dirty 에 넣는다.
        const collectedRow = getCollectedModeratorRow(row);
        dirtyChatRows.add(collectedRow instanceof HTMLElement ? collectedRow : row);
        chatMutationBatchShouldSchedule = true;
        return true;
    }

    function clearOriginalTextCachesInRemovedSubtree(node) {
        if (!(node instanceof Element)) return;
        rowOriginalTexts.delete(node);
        for (const el of node.querySelectorAll("*")) rowOriginalTexts.delete(el);
    }

    function collectDirtyChatRowsFromMutations(mutations) {
        chatMutationBatchShouldSchedule = false;
        const rootEl = chatRoot?.isConnected ? chatRoot : null;
        if (!(rootEl instanceof Element)) {
            requestFullChatScan({ reparse: false });
            chatMutationBatchShouldSchedule = true;
            return;
        }

        for (const mutation of mutations || []) {
            if (mutation.type === "attributes") {
                markDirtyChatMutationTarget(mutation, rootEl, shouldTrackChatAttributeMutation);
                continue;
            }

            if (mutation.type === "characterData") {
                markDirtyChatMutationTarget(mutation, rootEl, shouldTrackChatTextMutation);
                continue;
            }

            if (mutation.type !== "childList") continue;

            for (const node of mutation.addedNodes || []) {
                markDirtyChatRow(node, rootEl);
            }
            for (const node of mutation.removedNodes || []) {
                if (isOwnUi(node)) continue;
                clearOriginalTextCachesInRemovedSubtree(node);
                const el = resolveMutationElement(mutation.target);
                if (el === rootEl || markDirtyChatRow(mutation.target, rootEl)) {
                    chatMutationBatchShouldSchedule = true;
                }
                break;
            }
        }
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

        const rowList = Array.from(rows);
        const candidateRows = new Set(rowList.filter((row) => row instanceof Element));
        return rowList.filter((row) => {
            if (!(row instanceof HTMLElement) || row === rootEl || isOwnUi(row)) return false;
            if (hasCandidateAncestor(row, candidateRows, rootEl)) return false;
            const text = getVisibleText(row);
            return Boolean(text || hasChatRowSignal(row));
        });
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
        return rows;
    }

    function isProcessedChatRow(row) {
        if (!(row instanceof HTMLElement)) return false;
        if (parsedChatRows.has(row)) return true;
        return row.hasAttribute(BLIND_PROCESSED_ATTR) || row.hasAttribute(MODERATOR_COLLECTED_ATTR);
    }

    function syncChatTools() {
        if (!isFeatureEnabled()) return;

        const rootEl = chatRoot?.isConnected ? chatRoot : findChatRoot();
        if (!rootEl) return;
        chatRoot = rootEl;

        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        ensureModeratorBox(rootEl);
        if (!isBlindRevealEnabled()) removeAllBlindReveals();

        for (const row of getRowsToProcess(rootEl)) {
            // 닉네임 클릭 프로필 카드 등 팝업이 펼쳐진 행은 팝업 내용이 파싱을
            // 오염시키므로 팝업이 닫힌 뒤(다음 mutation)에 처리한다.
            if (row.querySelector("[aria-haspopup='true'][aria-expanded='true']")) continue;
            const parsed = parseChatMessage(row);
            cacheOriginalMessageText(row, parsed);
            syncBlindReveal(row, parsed);
            collectModeratorMessage(parsed);
            parsedChatRows.add(row);
        }

        trimModeratorMessages();
        renderModeratorList();
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
                chatRoot = node;
                requestFullChatScan({ reparse: false });
                scheduleSync();
            },
            onBodyReady: (_observer, node) => {
                chatRoot = node;
                requestFullChatScan({ reparse: false });
                scheduleSync();
            },
        });
    }

    function restartRuntime({ clearMessages = false } = {}) {
        if (!isFeatureEnabled()) return;
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
        trimModeratorMessages();

        if (!isFeatureEnabled()) {
            uninstallRuntime();
            return;
        }

        installRuntime();
        requestFullChatScan({ reparse: true });
        if (!isModeratorBoxEnabled()) removeModeratorBox();
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
