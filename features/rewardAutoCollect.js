/**
 * features/rewardAutoCollect.js — 채팅 사이드바(aside)의 보상(통나무 등) 수집 버튼을 자동으로 클릭한다.
 *
 * 동작 위치: chzzk.naver.com 전역 중 aside#aside-chatting(채팅 사이드바) 내부.
 * 하는 일:
 *   - aside#aside-chatting 하위의 button/[role="button"]/a[href] 후보를 스캔해 텍스트·속성·조상 문맥에서
 *     보상 신호(TARGET_REWARD_SIGNAL_RE)와 수집 동작(CLAIM_ACTION_RE)을 동시에 만족하는 요소만 점수화한다.
 *   - 구독/팔로우/로그인/결제 등(BLOCKED_ACTION_RE)에 해당하면 즉시 제외해 오클릭을 막는다.
 *   - 가장 점수가 높은 버튼을 찾으면 지연 후 클릭하고, data-bcra-clicked 마커와 서명별 쿨다운으로 중복 클릭을 막는다.
 *   - MutationObserver로 후보 셀렉터에 닿는 변화만 걸러 스캔을 재예약한다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, createThrottledDomSync, isVisible, normSpace).
 * 옵션 키: rewardAutoCollectEnabled, rewardAutoCollectDelayMs.
 * DOM 마커: data-bcra-clicked(클릭 완료 표시 attribute).
 */
