/**
 * features/rewardAutoCollect.js — 채팅 사이드바의 통나무 수령 버튼과 서버가 제공한 비시청 claim을 자동 수집한다.
 *
 * 동작 위치: chzzk.naver.com 전역 중 aside#aside-chatting(채팅 사이드바) 내부.
 * 하는 일:
 *   - aside#aside-chatting 하위에서 실측된 시청 보상 알림과 보상 창 수령 버튼만 클릭한다.
 *     문구만 비슷한 채팅·랭킹·프로필 버튼은 허용하지 않는다.
 *   - 구독/팔로우/로그인/결제 등(BLOCKED_ACTION_RE)에 해당하면 즉시 제외해 오클릭을 막는다.
 *   - 가장 점수가 높은 버튼을 지연 후 클릭하고, 보상 상태 서명당 한 번만 실행해 중복 클릭을 막는다.
 *   - MutationObserver를 채팅 aside에만 연결하고, 변경된 버튼 후보만 모아 증분 검사한다.
 *   - 라이브 채널의 log-power claim 목록을 주기적으로 확인하고 WATCH_1_HOUR를 제외한 claim만 API로 수령한다.
 *     1시간 시청 보상은 치지직이 표시한 버튼을 통해서만 수령한다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, normSpace, startPageChangeDetection).
 * 옵션 키: rewardAutoCollectEnabled.
 * DOM 마커: data-bcra-clicked(현재 보상 상태의 클릭 완료 표시 attribute).
 */
