/** 채팅 기능의 옵션·SPA·observer 수명주기와 dirty 행 처리를 연결한다.
 * isolated world: parser → messageStore → panel → chatTools.js 순서로 로드한다.
 * 원본 DOM 변경을 store에 전달하고, 패널에는 store의 불변 스냅샷만 넘긴다.
 * 외부 계약: BetterChzzk.chatTools.parseChatMessage / renderModeratorBox / syncBlindReveal.
 * 옵션은 bindFeatureOptions, SPA는 startPageChangeDetection으로 동기화한다.
 * chrome.storage.local에는 제거된 모아보기 캐시의 정리 요청만 보낸다.
 */
(() => {
    "use strict";
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const namespace = (root.chatTools = root.chatTools || {});
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        injectStyleOnce,
        isLiveRoute,
        onReady,
        startPageChangeDetection,
    } = root.utils;
    const {
        BLIND_MASKED_ATTR,
        MODERATOR_COLLECTED_ATTR,
        MESSAGE_ID_ATTRS,
        ROLE_ATTR_RE,
        BLIND_SIGNAL_RE,
        CHAT_TIMESTAMP_ATTR,
        isOwnUi,
        getAttr,
        getClassText,
        getElementAttrText,
        getVisibleText,
        isBlindNoticeText,
        resolveMutationElement,
        getTopLevelMutationElements,
    } = namespace.parser;
    const WELCOME_MESSAGE_STYLE_ID = "betterchzzk-chat-welcome-message-style";

    const BLIND_PROCESSED_ATTR = "data-bcct-blind-processed";

    const MODERATOR_CACHE_STORAGE_KEY = "betterChzzkChatToolsModeratorCache";

    const CHAT_SYNC_THROTTLE_MS = 120;

    const CHAT_ROOT_FIND_THROTTLE_MS = 600;

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

    // 2026-09-06 실측: _fixed_는 고정 메시지·미션 UI, _exist_fixed_message_는 목록 전체다.
    const NATIVE_FIXED_CHAT_SELECTOR = "#aside-chatting [class^='_fixed_'], #aside-chatting [class*=' _fixed_']";

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

    // 큰 가상 목록 subtree는 전체 스캔 경로로 넘겨 wrapper를 메시지로 수집하지 않는다.
    const MAX_MUTATION_SUBTREE_ELEMENTS = 512;

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

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let chatRoot = null;
    let observer = null;
    let removePageChangeDetection = null;
    let legacyModeratorCachePurged = false;
    const dirtyChatRows = new Set();
    let parsedChatRows = new WeakMap();
    let forceFullChatScan = true;
    let forceReparseChatRows = true;
    let chatMutationBatchShouldSchedule = false;
    let lastChatRootFindAt = 0;
    let lastChatRootFindResult = null;

    const scheduleSync = createThrottledDomSync(syncChatTools, CHAT_SYNC_THROTTLE_MS);
    const panel = namespace.createPanel({
        onNavigate: (id, recordId) => store.navigate(id, recordId),
        onRead: (ids) => store.markRead(ids),
        onRequestSync: scheduleSync,
    });
    const store = namespace.createMessageStore({ onChange: (messages) => panel.render(messages) });
    const {
        parseChatMessage,
        collect: collectModeratorMessage,
        cacheOriginal: cacheOriginalMessageText,
        originalText: lookupCachedOriginalText,
        removeHighlight: removeModeratorHighlight,
        collectedRow: getCollectedModeratorRow,
        noteMutation: bumpRowMutationRevision,
    } = store;
    const { remove: removeModeratorBox } = panel;

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

    function removeAllBlindReveals() {
        for (const row of Array.from(document.querySelectorAll(`[${BLIND_PROCESSED_ATTR}]`))) {
            removeBlindReveal(row);
        }
    }

    function removeInjectedUi({ clearMessages = true } = {}) {
        store.cancelPending();
        removeAllBlindReveals();
        removeModeratorBox();
        if (clearMessages) clearModeratorState();
        panel.removeStyles();
    }

    function hasChatRowSignal(el) {
        const marker = getElementAttrText(el);
        return /chat|message|comment|채팅|댓글|blind|hidden|deleted|blocked|manager|moderator|owner|streamer/i.test(
            marker
        );
    }

    function normalizeCandidateRow(el, rootEl) {
        if (el.closest(NATIVE_FIXED_CHAT_SELECTOR)) return null;
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
        parsedChatRows = new WeakMap();
        store.clearRemounts();
        forceFullChatScan = true;
        forceReparseChatRows = reparse;
        chatMutationBatchShouldSchedule = false;
    }

    function requestFullChatScan({ reparse = false } = {}) {
        forceFullChatScan = true;
        if (reparse) forceReparseChatRows = true;
    }

    function findChatRowsInMutationSubtree(node, rootEl = chatRoot) {
        const el = resolveMutationElement(node);
        if (!(el instanceof Element) || !(rootEl instanceof Element) || el === rootEl) {
            return { rows: [], overflow: false };
        }
        if (!rootEl.contains(el) || isOwnUi(el)) return { rows: [], overflow: false };
        if (el.closest(NATIVE_FIXED_CHAT_SELECTOR)) return { rows: [], overflow: false };

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
        // 배지가 먼저 붙고 빈 본문 텍스트 노드가 나중에 채워지면 아직 수집 binding이 없다.
        // img alt는 textContent에 없으므로 직전 파싱의 역할도 변경 추적에 사용한다.
        if (isModeratorBoxEnabled() && parsedChatRows.get(row)) return true;

        const signalText = getMutationSignalText(row, mutation.target);
        if (isBlindRevealEnabled() && BLIND_SIGNAL_RE.test(signalText)) return true;
        if (isModeratorBoxEnabled() && ROLE_ATTR_RE.test(signalText)) return true;
        return false;
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
            const removedNodes = [];
            for (const node of mutation.removedNodes || []) {
                if (isOwnUi(node)) continue;
                removedNodes.push(node);
            }
            if (removedNodes.length) {
                store.removeSubtrees(removedNodes, getTopLevelMutationElements(mutationAddedNodes));
                markDirtyContainingChatRow(mutation.target, rootEl);
            }
        }

        for (const node of getTopLevelMutationElements(addedNodes)) markDirtyChatRow(node, rootEl);
    }

    function findChatRows(rootEl = chatRoot) {
        if (!(rootEl instanceof Element)) return [];

        const rows = new Set();
        for (const child of Array.from(rootEl.children)) {
            if (isOwnUi(child) || !getVisibleText(child)) continue;
            if (child.closest(NATIVE_FIXED_CHAT_SELECTOR)) continue;
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
        if (row.hasAttribute(MODERATOR_COLLECTED_ATTR) && !store.hasBinding(row)) {
            row.removeAttribute(MODERATOR_COLLECTED_ATTR);
            removeModeratorHighlight(row);
        }
        return row.hasAttribute(BLIND_PROCESSED_ATTR) || store.hasBinding(row);
    }

    function syncChatTools() {
        if (!isFeatureEnabled()) {
            store.cancelPending();
            return;
        }

        const rootEl = chatRoot?.isConnected ? chatRoot : findChatRoot();
        if (!rootEl) {
            store.cancelPending();
            return;
        }
        if (chatRoot !== rootEl) adoptObservedChatRoot(rootEl);

        panel.installStyles();
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
                collectModeratorMessage(parsed, { deferNotify: true });
                parsedChatRows.set(row, parsed.role);
            }
        } finally {
            store.finishScan(processedChatRows);
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
        chatRoot = null;
        store.resetRoot();
        removeModeratorBox();
        resetChatProcessingState({ reparse: true });
        if (clearMessages) clearModeratorState();
        startObserver();
        scheduleSync();
    }

    function installRuntime() {
        panel.installStyles();
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
        store.resetRoot();
        resetChatProcessingState({ reparse: true });
        removeInjectedUi();
    }

    function applyOptions(options) {
        featureOptions = options;
        syncWelcomeMessageRemoval();
        store.configure({ enabled: isModeratorBoxEnabled(), maximum: Number(options.chatToolsMaxModeratorMessages) });
        panel.configure({ showTimestamp: options.chatTimestampEnabled });

        if (!isFeatureEnabled()) {
            uninstallRuntime();
            return;
        }

        installRuntime();
        requestFullChatScan({ reparse: true });
        if (!isModeratorBoxEnabled()) {
            removeModeratorBox();
        }
        if (!isBlindRevealEnabled()) removeAllBlindReveals();
        scheduleSync();
    }

    function clearModeratorState() {
        store.clear();
        panel.reset();
    }

    function adoptObservedChatRoot(node) {
        chatRoot = node;
        store.adoptRoot(node);
    }

    function ensureModeratorBox(rootEl) {
        if (!isModeratorBoxEnabled()) panel.remove();
        else panel.mount(rootEl);
    }

    bindFeatureOptions(applyOptions);
    onReady(() => {
        if (isFeatureEnabled()) installRuntime();
    });
    Object.assign(namespace, { parseChatMessage, renderModeratorBox: ensureModeratorBox, syncBlindReveal });
})();