(() => {
    const { normalizeOptions } = BetterChzzkSettings;
    const { bindFeatureOptions, createMutationObserverSync, createThrottledDomSync, isVisible, normSpace } =
        BetterChzzk.utils;

    const CLICKED_ATTR = "data-bcra-clicked";
    const SCAN_ROOT_SELECTOR = "aside#aside-chatting";
    const CANDIDATE_SELECTOR = 'button, [role="button"], a[href]';
    const SCAN_THROTTLE_MS = 250;
    const CLICK_COOLDOWN_MS = 10_000;
    const DEFAULT_DELAY_MS = 800;
    const MAX_CONTEXT_TEXT_LENGTH = 360;
    const MAX_CONTEXT_DEPTH = 4;
    const MAX_PATH_DEPTH = 6;

    const TARGET_REWARD_SIGNAL_RE = /통나무|timber|wood|rewardlog|logreward|claimlog|logclaim|collectlog|logcollect/;
    const CLAIM_ACTION_RE = /받기|수집|획득|claim|collect|receive/;
    const BUTTON_LIKE_ANCHOR_RE = /button|btn|claim|collect|reward/;
    const BLOCKED_ACTION_RE =
        /구독|팔로우|로그인|결제|쿠폰|선물|기프트|후원|충전|구매|subscribe|follow|login|payment|pay|coupon|gift|present|donate|donation|purchase|membership/;

    let featureOptions = normalizeOptions();
    let domObserver = null;
    const pendingClicks = new Map();
    const lastClickedSignatures = new Map();

    function compactSignal(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/[\s_-]+/g, "");
    }

    function getNow() {
        if (typeof performance?.now === "function") return performance.now();
        return Date.now();
    }

    function isEnabled() {
        return featureOptions.rewardAutoCollectEnabled === true;
    }

    function getDelayMs() {
        const delay = Number(featureOptions.rewardAutoCollectDelayMs);
        if (!Number.isFinite(delay)) return DEFAULT_DELAY_MS;
        return Math.min(Math.max(Math.round(delay), 0), 5000);
    }

    function getElementText(el) {
        return normSpace(el.innerText || el.textContent || "");
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

    function collectSignals(el) {
        const ownText = getElementText(el);
        const ownSignal = normSpace(`${ownText} ${getAttributeSignal(el)}`);
        const contextParts = [ownSignal];

        let node = el.parentElement;
        for (let depth = 0; node && node !== document.body && depth < MAX_CONTEXT_DEPTH; depth += 1) {
            const text = getElementText(node);
            if (text && text.length <= MAX_CONTEXT_TEXT_LENGTH) contextParts.push(text);
            const attrs = getAttributeSignal(node);
            if (attrs) contextParts.push(attrs);
            node = node.parentElement;
        }

        return {
            ownText,
            ownCompact: compactSignal(ownSignal),
            contextCompact: compactSignal(contextParts.join(" ")),
        };
    }

    function isButtonLikeAnchor(anchor, ownCompact) {
        if (anchor.getAttribute("role") === "button") return true;
        if (BUTTON_LIKE_ANCHOR_RE.test(ownCompact)) return true;

        const href = normSpace(anchor.getAttribute("href") || "");
        return href === "#" || href.toLowerCase().startsWith("javascript:");
    }

    function isAllowedCandidateElement(el, ownCompact) {
        if (!(el instanceof HTMLElement)) return false;

        const tagName = el.tagName.toLowerCase();
        if (tagName === "button") return true;
        if (el.getAttribute("role") === "button") return true;
        if (tagName === "a") return isButtonLikeAnchor(el, ownCompact);
        return false;
    }

    function isUsableButton(el) {
        if (!(el instanceof HTMLElement)) return false;
        if (!el.isConnected) return false;
        if (el.getAttribute(CLICKED_ATTR) === "1") return false;
        if (el.disabled === true || el.hasAttribute("disabled")) return false;
        if (el.closest('[aria-disabled="true"], [disabled], [inert]')) return false;
        if (getComputedStyle(el).pointerEvents === "none") return false;
        return isVisible(el);
    }

    function scoreRewardButton(el) {
        const signals = collectSignals(el);
        if (!isAllowedCandidateElement(el, signals.ownCompact)) return 0;
        if (!isUsableButton(el)) return 0;
        if (BLOCKED_ACTION_RE.test(signals.ownCompact)) return 0;

        // Keep this intentionally narrow: generic "받기" buttons are not enough.
        if (!TARGET_REWARD_SIGNAL_RE.test(signals.contextCompact)) return 0;
        if (!CLAIM_ACTION_RE.test(signals.ownCompact)) return 0;

        let score = 1;
        if (TARGET_REWARD_SIGNAL_RE.test(signals.ownCompact)) score += 5;
        else score += 3;
        if (/claim|collect|receive/.test(signals.ownCompact)) score += 2;
        return score;
    }

    function getScanRoots() {
        return Array.from(document.querySelectorAll(SCAN_ROOT_SELECTOR)).filter(
            (root) => root instanceof HTMLElement && root.isConnected
        );
    }

    function findRewardButton() {
        let bestButton = null;
        let bestScore = 0;

        for (const root of getScanRoots()) {
            for (const candidate of root.querySelectorAll(CANDIDATE_SELECTOR)) {
                const score = scoreRewardButton(candidate);
                if (score > bestScore) {
                    bestButton = candidate;
                    bestScore = score;
                }
            }
        }

        return bestButton;
    }

    function getElementPath(el) {
        const parts = [];
        let node = el;

        for (
            let depth = 0;
            node && node instanceof Element && node !== document.body && depth < MAX_PATH_DEPTH;
            depth += 1
        ) {
            const tagName = node.tagName.toLowerCase();
            const id = node.id ? `#${compactSignal(node.id).slice(0, 40)}` : "";
            const classPart = Array.from(node.classList || [])
                .slice(0, 3)
                .map((className) => `.${compactSignal(className).slice(0, 24)}`)
                .join("");
            const siblings = node.parentElement
                ? Array.from(node.parentElement.children).filter((child) => child.tagName === node.tagName)
                : [];
            const index = siblings.length > 1 ? `:nth-${siblings.indexOf(node) + 1}` : "";
            parts.unshift(`${tagName}${id}${classPart}${index}`);
            node = node.parentElement;
        }

        return parts.join(">");
    }

    function getButtonSignature(button) {
        const signals = collectSignals(button);
        const label = compactSignal(
            signals.ownText || button.getAttribute("aria-label") || button.getAttribute("title") || ""
        );
        return `${label.slice(0, 120)}@${getElementPath(button)}`;
    }

    function isCoolingDown(signature) {
        const lastClickedAt = lastClickedSignatures.get(signature);
        if (lastClickedAt === undefined) return false;

        if (getNow() - lastClickedAt < CLICK_COOLDOWN_MS) return true;
        lastClickedSignatures.delete(signature);
        return false;
    }

    function clickRewardButton(button, signature) {
        if (!isEnabled()) return false;
        if (isCoolingDown(signature)) return false;
        if (scoreRewardButton(button) <= 0) return false;

        lastClickedSignatures.set(signature, getNow());
        button.click();
        button.setAttribute(CLICKED_ATTR, "1");
        return true;
    }

    function scheduleClick(button) {
        const signature = getButtonSignature(button);
        if (!signature || pendingClicks.has(signature) || isCoolingDown(signature)) return;

        const timeoutId = window.setTimeout(() => {
            pendingClicks.delete(signature);
            clickRewardButton(button, signature);
        }, getDelayMs());
        pendingClicks.set(signature, timeoutId);
    }

    function scanRewardButtons() {
        if (!isEnabled()) return;
        const button = findRewardButton();
        if (button) scheduleClick(button);
    }

    const scheduleScan = createThrottledDomSync(scanRewardButtons, SCAN_THROTTLE_MS);

    function nodeTouchesCandidate(node) {
        if (node instanceof Text) return node.parentElement ? nodeTouchesCandidate(node.parentElement) : false;
        if (!(node instanceof Element)) return false;
        if (node.matches(CANDIDATE_SELECTOR) || node.querySelector(CANDIDATE_SELECTOR)) return true;
        return Boolean(node.closest(CANDIDATE_SELECTOR));
    }

    function shouldScheduleScan(mutations) {
        return mutations.some((mutation) => {
            if (mutation.type === "characterData") return nodeTouchesCandidate(mutation.target);
            if (mutation.type === "attributes") return nodeTouchesCandidate(mutation.target);
            return Array.from(mutation.addedNodes || []).some(nodeTouchesCandidate);
        });
    }

    function startObserver() {
        if (domObserver) {
            scheduleScan();
            return;
        }

        domObserver = createMutationObserverSync({
            target: () => document.body,
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                characterData: true,
                attributeFilter: [
                    "class",
                    "style",
                    "aria-label",
                    "aria-disabled",
                    "disabled",
                    "title",
                    "role",
                    CLICKED_ATTR,
                ],
            },
            shouldSchedule: shouldScheduleScan,
            schedule: scheduleScan,
            onObserved: scheduleScan,
            onBodyReady: scheduleScan,
        });
        scheduleScan();
    }

    function stopObserver() {
        domObserver?.disconnectAll?.();
        domObserver?.disconnect?.();
        domObserver = null;

        for (const timeoutId of pendingClicks.values()) window.clearTimeout(timeoutId);
        pendingClicks.clear();
    }

    function applyOptions(options) {
        const wasEnabled = isEnabled();
        featureOptions = options;

        if (!isEnabled()) {
            stopObserver();
            return;
        }

        if (!wasEnabled) {
            startObserver();
            return;
        }

        scheduleScan();
    }

    bindFeatureOptions(applyOptions);
})();
