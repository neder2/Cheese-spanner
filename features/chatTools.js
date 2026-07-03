(() => {
    const STYLE_ID = "betterchzzk-chat-tools-style";
    const BLIND_PROCESSED_ATTR = "data-bcct-blind-processed";
    const MODERATOR_COLLECTED_ATTR = "data-bcct-moderator-collected";
    const MODERATOR_BOX_ATTR = "data-bcct-moderator-box";
    const MODERATOR_ROW_ATTR = "data-bcct-moderator-row";
    const MODERATOR_TRIGGER_ATTR = "data-bcct-moderator-trigger";
    const MODERATOR_PANEL_HOST_ATTR = "data-bcct-moderator-panel-host";
    const MODERATOR_ACTION_GROUP_ATTR = "data-bcct-moderator-actions";
    const PLACEHOLDER_TEXT = "[블라인드 메시지: 원문 없음]";
    const MODERATOR_TITLE = "방송자/매니저 채팅";
    const ROLE_SCORE_THRESHOLD = 80;
    const DEFAULT_MAX_MODERATOR_MESSAGES = 100;
    const MODERATOR_CACHE_STORAGE_KEY = "betterChzzkChatToolsModeratorCache";
    const MODERATOR_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    const MODERATOR_CACHE_MAX_ENTRIES = 12;
    const CHAT_SYNC_THROTTLE_MS = 120;
    const MODERATOR_CACHE_PERSIST_DEBOUNCE_MS = 600;
    const CHAT_ROOT_FIND_THROTTLE_MS = 600;
    const CHAT_DIRTY_ATTRIBUTE_FILTER = ["class", "style", "hidden", "aria-label", "title", "aria-hidden"];
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
    ].join(",");
    const ROLE_ATTR_RE = /방장|방송자|스트리머|streamer|owner|broadcaster|매니저|운영자|manager|moderator|\bmod\b/i;
    const BROADCASTER_RE = /방장|방송자|스트리머|streamer|owner|broadcaster/i;
    const MANAGER_RE = /매니저|운영자|manager|moderator|\bmod\b/i;
    const ROLE_CLASS_RE = /(^|[\s_-])(manager|moderator|mod|owner|streamer|broadcaster)([\s_-]|$)/i;
    const ROLE_SIGNAL_ELEMENT_RE = /badge|role|manager|moderator|owner|streamer|broadcaster/i;
    const BLIND_SIGNAL_RE = /블라인드|숨김|삭제|차단|가림|blind|hidden|deleted|blocked|moderated/i;
    const GENERIC_BLIND_TEXT_RE =
        /^(?:\[?\s*)?(블라인드|숨김|삭제|차단|가림|blind|hidden|deleted|blocked|moderated)(?:\s*(메시지|채팅|message|chat|처리|됨|되었습니다|입니다|글|내용|원문 없음|no text|unavailable))*[\]\s.:：-]*$/i;
    const CLIENT_TEXT_ATTR_RE = /message|content|text|body|comment|original/i;
    const CHAT_TITLE_RE = /chat|\uCC44\uD305/i;
    const CHAT_INPUT_RE = /input|textarea|editor|composer|write|\uC785\uB825/i;
    const PINNED_NOTICE_RE = /pin|pinned|fixed|sticky|notice|announcement|announce|\uACE0\uC815|\uACF5\uC9C0/i;
    const ID_ATTRS = ["data-chat-id", "data-message-id", "data-id", "id"];
    const STYLE_TEXT = `
.bcct-blind-reveal{
  margin-top:4px;
  padding:5px 7px;
  border:1px solid rgba(0,168,107,0.28);
  border-radius:6px;
  background:rgba(0,168,107,0.08);
  color:inherit;
  font-family:inherit;
  font-size:12px;
  line-height:17px;
  word-break:break-word;
}
.bcct-blind-reveal[data-empty="1"]{
  border-color:rgba(125,132,145,0.28);
  background:rgba(125,132,145,0.08);
  opacity:.9;
}
.bcct-blind-reveal__label{
  margin-right:6px;
  font-weight:700;
  color:#00a86b;
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
  padding:10px 12px;
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
  display:block;
  margin-bottom:4px;
  color:#00a86b;
  font-size:11px;
  font-weight:700;
  line-height:15px;
}
.bcct-moderator-row__text{
  display:block;
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
        getLiveChannelIdFromPath,
        injectStyleOnce,
        isLiveRoute,
        normSpace,
        onReady,
        startPageChangeDetection,
        storageGet,
        storageRemove,
        storageSet,
    } = root.utils;

    const storage = globalThis.chrome?.storage?.local;
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
    let moderatorCacheKey = "";
    let moderatorCacheReadyKey = "";
    let moderatorCacheLoadKey = "";
    let moderatorCacheLoadSeq = 0;
    let moderatorCachePersistTimer = 0;
    let moderatorCacheFlushListenersInstalled = false;
    const dirtyChatRows = new Set();
    let parsedChatRows = new WeakSet();
    let forceFullChatScan = true;
    let forceReparseChatRows = true;
    let chatMutationBatchShouldSchedule = false;
    let lastChatRootFindAt = 0;
    let lastChatRootFindResult = null;
    let moderatorListRenderKeys = [];
    const rowIds = new WeakMap();
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

    function isModeratorCacheEnabled() {
        return isModeratorBoxEnabled() && Boolean(featureOptions.chatToolsCacheModeratorMessagesEnabled);
    }

    function getMaxModeratorMessages() {
        const value = Number(featureOptions.chatToolsMaxModeratorMessages);
        return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_MODERATOR_MESSAGES;
    }

    function getModeratorCacheKey() {
        const channelId = typeof getLiveChannelIdFromPath === "function" ? normSpace(getLiveChannelIdFromPath()) : "";
        return channelId ? `live:${channelId}` : "";
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
        ].join(" ");
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

            if (!roleDecoration) {
                for (const attr of Array.from(el.attributes)) {
                    const name = attr.name.toLowerCase();
                    if (!CLIENT_TEXT_ATTR_RE.test(name) && name !== "aria-label" && name !== "title") continue;
                    if ((name === "aria-label" || name === "title") && !hidden && !BLIND_SIGNAL_RE.test(attr.value)) {
                        continue;
                    }
                    parseClientTextValue(attr.value, attrCandidates);
                }
            }

            if (hidden && !roleDecoration) hiddenElements.push(el);
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
        if (/badge|role|manager|moderator|owner|streamer|broadcaster|닉네임|nickname|author|name/i.test(marker)) {
            return ROLE_ATTR_RE.test(`${marker} ${getVisibleText(el, context)}`);
        }
        return false;
    }

    function getMessageText(row, context = null) {
        const candidates = getContextElements(context, row).filter((el) => {
            if (el === row || !(el instanceof Element) || !el.matches(MESSAGE_TEXT_SELECTORS)) return false;
            if (isOwnUi(el) || isRoleDecoration(el, context)) return false;
            return !isHiddenWithin(el, row, context);
        });
        let best = "";

        for (const el of candidates) {
            const text = getVisibleText(el, context);
            if (text.length > best.length) best = text;
        }

        if (best) return best;
        return getVisibleText(row, context);
    }

    function getAuthor(row, context = null) {
        const attrAuthor = normSpace(getAttr(row, "data-author-name"));
        if (attrAuthor) return attrAuthor;

        const candidates = getContextElements(context, row).filter(
            (el) => el !== row && el.matches?.(AUTHOR_SELECTORS)
        );
        for (const el of candidates) {
            if (isOwnUi(el) || isRoleDecoration(el, context) || isHiddenWithin(el, row, context)) continue;
            const dataAuthor = normSpace(getAttr(el, "data-author-name"));
            if (dataAuthor) return dataAuthor;
            const text = getVisibleText(el, context);
            if (text) return text;
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
            if (!(el instanceof Element) || isOwnUi(el) || isRoleDecoration(el, context)) continue;
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

    function isGenericBlindText(text) {
        const normalized = normSpace(text);
        if (!normalized) return true;
        if (GENERIC_BLIND_TEXT_RE.test(normalized)) return true;
        return normalized === PLACEHOLDER_TEXT;
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

    function isMessageTextElement(el, row) {
        if (!(el instanceof Element) || el === row || isAuthorCandidateElement(el)) return false;
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
            if (isGenericBlindText(text) || isRoleOnlyText(text)) continue;
            if (author && text === author) continue;
            if (visibleText && text === visibleText) continue;
            if (text.length > best.length) best = text;
        }

        return best;
    }

    function hasBlindSignal(row, hiddenText, context = null) {
        const visibleText = getVisibleText(row, context);
        if (BLIND_SIGNAL_RE.test(visibleText)) return true;
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
        const author = getAuthor(row, context);
        const text = getMessageText(row, context);
        const hiddenText = pickHiddenOriginalText(row, text, author, context);
        const isBlind = hasBlindSignal(row, hiddenText, context);
        const role = detectRole(row, context);
        const parsed = { author, role, text, isBlind, hiddenText, node: row };
        parsed.id = getMessageId(row, parsed);
        return parsed;
    }

    function removeBlindReveal(row) {
        row.querySelector(".bcct-blind-reveal")?.remove();
        row.removeAttribute(BLIND_PROCESSED_ATTR);
    }

    function syncBlindReveal(row, parsed) {
        if (!isBlindRevealEnabled() || !parsed.isBlind) {
            removeBlindReveal(row);
            return;
        }

        const text = parsed.hiddenText || PLACEHOLDER_TEXT;
        let reveal = row.querySelector(".bcct-blind-reveal");
        if (!reveal) {
            reveal = document.createElement("div");
            reveal.className = "bcct-blind-reveal";

            const label = document.createElement("span");
            label.className = "bcct-blind-reveal__label";
            label.textContent = "블라인드 원문";

            const body = document.createElement("span");
            body.className = "bcct-blind-reveal__text";

            reveal.append(label, body);
            row.appendChild(reveal);
        }

        reveal.dataset.empty = parsed.hiddenText ? "0" : "1";
        reveal.querySelector(".bcct-blind-reveal__text").textContent = text;
        row.setAttribute(BLIND_PROCESSED_ATTR, "1");
    }

    function roleLabel(role) {
        return role === "broadcaster" ? "방송자" : "매니저";
    }

    function normalizeCachedMessage(message) {
        if (!message || typeof message !== "object") return null;
        const role = message.role === "broadcaster" || message.role === "manager" ? message.role : "";
        const text = normSpace(message.text).slice(0, 1000);
        if (!role || !text) return null;

        const author = normSpace(message.author).slice(0, 120);
        const id = normSpace(message.id).slice(0, 500) || normSpace(`${role}:${author}:${text}`).slice(0, 500);
        if (!id) return null;

        return { id, author, role, text, node: null };
    }

    function serializeModeratorMessages() {
        return moderatorMessages.map(normalizeCachedMessage).filter(Boolean);
    }

    function normalizeModeratorCacheStore(raw, now = Date.now()) {
        const entries = raw?.entries && typeof raw.entries === "object" ? raw.entries : {};
        const rows = [];

        for (const [key, entry] of Object.entries(entries)) {
            const savedAt = Number(entry?.savedAt) || 0;
            const expiresAt = Number(entry?.expiresAt) || 0;
            if (!key || !expiresAt || expiresAt <= now) continue;

            const messages = Array.isArray(entry?.messages)
                ? entry.messages.map(normalizeCachedMessage).filter(Boolean)
                : [];
            if (!messages.length) continue;

            rows.push([key, { savedAt, expiresAt, messages }]);
        }

        rows.sort((a, b) => b[1].savedAt - a[1].savedAt);
        return {
            version: 1,
            entries: Object.fromEntries(rows.slice(0, MODERATOR_CACHE_MAX_ENTRIES)),
        };
    }

    async function readModeratorCacheStore() {
        if (!storage || typeof storageGet !== "function") return normalizeModeratorCacheStore({});

        try {
            const data = await storageGet(storage, MODERATOR_CACHE_STORAGE_KEY, {});
            return normalizeModeratorCacheStore(data?.[MODERATOR_CACHE_STORAGE_KEY]);
        } catch (_) {
            return normalizeModeratorCacheStore({});
        }
    }

    function mergeCachedModeratorMessages(messages) {
        let added = false;
        for (const message of messages || []) {
            const normalized = normalizeCachedMessage(message);
            if (!normalized || collectedMessageIds.has(normalized.id)) continue;
            collectedMessageIds.add(normalized.id);
            moderatorMessages.push(normalized);
            added = true;
        }
        if (added) trimModeratorMessages();
        return added;
    }

    async function persistModeratorCache({ cacheKey: cacheKeySnapshot = "", messages: messageSnapshot = null } = {}) {
        if (!isModeratorCacheEnabled()) return;

        const cacheKey = cacheKeySnapshot || getModeratorCacheKey();
        if (!cacheKey || moderatorCacheReadyKey !== cacheKey || !storage || typeof storageSet !== "function") return;

        const now = Date.now();
        const messages = Array.isArray(messageSnapshot)
            ? messageSnapshot
            : serializeModeratorMessages().slice(-getMaxModeratorMessages());
        const store = await readModeratorCacheStore();

        if (messages.length) {
            store.entries[cacheKey] = {
                savedAt: now,
                expiresAt: now + MODERATOR_CACHE_MAX_AGE_MS,
                messages,
            };
        } else {
            delete store.entries[cacheKey];
        }

        try {
            await storageSet(storage, {
                [MODERATOR_CACHE_STORAGE_KEY]: normalizeModeratorCacheStore(store, now),
            });
        } catch (_) {
            // Cache persistence is best-effort; the live UI should keep working if storage fails.
        }
    }

    function cancelModeratorCachePersist() {
        if (!moderatorCachePersistTimer) return;
        clearTimeout(moderatorCachePersistTimer);
        moderatorCachePersistTimer = 0;
    }

    function getModeratorCachePersistSnapshot() {
        return {
            cacheKey: getModeratorCacheKey(),
            messages: serializeModeratorMessages().slice(-getMaxModeratorMessages()),
        };
    }

    function scheduleModeratorCachePersist() {
        if (!isModeratorCacheEnabled()) {
            cancelModeratorCachePersist();
            return;
        }
        if (moderatorCachePersistTimer) return;
        moderatorCachePersistTimer = setTimeout(() => {
            moderatorCachePersistTimer = 0;
            persistModeratorCache();
        }, MODERATOR_CACHE_PERSIST_DEBOUNCE_MS);
    }

    function flushModeratorCachePersist() {
        if (!moderatorCachePersistTimer) return;
        const snapshot = getModeratorCachePersistSnapshot();
        cancelModeratorCachePersist();
        persistModeratorCache(snapshot);
    }

    function handleModeratorCacheFlushEvent(event) {
        if (event?.type === "visibilitychange" && !document.hidden) return;
        flushModeratorCachePersist();
    }

    function installModeratorCacheFlushListeners() {
        if (moderatorCacheFlushListenersInstalled) return;
        moderatorCacheFlushListenersInstalled = true;
        window.addEventListener("pagehide", handleModeratorCacheFlushEvent, true);
        document.addEventListener("visibilitychange", handleModeratorCacheFlushEvent, true);
    }

    function uninstallModeratorCacheFlushListeners() {
        if (!moderatorCacheFlushListenersInstalled) return;
        moderatorCacheFlushListenersInstalled = false;
        window.removeEventListener("pagehide", handleModeratorCacheFlushEvent, true);
        document.removeEventListener("visibilitychange", handleModeratorCacheFlushEvent, true);
    }

    async function clearModeratorCacheStore() {
        cancelModeratorCachePersist();
        moderatorCacheKey = "";
        moderatorCacheReadyKey = "";
        moderatorCacheLoadKey = "";

        if (!storage || typeof storageRemove !== "function") return;
        try {
            await storageRemove(storage, MODERATOR_CACHE_STORAGE_KEY);
        } catch (_) {
            // Ignore storage cleanup failures for the same reason as persistence failures.
        }
    }

    function ensureModeratorCacheLoaded() {
        if (!isModeratorCacheEnabled()) {
            moderatorCacheKey = "";
            moderatorCacheReadyKey = "";
            moderatorCacheLoadKey = "";
            return;
        }

        const cacheKey = getModeratorCacheKey();
        if (!cacheKey) return;

        if (cacheKey !== moderatorCacheKey) {
            moderatorCacheKey = cacheKey;
            moderatorCacheReadyKey = "";
            moderatorCacheLoadKey = "";
        }

        if (moderatorCacheReadyKey === cacheKey || moderatorCacheLoadKey === cacheKey) return;

        const seq = moderatorCacheLoadSeq + 1;
        moderatorCacheLoadSeq = seq;
        moderatorCacheLoadKey = cacheKey;

        readModeratorCacheStore()
            .then((store) => {
                if (seq !== moderatorCacheLoadSeq || moderatorCacheKey !== cacheKey) return;

                mergeCachedModeratorMessages(store.entries?.[cacheKey]?.messages || []);
                moderatorCacheReadyKey = cacheKey;
                moderatorCacheLoadKey = "";
                trimModeratorMessages();
                renderModeratorList();
                scheduleModeratorCachePersist();
            })
            .catch(() => {
                if (seq !== moderatorCacheLoadSeq || moderatorCacheKey !== cacheKey) return;
                moderatorCacheReadyKey = cacheKey;
                moderatorCacheLoadKey = "";
            });
    }

    function trimModeratorMessages() {
        const max = getMaxModeratorMessages();
        if (moderatorMessages.length <= max) return;

        const removed = moderatorMessages.splice(0, moderatorMessages.length - max);
        for (const message of removed) collectedMessageIds.delete(message.id);
    }

    function getModeratorRenderKey(message) {
        return [message.id, message.role, message.author, message.text]
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
            if (existing) existing.node = parsed.node;
            return false;
        }

        collectedMessageIds.add(parsed.id);
        parsed.node.setAttribute(MODERATOR_COLLECTED_ATTR, "1");
        moderatorMessages.push({
            id: parsed.id,
            author: parsed.author,
            role: parsed.role,
            text: parsed.text,
            node: parsed.node,
        });
        trimModeratorMessages();
        renderModeratorList();
        scheduleModeratorCachePersist();
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
        meta.textContent = message.author ? `${roleLabel(message.role)} · ${message.author}` : roleLabel(message.role);

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
            for (const message of moderatorMessages.slice(moderatorListRenderKeys.length)) {
                moderatorList.appendChild(buildModeratorRow(message));
            }
            moderatorListRenderKeys = renderKeys;
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

    function setModeratorPanelOpen(open) {
        moderatorPanelOpen = open;
        if (!moderatorBox || !moderatorToggle) return;
        moderatorBox.dataset.open = open ? "1" : "0";
        moderatorToggle.setAttribute("aria-expanded", open ? "true" : "false");
        moderatorToggle.setAttribute(
            "aria-label",
            `${MODERATOR_TITLE} ${moderatorMessages.length}개 ${open ? "닫기" : "열기"}`
        );
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
        cancelModeratorCachePersist();
        for (const row of Array.from(document.querySelectorAll(`[${MODERATOR_COLLECTED_ATTR}]`))) {
            row.removeAttribute(MODERATOR_COLLECTED_ATTR);
        }
        moderatorMessages = [];
        collectedMessageIds = new Set();
        moderatorListRenderKeys = [];
        moderatorCacheReadyKey = "";
        moderatorCacheLoadKey = "";
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
        let current = el;
        for (let depth = 0; current && current !== rootEl && depth < 4; depth += 1, current = current.parentElement) {
            if (!(current instanceof Element)) break;
            if (getAttr(current, "data-chat-id") || getAttr(current, "data-message-id")) return current;
            if (/\b(row|item|message|chat)\b/i.test(getClassText(current)) && getVisibleText(current)) return current;
        }
        return el;
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
        const candidate = closestRow && rootEl.contains(closestRow) ? closestRow : el;
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
        if (row?.hasAttribute(BLIND_PROCESSED_ATTR)) return true;

        const signalText = getMutationSignalText(row, mutation.target);
        if (isBlindRevealEnabled() && BLIND_SIGNAL_RE.test(signalText)) return true;
        if (isModeratorBoxEnabled() && !row?.hasAttribute(MODERATOR_COLLECTED_ATTR) && ROLE_ATTR_RE.test(signalText)) {
            return true;
        }
        return false;
    }

    function shouldTrackChatTextMutation(mutation, row) {
        if (row?.hasAttribute(BLIND_PROCESSED_ATTR)) return true;

        const signalText = getMutationSignalText(row, mutation.target);
        if (isBlindRevealEnabled() && BLIND_SIGNAL_RE.test(signalText)) return true;
        if (isModeratorBoxEnabled() && !row?.hasAttribute(MODERATOR_COLLECTED_ATTR) && ROLE_ATTR_RE.test(signalText)) {
            return true;
        }
        return false;
    }

    function markDirtyChatMutationTarget(mutation, rootEl, shouldTrack) {
        const row = getChatRowForNode(mutation.target, rootEl);
        if (!row || !shouldTrack(mutation, row)) return false;
        dirtyChatRows.add(row);
        chatMutationBatchShouldSchedule = true;
        return true;
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
            if (!isOwnUi(child) && getVisibleText(child)) rows.add(child);
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
        ensureModeratorCacheLoaded();
        if (!isBlindRevealEnabled()) removeAllBlindReveals();

        for (const row of getRowsToProcess(rootEl)) {
            const parsed = parseChatMessage(row);
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
        if (clearMessages) {
            flushModeratorCachePersist();
            clearModeratorState();
        }
        startObserver();
        scheduleSync();
    }

    function installRuntime() {
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
        installModeratorCacheFlushListeners();
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
        flushModeratorCachePersist();
        uninstallModeratorCacheFlushListeners();
        chatRoot = null;
        resetChatProcessingState({ reparse: true });
        removeInjectedUi();
    }

    function applyOptions(options) {
        const cacheWasEnabled = Boolean(featureOptions.chatToolsCacheModeratorMessagesEnabled);
        featureOptions = options;
        trimModeratorMessages();
        if (isModeratorCacheEnabled()) scheduleModeratorCachePersist();
        else {
            cancelModeratorCachePersist();
            moderatorCacheKey = "";
            moderatorCacheReadyKey = "";
            moderatorCacheLoadKey = "";
        }

        if (cacheWasEnabled && !featureOptions.chatToolsCacheModeratorMessagesEnabled) {
            clearModeratorCacheStore();
        }

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
