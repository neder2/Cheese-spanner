/** 행 정체성, 블라인드 원문 캐시, 운영자 메시지와 재사용 안정화 상태를 소유한다.
 * isolated world. 의존: chatTools.parser, utils.normSpace.
 * createMessageStore는 개별 root·행 binding·timer를 캡슐화한다.
 * onChange에는 DOM 참조가 없는 불변 스냅샷을 보내고, 읽음·원본 이동은 명령으로 받는다.
 * recordId는 기존 message 객체의 정체성을 대신해 같은 네이티브 ID가 재등장해도 구분한다.
 */
(() => {
    "use strict";
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const namespace = (root.chatTools = root.chatTools || {});
    const parser = namespace.parser;
    const { normSpace } = root.utils;
    const {
        MODERATOR_COLLECTED_ATTR,
        MODERATOR_HIGHLIGHT_ATTR,
        MODERATOR_HIGHLIGHT_COLOR,
        MESSAGE_ID_ATTRS,
        getAttr,
        isBlindNoticeText,
        getCacheMessageIdentity,
        getCacheRowReuseSignal,
    } = namespace.parser;
    const DEFAULT_MAX_MODERATOR_MESSAGES = 100;
    const MAX_ORIGINAL_MESSAGES = 500;

    const MODERATOR_REUSE_STABILITY_CHECK_MS = 100;

    const MODERATOR_REUSE_REQUIRED_STABLE_PASSES = 2;

    const ID_ATTRS = [...MESSAGE_ID_ATTRS, "id"];

    namespace.createMessageStore = function createMessageStore({ onChange = () => {} } = {}) {
        let chatRoot = null;
        let moderatorEnabled = true;
        let maxModeratorMessages = DEFAULT_MAX_MODERATOR_MESSAGES;
        let moderatorMessages = [];
        let moderatorRowBindings = new WeakMap();
        let pendingModeratorRemounts = [];
        const moderatorRowTransitions = new Map();
        const moderatorTransitionOwnerships = new Map();
        let rowMutationRevisions = new WeakMap();
        const rowIds = new WeakMap();
        let rowOriginalTexts = new WeakMap();
        // Same-root remounts may reuse an explicit message ID. Keep only text and identity,
        // never detached DOM nodes, and discard this bounded cache with the root/session.
        const originalMessages = new Map();

        function clearOriginalMessages() {
            rowOriginalTexts = new WeakMap();
            originalMessages.clear();
        }
        let nextRowId = 1;
        let nextModeratorTransitionId = 1;
        let nextRecordId = 1;

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

        function cacheOriginalMessageText(row, parsed) {
            if (parsed.isBlind || !parsed.text || isBlindNoticeText(parsed.text)) return;
            const rowReuseSignal = getCacheRowReuseSignal(row);
            const cached = rowOriginalTexts.get(row);
            const identity = getCacheMessageIdentity(row, parsed.textEl);
            if (
                cached &&
                (cached.rowReuseSignal !== rowReuseSignal || cached.identity !== identity) &&
                cached.author === parsed.author &&
                cached.sourceTextEl === parsed.textEl &&
                cached.text === parsed.text
            ) {
                // 재사용 표식만 먼저 바뀐 행을 기존 메시지 상태로 다시 파싱해도
                // 낡은 원문을 새 행 소유 캐시로 덮어쓰지 않는다.
                rowOriginalTexts.delete(row);
                if (cached.identity) originalMessages.delete(cached.identity);
                return;
            }
            if (identity && parsed.author) {
                originalMessages.delete(identity);
                originalMessages.set(identity, { author: parsed.author, rowReuseSignal, text: parsed.text });
                if (originalMessages.size > MAX_ORIGINAL_MESSAGES) {
                    originalMessages.delete(originalMessages.keys().next().value);
                }
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
            const identity = getCacheMessageIdentity(row, parsed.textEl);
            if (!cached) {
                const original = identity && originalMessages.get(identity);
                return original &&
                    original.author === parsed.author &&
                    original.rowReuseSignal === getCacheRowReuseSignal(row)
                    ? original.text
                    : "";
            }
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
                if (cached.identity) originalMessages.delete(cached.identity);
                return "";
            }

            return cached.text;
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

        function retractModeratorTransitionOwnerships({ deferNotify = false } = {}) {
            const messages = new Set(
                Array.from(moderatorTransitionOwnerships.values(), (ownership) => ownership.message).filter(Boolean)
            );
            let removed = false;
            for (const message of messages) {
                removed = removeModeratorMessage(message, { deferNotify: true }) || removed;
            }
            if (removed && !deferNotify) publish();
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
            if (row.style.getPropertyValue(MODERATOR_HIGHLIGHT_COLOR))
                row.style.removeProperty(MODERATOR_HIGHLIGHT_COLOR);
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

        function removeModeratorMessage(message, { deferNotify = false } = {}) {
            const messageIndex = moderatorMessages.indexOf(message);
            if (messageIndex < 0) return false;

            moderatorMessages.splice(messageIndex, 1);

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

            if (!deferNotify) publish();
            return true;
        }

        function evictModeratorMessageForCapacity(message) {
            const messageIndex = moderatorMessages.indexOf(message);
            if (messageIndex < 0) return false;

            moderatorMessages.splice(messageIndex, 1);
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

        function backfillModeratorMessage(existing, parsed, { deferNotify = false } = {}) {
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
            if (backfilled && !deferNotify) publish();
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

        function commitModeratorMessage(parsed, { deferNotify = false, transition = null } = {}) {
            if (!isModeratorBoxEnabled() || !parsed.role || !parsed.text) return false;

            let message = moderatorMessages.find((item) => item.id === parsed.id);
            if (!message) message = takeModeratorRemount(parsed);
            const added = !message;
            if (message) {
                backfillModeratorMessage(message, parsed, { deferNotify });
            } else {
                message = {
                    id: parsed.id,
                    recordId: nextRecordId++,
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
                if (!deferNotify) publish();
            }
            return added;
        }

        function scheduleModeratorTransitionCheck(row, transition) {
            if (transition.timerId !== null) clearTimeout(transition.timerId);
            transition.timerId = setTimeout(
                () => confirmReusedModeratorCandidate(row),
                MODERATOR_REUSE_STABILITY_CHECK_MS
            );
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

        function collectModeratorMessage(parsed, { deferNotify = false } = {}) {
            const row = parsed.node;
            let binding = moderatorRowBindings.get(row);
            if (binding && isSameBoundModeratorMessage(binding, parsed)) {
                cancelModeratorTransition(row);
                backfillModeratorMessage(binding.message, parsed, { deferNotify });
                row.setAttribute(MODERATOR_COLLECTED_ATTR, "1");
                syncModeratorHighlight(parsed);
                return false;
            }

            const ownership = moderatorTransitionOwnerships.get(row);
            if (ownership && binding?.message !== ownership.message) {
                removeModeratorMessage(ownership.message, { deferNotify });
                binding = moderatorRowBindings.get(row);
            } else if (ownership) {
                const disposition = getModeratorTransitionDisposition(ownership, parsed);
                if (disposition === "retract") {
                    removeModeratorMessage(ownership.message, { deferNotify });
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
            return commitModeratorMessage(parsed, { deferNotify });
        }

        function scrollToOriginalMessage(messageId, recordId) {
            const message = moderatorMessages.find((item) => item.id === messageId);
            if (!message || message.recordId !== recordId) return;
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

        function clearModeratorState() {
            clearOriginalMessages();
            clearModeratorTransitions();
            clearModeratorTransitionOwnerships();
            clearModeratorHighlights();
            for (const row of Array.from(document.querySelectorAll(`[${MODERATOR_COLLECTED_ATTR}]`))) {
                row.removeAttribute(MODERATOR_COLLECTED_ATTR);
            }
            moderatorMessages = [];
            moderatorRowBindings = new WeakMap();
            pendingModeratorRemounts = [];
            rowMutationRevisions = new WeakMap();
            publish();
        }

        function bumpRowMutationRevision(row) {
            if (!(row instanceof HTMLElement)) return 0;
            const next = (rowMutationRevisions.get(row) || 0) + 1;
            rowMutationRevisions.set(row, next);
            return next;
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

        function queueModeratorRemounts(
            bindings,
            addedNodes,
            root = chatRoot,
            { preserveAcrossEmptyScan = false } = {}
        ) {
            const addedRoots = Array.from(addedNodes || []);
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

        function adoptObservedChatRoot(node) {
            const rootChanged = chatRoot !== node;
            if (rootChanged) {
                clearOriginalMessages();
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

        function removeSubtrees(removedNodes, addedRoots) {
            const detachedBindings = [];
            for (const node of removedNodes) {
                detachedBindings.push(...clearOriginalTextCachesInRemovedSubtree(node));
            }
            if (addedRoots.length) queueModeratorRemounts(detachedBindings, addedRoots);
        }

        function parseChatMessage(row) {
            const parsed = parser.parseChatRow(row);
            parsed.id = getMessageId(row, parsed);
            return parsed;
        }

        function publish() {
            // 패널에는 DOM binding을 노출하지 않는다. 화면의 읽음 변경은 markRead로만 반영한다.
            onChange(
                moderatorMessages.map((message) =>
                    Object.freeze({
                        id: message.id,
                        recordId: message.recordId,
                        author: message.author,
                        role: message.role,
                        text: message.text,
                        badges: Object.freeze(message.badges.map((badge) => Object.freeze({ ...badge }))),
                        authorColor: message.authorColor,
                        timestamp: message.timestamp,
                        unread: message.unread,
                    })
                )
            );
        }

        function markRead(messageIds) {
            const ids = new Set(messageIds);
            let changed = false;
            for (const message of moderatorMessages) {
                if (!message.unread || !ids.has(message.id)) continue;
                message.unread = false;
                changed = true;
            }
            if (changed) publish();
        }

        function cancelPending() {
            clearModeratorTransitions();
            clearModeratorTransitionOwnerships();
            pendingModeratorRemounts = [];
        }

        function resetRoot() {
            clearOriginalMessages();
            cancelPending();
            chatRoot = null;
        }

        function configure({ enabled, maximum }) {
            moderatorEnabled = enabled === true;
            maxModeratorMessages = Number.isFinite(maximum) && maximum > 0 ? maximum : DEFAULT_MAX_MODERATOR_MESSAGES;
            trimModeratorMessages();
            if (!moderatorEnabled) {
                clearModeratorTransitions();
                retractModeratorTransitionOwnerships({ deferNotify: true });
                clearModeratorHighlights();
            }
            publish();
        }

        function finishScan(processedRows) {
            pendingModeratorRemounts = processedRows
                ? []
                : pendingModeratorRemounts.filter(
                      (candidate) =>
                          candidate.preserveAcrossEmptyScan === true &&
                          candidate.root === chatRoot &&
                          chatRoot?.isConnected
                  );
            trimModeratorMessages();
            publish();
        }

        function isModeratorBoxEnabled() {
            return moderatorEnabled;
        }
        function getMaxModeratorMessages() {
            return maxModeratorMessages;
        }

        return {
            parseChatMessage,
            collect: collectModeratorMessage,
            cacheOriginal: cacheOriginalMessageText,
            clearOriginals: clearOriginalMessages,
            originalText: lookupCachedOriginalText,
            removeHighlight: removeModeratorHighlight,
            collectedRow: getCollectedModeratorRow,
            noteMutation: bumpRowMutationRevision,
            removeSubtrees,
            adoptRoot: adoptObservedChatRoot,
            clear: clearModeratorState,
            configure,
            finishScan,
            cancelPending,
            resetRoot,
            markRead,
            navigate: scrollToOriginalMessage,
            hasBinding: (row) => moderatorRowBindings.has(row),
            clearRemounts: () => {
                pendingModeratorRemounts = [];
            },
        };
    };
})();
