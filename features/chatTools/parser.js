/** 채팅 행에서 현재 작성자·본문·역할·원문 후보를 읽는 DOM 파서. 수집 상태는 보관하지 않는다.
 * isolated world. 의존: utils.normSpace, 현재 DOM과 computed style.
 * parseChatRow의 파싱 캐시는 호출 내에서만 사용하며 행 ID·수집 여부는 messageStore가 결정한다.
 * runtime·store·panel이 함께 쓰는 DOM 마커와 읽기 전용 DOM 판별 함수도 여기에서 공개한다.
 */
(() => {
    "use strict";
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const namespace = (root.chatTools = root.chatTools || {});
    const { normSpace } = root.utils;
    // React가 className을 다시 설정해도 유지되는 data 속성으로 원문 표시 상태를 연결한다.
    const BLIND_MASKED_ATTR = "data-bcct-blind-masked";

    const MODERATOR_COLLECTED_ATTR = "data-bcct-moderator-collected";

    const MODERATOR_HIGHLIGHT_ATTR = "data-bcct-moderator-highlight";

    const MODERATOR_HIGHLIGHT_COLOR = "--bcct-moderator-highlight-color";

    const MODERATOR_BOX_ATTR = "data-bcct-moderator-box";

    const MODERATOR_TRIGGER_ATTR = "data-bcct-moderator-trigger";

    const MODERATOR_ACTION_GROUP_ATTR = "data-bcct-moderator-actions";

    const CHAT_TIMESTAMP_ATTR = "data-bcmt-time";

    const CHAT_TIMESTAMP_VALUE_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

    const PLACEHOLDER_TEXT = "[블라인드 메시지: 원문 없음]";

    const ROLE_SCORE_THRESHOLD = 80;

    const MESSAGE_ID_ATTRS = ["data-chat-id", "data-message-id", "data-id"];

    const ROW_REUSE_SIGNAL_ATTR_RE = /^(?:data-(?:(?:virtual|row|item|list)-)?(?:key|index|position)|aria-posinset)$/i;

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

    function isOwnUi(node) {
        const el = node instanceof Element ? node : node?.parentElement;
        return Boolean(
            el?.closest(
                `[${MODERATOR_BOX_ATTR}], [${MODERATOR_TRIGGER_ATTR}], [${MODERATOR_ACTION_GROUP_ATTR}], #betterchzzk-multiview-chat-settings, .bcct-blind-reveal`
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
            if (isBlindNoticeText(text)) continue;
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

    function roleLabel(role) {
        return role === "broadcaster" ? "방송자" : "채팅 운영자";
    }

    function resolveMutationElement(node) {
        if (node instanceof Element) return node;
        return node?.parentElement instanceof Element ? node.parentElement : null;
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

    function parseChatRow(row) {
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
        return parsed;
    }

    namespace.parser = Object.freeze({
        BLIND_MASKED_ATTR,
        MODERATOR_COLLECTED_ATTR,
        MODERATOR_HIGHLIGHT_ATTR,
        MODERATOR_HIGHLIGHT_COLOR,
        MODERATOR_BOX_ATTR,
        MODERATOR_TRIGGER_ATTR,
        MODERATOR_ACTION_GROUP_ATTR,
        CHAT_TIMESTAMP_VALUE_RE,
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
        getCacheMessageIdentity,
        getCacheRowReuseSignal,
        roleLabel,
        resolveMutationElement,
        getTopLevelMutationElements,
        parseChatRow,
    });
})();