(() => {
    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions, createMutationObserverSync, normSpace, startPageChangeDetection } = BetterChzzk.utils;

    const CLICKED_ATTR = "data-bcra-clicked";
    const SCAN_ROOT_SELECTOR = "aside#aside-chatting";
    const CANDIDATE_SELECTOR = 'button, [role="button"], a[href]';
    const SCAN_THROTTLE_MS = 250;
    const COMPLETED_SIGNATURE_RELEASE_MS = 750;
    const MAX_COMPLETED_SIGNATURES = 32;
    const MAX_COMPLETED_API_CLAIMS = 64;
    const CLICK_DELAY_MS = 800;
    const API_CLAIM_POLL_MS = 30000;
    const WATCH_CLAIM_TYPE = "WATCH_1_HOUR";
    const LOG_POWER_API_ORIGIN = "https://api.chzzk.naver.com";
    const ANCESTOR_STATE_ATTRIBUTES = new Set([
        "class",
        "style",
        "aria-disabled",
        "aria-hidden",
        "disabled",
        "hidden",
        "inert",
    ]);

    const WATCH_REWARD_ROW_SIGNAL_RE = /^(?:1시간|60분)(?:라이브)?시청(?:후)?(?:보상|인증)$/;
    const WATCH_NOTICE_LABEL_RE = /^\d+시간시청통나무파워배달완료!$/;
    const WATCH_NOTICE_BUTTON_RE = /^\d+시간시청통나무파워배달완료!\d[\d,.]*받기$/;
    const POWER_AMOUNT_BUTTON_RE = /^\d[\d,.]*파워$/;
    const BLOCKED_ACTION_RE =
        /구독|팔로우|로그인|결제|쿠폰|선물|기프트|후원|충전|구매|subscribe|follow|login|payment|pay|coupon|gift|present|donate|donation|purchase|membership/;

    let featureOptions = normalizeOptions();
    let domObserver = null;
    let removePageChangeDetection = null;
    let scanRoot = null;
    let scanTimer = 0;
    let fullScanRequested = true;
    let apiPollTimer = 0;
    let apiCheckTimer = 0;
    let apiCheckInFlight = false;
    let apiRequestGeneration = 0;
    let apiAbortController = null;
    let apiChannelId = null;
    const dirtyCandidates = new Set();
    const knownRewardCandidates = new Set();
    const pendingClicks = new Map();
    const completedSignatures = new Map();
    const completedApiClaims = new Set();

    function compactSignal(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[\s_-]+/g, "");
    }

    function isEnabled() {
        return featureOptions.rewardAutoCollectEnabled === true;
    }

    function getElementText(el) {
        return normSpace(el?.textContent || "");
    }

    function getAttributeSignal(el) {
        if (!(el instanceof Element)) return "";

        const parts = [];
        for (const name of el.getAttributeNames?.() || []) {
            const value = el.getAttribute(name);
            if (value) parts.push(`${name} ${value}`);
        }

        return normSpace(parts.join(" "));
    }

    function isUsableButton(el) {
        if (!(el instanceof HTMLElement)) return false;
        if (!el.isConnected) return false;
        if (el.disabled === true || el.hasAttribute("disabled")) return false;
        if (el.closest('[aria-disabled="true"], [aria-hidden="true"], [disabled], [hidden], [inert]')) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
    }

    function hasClassPrefix(el, prefix) {
        return Array.from(el.classList).some((name) => name.startsWith(prefix));
    }

    function getWatchRewardRowSignal(el) {
        const row = el?.parentElement;
        if (row?.tagName !== "LI" || row.parentElement?.tagName !== "UL" || !row.closest('[role="alertdialog"]'))
            return "";
        const labels = Array.from(row.children).filter((child) => child.tagName === "SPAN");
        if (labels.length !== 1) return "";
        return compactSignal(getElementText(labels[0]));
    }

    function isWatchRewardPowerButton(el, ownCompact) {
        return (
            hasClassPrefix(el, "_button_") &&
            POWER_AMOUNT_BUTTON_RE.test(ownCompact) &&
            WATCH_REWARD_ROW_SIGNAL_RE.test(getWatchRewardRowSignal(el))
        );
    }

    function isWatchRewardNoticeButton(el, ownCompact) {
        if (!WATCH_NOTICE_BUTTON_RE.test(ownCompact) || !hasClassPrefix(el, "_button_")) return false;
        const children = Array.from(el.children);
        // Recorded watch-reward notice: direct label span, power SVG, then amount/claim text.
        // Match semantic class prefixes, not the deployment-specific CSS hash or line suffix.
        return (
            children.length === 2 &&
            children[0].tagName === "SPAN" &&
            hasClassPrefix(children[0], "_text_") &&
            WATCH_NOTICE_LABEL_RE.test(compactSignal(getElementText(children[0]))) &&
            children[1].localName === "svg" &&
            (hasClassPrefix(children[1], "_icon_power_") || hasClassPrefix(children[1], "icon_power_"))
        );
    }

    function scoreRewardButton(el) {
        const ownText = getElementText(el);
        const ownCompact = compactSignal(`${ownText} ${getAttributeSignal(el)}`);
        const ownTextCompact = compactSignal(ownText);
        // Only the two recorded native button structures are authorized for automatic collection.
        // Recheck here at click time as React may reuse a previously valid node.
        if (
            el.tagName !== "BUTTON" ||
            el.getAttribute("type") !== "button" ||
            el.hasAttribute("aria-haspopup") ||
            el.hasAttribute("aria-expanded") ||
            hasClassPrefix(el, "_ranking_button_") ||
            BLOCKED_ACTION_RE.test(ownCompact) ||
            (!isWatchRewardNoticeButton(el, ownTextCompact) && !isWatchRewardPowerButton(el, ownTextCompact))
        ) {
            knownRewardCandidates.delete(el);
            return 0;
        }
        knownRewardCandidates.add(el);
        if (!isUsableButton(el)) return 0;
        return 6;
    }

    function getLiveChannelId() {
        const match = String(location.pathname || "").match(/^\/live\/([\w-]+)/);
        return match ? match[1] : null;
    }

    function getLogPowerUrl(channelId) {
        return `${LOG_POWER_API_ORIGIN}/service/v1/channels/${encodeURIComponent(channelId)}/log-power`;
    }

    function getClaimUrl(channelId, claimId) {
        return `${getLogPowerUrl(channelId)}/claims/${encodeURIComponent(claimId)}`;
    }

    function rememberCompletedApiClaim(key) {
        completedApiClaims.delete(key);
        completedApiClaims.add(key);
        while (completedApiClaims.size > MAX_COMPLETED_API_CLAIMS) {
            completedApiClaims.delete(completedApiClaims.values().next().value);
        }
    }

    function isCurrentApiRequest(generation, channelId) {
        return (
            isEnabled() &&
            generation === apiRequestGeneration &&
            channelId === apiChannelId &&
            channelId === getLiveChannelId()
        );
    }

    async function collectAvailableApiClaims() {
        if (!isEnabled() || apiCheckInFlight) return;
        const channelId = getLiveChannelId();
        if (!channelId) return;

        if (apiChannelId !== channelId) {
            apiChannelId = channelId;
            completedApiClaims.clear();
        }

        const generation = apiRequestGeneration;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        apiAbortController = controller;
        apiCheckInFlight = true;

        try {
            const response = await fetch(getLogPowerUrl(channelId), {
                credentials: "include",
                signal: controller?.signal,
            });
            if (!response?.ok) return;

            const data = await response.json();
            if (!isCurrentApiRequest(generation, channelId)) return;
            const claims = Array.isArray(data?.content?.claims) ? data.content.claims : [];
            const attemptedClaimIds = new Set();

            for (const claim of claims) {
                if (!isCurrentApiRequest(generation, channelId)) return;
                if (String(claim?.claimType || "").toUpperCase() === WATCH_CLAIM_TYPE) continue;
                if (claim?.claimId === null || claim?.claimId === undefined) continue;

                const claimId = String(claim.claimId);
                if (!claimId || attemptedClaimIds.has(claimId)) continue;
                attemptedClaimIds.add(claimId);

                const claimKey = `${channelId}:${claimId}`;
                if (completedApiClaims.has(claimKey)) continue;

                const claimResponse = await fetch(getClaimUrl(channelId, claimId), {
                    method: "PUT",
                    credentials: "include",
                    signal: controller?.signal,
                });
                if (!isCurrentApiRequest(generation, channelId)) return;
                if (claimResponse?.ok) rememberCompletedApiClaim(claimKey);
            }
        } catch (error) {
            if (error?.name !== "AbortError") return;
        } finally {
            if (generation === apiRequestGeneration) {
                apiCheckInFlight = false;
                apiAbortController = null;
            }
        }
    }

    function scheduleApiClaimCheck() {
        if (!isEnabled() || apiCheckTimer || apiCheckInFlight || !getLiveChannelId()) return;
        apiCheckTimer = window.setTimeout(() => {
            apiCheckTimer = 0;
            void collectAvailableApiClaims();
        }, 0);
    }

    function syncApiChannel() {
        const channelId = getLiveChannelId();
        if (apiChannelId !== channelId) {
            apiRequestGeneration += 1;
            apiAbortController?.abort();
            apiAbortController = null;
            apiCheckInFlight = false;
            apiChannelId = channelId;
            completedApiClaims.clear();
        }
        scheduleApiClaimCheck();
    }

    function startApiCollection() {
        syncApiChannel();
        if (apiPollTimer) return;
        apiPollTimer = window.setInterval(scheduleApiClaimCheck, API_CLAIM_POLL_MS);
    }

    function stopApiCollection() {
        apiRequestGeneration += 1;
        apiAbortController?.abort();
        apiAbortController = null;
        apiCheckInFlight = false;

        if (apiCheckTimer) window.clearTimeout(apiCheckTimer);
        if (apiPollTimer) window.clearInterval(apiPollTimer);
        apiCheckTimer = 0;
        apiPollTimer = 0;
        apiChannelId = null;
        completedApiClaims.clear();
    }

    function getScanRoot() {
        const root = document.querySelector(SCAN_ROOT_SELECTOR);
        return root instanceof HTMLElement && root.isConnected ? root : null;
    }

    function getFullCandidateList(root = scanRoot) {
        if (!(root instanceof HTMLElement) || !root.isConnected) return [];
        return Array.from(root.querySelectorAll(CANDIDATE_SELECTOR));
    }

    function findRewardButtons(candidates, root = scanRoot) {
        if (!(root instanceof HTMLElement) || !root.isConnected) return [];
        const matches = [];

        for (const candidate of candidates || []) {
            if (!(candidate instanceof HTMLElement) || !root.contains(candidate)) continue;
            const score = scoreRewardButton(candidate);
            if (score > 0) matches.push({ button: candidate, score });
        }

        matches.sort((left, right) => right.score - left.score);
        return matches.map(({ button }) => button);
    }

    function getButtonSignature(button) {
        const context = normSpace(location.pathname || "/").slice(0, 120);
        const stateSignal = normSpace(
            `${getElementText(button)} ${button.getAttribute("aria-label") || ""} ${getWatchRewardRowSignal(button)}`
        );
        return `${context}@${compactSignal(stateSignal).slice(0, 180)}`;
    }

    function clearCompletedSignatureState(state) {
        if (state?.releaseTimerId) window.clearTimeout(state.releaseTimerId);
    }

    function clearCompletedSignatures() {
        for (const state of completedSignatures.values()) clearCompletedSignatureState(state);
        completedSignatures.clear();
    }

    function hasCompletedSignature(signature, button) {
        const state = completedSignatures.get(signature);
        if (!state) return false;
        if (button instanceof HTMLElement) {
            state.button = button;
            clearCompletedSignatureState(state);
            state.releaseTimerId = 0;
        }
        completedSignatures.delete(signature);
        completedSignatures.set(signature, state);
        return true;
    }

    function rememberCompletedSignature(signature, button) {
        clearCompletedSignatureState(completedSignatures.get(signature));
        completedSignatures.delete(signature);
        completedSignatures.set(signature, { button, releaseTimerId: 0 });
        while (completedSignatures.size > MAX_COMPLETED_SIGNATURES) {
            const oldestSignature = completedSignatures.keys().next().value;
            clearCompletedSignatureState(completedSignatures.get(oldestSignature));
            completedSignatures.delete(oldestSignature);
        }
    }

    function isCompletedSignaturePresent(signature, state, root) {
        return (
            state?.button instanceof HTMLElement &&
            root instanceof HTMLElement &&
            root.contains(state.button) &&
            getButtonSignature(state.button) === signature &&
            isUsableButton(state.button)
        );
    }

    function refreshCompletedSignatureLifetimes(root = scanRoot) {
        const activeRoot = root?.isConnected ? root : getScanRoot();

        for (const [signature, state] of completedSignatures) {
            if (isCompletedSignaturePresent(signature, state, activeRoot)) {
                clearCompletedSignatureState(state);
                state.releaseTimerId = 0;
                continue;
            }
            if (state.releaseTimerId) continue;

            state.releaseTimerId = window.setTimeout(() => {
                state.releaseTimerId = 0;
                if (completedSignatures.get(signature) !== state) return;
                const currentRoot = scanRoot?.isConnected ? scanRoot : getScanRoot();
                if (isCompletedSignaturePresent(signature, state, currentRoot)) return;
                completedSignatures.delete(signature);
            }, COMPLETED_SIGNATURE_RELEASE_MS);
        }
    }

    function clickRewardButton(button, signature) {
        if (!isEnabled() || !(button instanceof HTMLElement)) return false;
        const root = scanRoot?.isConnected ? scanRoot : getScanRoot();
        if (!(root instanceof HTMLElement) || !root.contains(button)) return false;
        if (getButtonSignature(button) !== signature) {
            scheduleClick(button);
            return false;
        }
        if (hasCompletedSignature(signature, button)) return true;
        if (scoreRewardButton(button) <= 0) return false;

        button.click();
        button.setAttribute(CLICKED_ATTR, "1");
        rememberCompletedSignature(signature, button);
        return true;
    }

    function scheduleClick(button) {
        const signature = getButtonSignature(button);
        if (!signature) return;
        if (hasCompletedSignature(signature, button)) return;

        const pending = pendingClicks.get(signature);
        if (pending) {
            pending.button = button;
            return;
        }

        const state = { button, timeoutId: 0 };
        state.timeoutId = window.setTimeout(() => {
            pendingClicks.delete(signature);
            if (!clickRewardButton(state.button, signature)) requestFullScan();
        }, CLICK_DELAY_MS);
        pendingClicks.set(signature, state);
    }

    function scanRewardButtons() {
        if (!isEnabled()) return;
        const root = scanRoot?.isConnected ? scanRoot : getScanRoot();
        if (!(root instanceof HTMLElement)) return;
        if (root !== scanRoot) {
            scanRoot = root;
            fullScanRequested = true;
            knownRewardCandidates.clear();
        }
        pruneKnownRewardCandidates(root);

        const candidates = fullScanRequested ? getFullCandidateList(root) : Array.from(dirtyCandidates);
        fullScanRequested = false;
        dirtyCandidates.clear();

        for (const button of findRewardButtons(candidates, root)) scheduleClick(button);
    }

    function scheduleScan() {
        if (!isEnabled() || scanTimer) return;
        scanTimer = window.setTimeout(() => {
            scanTimer = 0;
            scanRewardButtons();
        }, SCAN_THROTTLE_MS);
    }

    function requestFullScan(root = scanRoot) {
        if (root instanceof HTMLElement) scanRoot = root;
        fullScanRequested = true;
        scheduleScan();
    }

    function hasReplaceableCompletedSignature(root = scanRoot) {
        for (const state of completedSignatures.values()) {
            if (
                state.releaseTimerId ||
                !(state.button instanceof HTMLElement) ||
                !(root instanceof HTMLElement) ||
                !root.contains(state.button)
            ) {
                return true;
            }
        }
        return false;
    }

    function rememberDirtyCandidate(candidate, root = scanRoot, rebindCompleted = false) {
        if (!(candidate instanceof HTMLElement) || !(root instanceof HTMLElement) || !root.contains(candidate)) {
            return false;
        }
        dirtyCandidates.add(candidate);
        if (!rebindCompleted) return false;
        const signature = getButtonSignature(candidate);
        return Boolean(signature && hasCompletedSignature(signature, candidate));
    }

    function addDirtyCandidatesFromNode(node, root = scanRoot, includeDescendants = false, rebindCompleted = false) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!(element instanceof Element) || !(root instanceof HTMLElement) || !root.contains(element)) return false;
        let reboundCompleted = false;

        if (element.matches(CANDIDATE_SELECTOR)) {
            reboundCompleted = rememberDirtyCandidate(element, root, rebindCompleted) || reboundCompleted;
        }

        const closest = element.closest(CANDIDATE_SELECTOR);
        reboundCompleted = rememberDirtyCandidate(closest, root, rebindCompleted) || reboundCompleted;

        if (includeDescendants) {
            for (const candidate of element.querySelectorAll?.(CANDIDATE_SELECTOR) || []) {
                reboundCompleted = rememberDirtyCandidate(candidate, root, rebindCompleted) || reboundCompleted;
            }
        }

        return reboundCompleted;
    }

    function pruneKnownRewardCandidates(root = scanRoot) {
        for (const candidate of knownRewardCandidates) {
            if (!(candidate instanceof HTMLElement) || !(root instanceof HTMLElement) || !root.contains(candidate)) {
                knownRewardCandidates.delete(candidate);
            }
        }
    }

    function addKnownRewardCandidatesInside(element, root = scanRoot) {
        if (!(element instanceof Element) || !(root instanceof HTMLElement)) return;
        for (const candidate of knownRewardCandidates) {
            if (root.contains(candidate) && element.contains(candidate)) dirtyCandidates.add(candidate);
        }
    }

    function mutationsTouchCompletedState(mutations, root = scanRoot) {
        if (completedSignatures.size === 0) return false;
        for (const state of completedSignatures.values()) {
            if (
                !(state.button instanceof HTMLElement) ||
                !(root instanceof HTMLElement) ||
                !root.contains(state.button)
            ) {
                return true;
            }
        }

        for (const mutation of mutations || []) {
            const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
            if (!(target instanceof Element)) continue;

            for (const state of completedSignatures.values()) {
                const button = state.button;
                if (!(button instanceof HTMLElement)) return true;
                if (mutation.type === "attributes" && (target.contains(button) || button.contains(target))) return true;
                if (mutation.type === "characterData" && button.contains(target)) return true;
                if (mutation.type === "childList" && (target === button || button.contains(target))) return true;
            }
        }

        return false;
    }

    function collectDirtyCandidates(mutations) {
        const root = scanRoot?.isConnected ? scanRoot : null;
        if (!(root instanceof HTMLElement)) return;
        const rebindCompleted = hasReplaceableCompletedSignature(root);
        let reboundCompleted = false;

        for (const mutation of mutations || []) {
            if (mutation.type === "characterData" || mutation.type === "attributes") {
                reboundCompleted =
                    addDirtyCandidatesFromNode(mutation.target, root, false, rebindCompleted) || reboundCompleted;
                if (mutation.type === "attributes" && ANCESTOR_STATE_ATTRIBUTES.has(mutation.attributeName)) {
                    addKnownRewardCandidatesInside(mutation.target, root);
                }
                continue;
            }
            if (mutation.type !== "childList") continue;

            if (mutation.target instanceof Element && mutation.target.matches(CANDIDATE_SELECTOR)) {
                reboundCompleted =
                    addDirtyCandidatesFromNode(mutation.target, root, false, rebindCompleted) || reboundCompleted;
            }
            for (const node of mutation.addedNodes || []) {
                reboundCompleted = addDirtyCandidatesFromNode(node, root, true, rebindCompleted) || reboundCompleted;
            }
        }

        pruneKnownRewardCandidates(root);
        if (reboundCompleted || mutationsTouchCompletedState(mutations, root)) {
            refreshCompletedSignatureLifetimes(root);
        }
    }

    function observeScanRoot(_observer, node) {
        if (!(node instanceof HTMLElement)) return;
        dirtyCandidates.clear();
        knownRewardCandidates.clear();
        refreshCompletedSignatureLifetimes(node);
        requestFullScan(node);
    }

    function clearPendingClicks() {
        for (const state of pendingClicks.values()) window.clearTimeout(state.timeoutId);
        pendingClicks.clear();
    }

    function handlePageChange() {
        clearPendingClicks();
        dirtyCandidates.clear();
        requestFullScan();
        syncApiChannel();
    }

    function startObserver() {
        if (!removePageChangeDetection) removePageChangeDetection = startPageChangeDetection(handlePageChange);
        if (domObserver) {
            requestFullScan();
            return;
        }

        domObserver = createMutationObserverSync({
            target: getScanRoot,
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
                attributeFilter: [
                    "class",
                    "style",
                    "aria-label",
                    "aria-haspopup",
                    "aria-expanded",
                    "aria-disabled",
                    "aria-hidden",
                    "disabled",
                    "hidden",
                    "inert",
                    "title",
                    "role",
                    "type",
                ],
            },
            onMutations: collectDirtyCandidates,
            shouldSchedule: () => dirtyCandidates.size > 0,
            schedule: scheduleScan,
            onObserved: observeScanRoot,
            onBodyReady: observeScanRoot,
        });
    }

    function stopObserver() {
        domObserver?.disconnectAll?.();
        domObserver?.disconnect?.();
        domObserver = null;
        removePageChangeDetection?.();
        removePageChangeDetection = null;

        if (scanTimer) window.clearTimeout(scanTimer);
        scanTimer = 0;
        scanRoot = null;
        fullScanRequested = true;
        dirtyCandidates.clear();
        knownRewardCandidates.clear();

        clearPendingClicks();
        clearCompletedSignatures();
    }

    function applyOptions(options) {
        featureOptions = options;

        if (!isEnabled()) {
            stopObserver();
            stopApiCollection();
            return;
        }

        // 기본값이 이미 true여도 observer를 반드시 설치한다. startObserver는 멱등이다.
        startObserver();
        startApiCollection();
    }

    bindFeatureOptions(applyOptions);
})();
