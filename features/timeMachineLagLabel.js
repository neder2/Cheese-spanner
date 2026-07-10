/**
 * features/timeMachineLagLabel.js — 라이브 화면의 "실시간/라이브" 버튼 텍스트에 타임머신(되감기) 지연 시간을
 * "-분:초" 형태로 덧붙여 표시하는 기능 모듈.
 *
 * 동작 위치: 라이브 라우트 하단 컨트롤 바의 실시간/라이브 버튼 또는 좌측 버튼 컨테이너. isolated world,
 *   content.js 이후 로드.
 * 하는 일:
 *   - video의 seekable 범위와 currentTime으로 라이브 엣지 대비 지연(lag)을 추정하고, 3초 이하는 표시하지
 *     않는다.
 *   - 대상 버튼의 텍스트 노드를 찾아 원본 텍스트를 저장한 뒤 지연 라벨을 이어붙이고(patchLiveText),
 *     기능이 꺼지거나 라이브를 벗어나면 원본 텍스트로 복원한다(restoreLiveText).
 *   - 적절한 버튼을 찾지 못하면 좌측 버튼 컨테이너에 별도 라벨 요소(#betterchzzk-live-lag-label)를 붙이는
 *     fallback 경로를 쓴다.
 *   - MutationObserver, timeupdate/progress 이벤트, 1초 간격 fallback 인터벌, 페이지 전환 감지를 함께
 *     사용해 라벨을 최신 상태로 유지한다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, 전역 BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, createThrottledDomSync, getMainVideoElement, isLiveRoute,
 *   mutationMatchesSelector, normalizeCompact, onReady, pickLargestVisible, startPageChangeDetection).
 * 옵션 키: timeMachineLagLabelEnabled.
 * DOM 마커: data-bctm-text-patched(패치된 버튼 표시), id="betterchzzk-live-lag-label"(fallback 라벨),
 *   id="betterchzzk-live-lag-patch-style"/id="betterchzzk-live-lag-label-style"(주입 스타일).
 * 구조:
 *   - 상수/상태 선언, isFeatureEnabled 및 텍스트 정규화(compact/containsAnyTerm) 유틸.
 *   - isInLikelyVideoControlArea 등 버튼이 실제 컨트롤 바 안에 있는지 위치로 판별하는 함수군.
 *   - findLiveEdgeButton/scoreButton: "실시간/라이브" 텍스트를 가진 버튼 후보를 점수화해 선택.
 *   - getEstimatedLiveEdge/getLagSeconds/formatStableLagLabel: 라이브 엣지 추정과 지연 라벨 문자열 생성.
 *   - patchLiveText/restoreLiveText: 대상 버튼 텍스트 노드 치환·복원.
 *   - mountFallbackLagLabel/removeFallbackLagLabel: 버튼을 못 찾을 때 쓰는 별도 라벨 요소 관리.
 *   - syncTimeMachineLagText: 매 동기화 주기마다 위 과정을 묶어 실행하는 핵심 루프.
 *   - installRuntime/teardownRuntime/applyOptions: 옵션 변경과 라우트 변경에 따른 전체 생명주기 관리.
 */
(() => {
    const TEXT_PATCHED_ATTR = "data-bctm-text-patched";
    const PATCH_STYLE_ID = "betterchzzk-live-lag-patch-style";
    const FALLBACK_LABEL_ID = "betterchzzk-live-lag-label";
    const FALLBACK_LABEL_STYLE_ID = "betterchzzk-live-lag-label-style";
    const BUTTON_SELECTOR = "button, [role='button']";
    const LIVE_TIME_SELECTOR = [
        "div.pzp-live-time",
        "div.pzp-pc__live-time",
        "div.pzp-pc-live-time",
        "div.live_time",
        "[class*='live_time']",
        "[class*='live-time']",
        "[class*='LiveTime']",
    ].join(", ");
    const LIVE_LEFT_BUTTONS_SELECTOR = [
        "div.pzp-pc__bottom-buttons--left",
        "div.pzp-pc-bottom-buttons--left",
        "div[class*='pzp'][class*='bottom-buttons'][class*='left']",
    ].join(", ");
    const LIVE_EDGE_TARGET_SELECTOR = [
        BUTTON_SELECTOR,
        LIVE_TIME_SELECTOR,
        "[class*='live-button']",
        "[class*='LiveButton']",
        "[class*='live-status']",
        "[class*='LiveStatus']",
    ].join(", ");
    const RELEVANT_DOM_SELECTOR = `video, ${LIVE_EDGE_TARGET_SELECTOR}, ${LIVE_LEFT_BUTTONS_SELECTOR}, #${FALLBACK_LABEL_ID}`;
    const LIVE_THRESHOLD_SECONDS = 3;
    const FALLBACK_SYNC_INTERVAL_MS = 1000;
    const DOM_SYNC_THROTTLE_MS = 50;
    const DISPLAY_UPDATE_MIN_INTERVAL_MS = 950;
    const DISPLAY_SEEK_JUMP_SECONDS = 5;
    const PAGE_CHANGE_DELAY_MS = 400;
    const CONTROL_BAR_MIN_HEIGHT = 36;
    const CONTROL_BAR_MAX_HEIGHT = 80;
    const CONTROL_AREA_BEFORE_VIDEO_BOTTOM = 140;
    const CONTROL_AREA_AFTER_VIDEO_BOTTOM = 96;
    const LIVE_EDGE_ESTIMATE_MAX_LEAD_SECONDS = 6;
    const TIME_TEXT_RE = /(^|[^\d])\d{1,2}:\d{2}(?::\d{2})?($|[^\d])/;
    const LIVE_EDGE_BUTTON_TERMS = ["\uC2E4\uC2DC\uAC04", "\uB77C\uC774\uBE0C", "live"];
    const BLOCKED_TERMS = [
        "\uC7A0\uAE08",
        "\uC0AC\uC6A9 \uBD88\uAC00",
        "\uC0AC\uC6A9\uBD88\uAC00",
        "\uBE44\uD65C\uC131",
        "locked",
        "disabled",
        "unavailable",
        "off",
    ];

    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        getMainVideoElement,
        isLiveRoute,
        mutationMatchesSelector,
        normalizeCompact,
        onReady,
        pickLargestVisible,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let attachedVideo = null;
    let activeButtonEl = null;
    let activeTextNode = null;
    let liveEdgeEstimateVideo = null;
    let liveEdgeEstimateSeconds = NaN;
    let liveEdgeEstimateUpdatedAt = 0;
    let displayedLagSeconds = NaN;
    let displayedLabel = "";
    let displayedLabelUpdatedAt = 0;
    let fallbackIntervalId = 0;
    let fallbackLabelEl = null;
    let pageChangeTimer = 0;
    let lastUrl = location.href;
    let domObserver = null;
    let domObserverMode = "";
    let removePageChangeDetection = null;
    let runtimeInstalled = false;
    let lifecycleListenersInstalled = false;
    let startupSyncTimer = 0;
    const originalTextByNode = new WeakMap();

    const scheduleSync = createThrottledDomSync(syncTimeMachineLagText, DOM_SYNC_THROTTLE_MS);

    function isFeatureEnabled() {
        return featureOptions.timeMachineLagLabelEnabled !== false;
    }

    function compact(value) {
        if (typeof normalizeCompact === "function") return normalizeCompact(value);
        return String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");
    }

    function containsAnyTerm(value, terms) {
        const text = compact(value);
        return terms.some((term) => text.includes(compact(term)));
    }

    function getCandidateText(button) {
        return [button.getAttribute("aria-label"), button.getAttribute("title"), button.textContent].join(" ");
    }

    function getVisibleArea(el) {
        if (!(el instanceof HTMLElement) || !el.isConnected) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return 0;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return 0;
        return rect.width * rect.height;
    }

    function isButtonLike(el) {
        return el instanceof HTMLElement && Boolean(el.matches?.(BUTTON_SELECTOR));
    }

    function isVisibleControlTarget(el) {
        if (getVisibleArea(el) <= 0) return false;
        return !isButtonLike(el) || getComputedStyle(el).pointerEvents !== "none";
    }

    function getMainVideo() {
        if (typeof getMainVideoElement === "function") return getMainVideoElement();
        const videos = document.querySelectorAll("video");
        return pickLargestVisible(videos) || videos[0] || null;
    }

    function isVideoUsable(video) {
        return video instanceof HTMLVideoElement && video.isConnected && getVisibleArea(video) > 0;
    }

    function hasControlBarSizedAncestor(button, videoRect) {
        let node = button.parentElement;
        let depth = 0;
        while (node && node !== document.body && depth < 8) {
            const rect = node.getBoundingClientRect();
            const heightOk = rect.height >= CONTROL_BAR_MIN_HEIGHT && rect.height <= CONTROL_BAR_MAX_HEIGHT;
            const nearVideoBottom =
                rect.bottom >= videoRect.bottom - CONTROL_AREA_BEFORE_VIDEO_BOTTOM &&
                rect.top <= videoRect.bottom + CONTROL_AREA_AFTER_VIDEO_BOTTOM;
            if (heightOk && nearVideoBottom && rect.width >= Math.max(120, button.getBoundingClientRect().width)) {
                return true;
            }
            node = node.parentElement;
            depth += 1;
        }
        return false;
    }

    function isInLikelyVideoControlArea(button, video) {
        if (!isVideoUsable(video)) return false;
        const buttonRect = button.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        const centerX = buttonRect.left + buttonRect.width / 2;
        const centerY = buttonRect.top + buttonRect.height / 2;
        const horizontallyInsideVideo = centerX >= videoRect.left - 32 && centerX <= videoRect.right + 32;
        const nearVideoBottom =
            centerY >= videoRect.bottom - CONTROL_AREA_BEFORE_VIDEO_BOTTOM &&
            centerY <= videoRect.bottom + CONTROL_AREA_AFTER_VIDEO_BOTTOM;
        if (!horizontallyInsideVideo || !nearVideoBottom) return false;
        return hasControlBarSizedAncestor(button, videoRect) || buttonRect.height <= CONTROL_BAR_MAX_HEIGHT;
    }

    function textLooksLikeTime(value) {
        return TIME_TEXT_RE.test(String(value || ""));
    }

    function hasNearbyTimeText(button) {
        let branch = button;
        let ancestor = button.parentElement;
        let depth = 0;

        while (ancestor && ancestor !== document.body && depth < 4) {
            for (const child of ancestor.children) {
                if (child === branch || child.contains(branch)) continue;
                if (textLooksLikeTime(child.textContent)) return true;
            }
            branch = ancestor;
            ancestor = ancestor.parentElement;
            depth += 1;
        }

        return false;
    }

    function isRejectedButton(button) {
        if (!button || !button.isConnected) return true;
        if (button instanceof HTMLButtonElement && button.disabled) return true;
        if (button.hasAttribute("disabled")) return true;
        if (compact(button.getAttribute("aria-disabled")) === "true") return true;

        const style = getComputedStyle(button);
        if (isButtonLike(button) && style.pointerEvents === "none") return true;

        return containsAnyTerm(getCandidateText(button), BLOCKED_TERMS);
    }

    function findLiveTextNode(button) {
        const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                return containsAnyTerm(node.nodeValue, LIVE_EDGE_BUTTON_TERMS)
                    ? NodeFilter.FILTER_ACCEPT
                    : NodeFilter.FILTER_SKIP;
            },
        });
        return walker.nextNode();
    }

    function scoreButton(button, video) {
        if (!(button instanceof HTMLElement) || !button.isConnected) return null;
        if (!containsAnyTerm(getCandidateText(button), LIVE_EDGE_BUTTON_TERMS)) return null;
        if (!findLiveTextNode(button)) return null;
        if (!isVisibleControlTarget(button)) return null;

        const inControlArea = isInLikelyVideoControlArea(button, video);
        if (!inControlArea) return null;

        let score = 3;
        score += inControlArea ? 2 : 0;
        score += hasNearbyTimeText(button) ? 1 : 0;
        score += isLiveRoute() ? 1 : 0;

        if (score < 5) return null;
        return { button, score, area: getVisibleArea(button) };
    }

    function findLiveEdgeButton(video) {
        const matches = [];
        for (const button of document.querySelectorAll(LIVE_EDGE_TARGET_SELECTOR)) {
            const match = scoreButton(button, video);
            if (match) matches.push(match);
        }
        if (!matches.length) return null;

        matches.sort((a, b) => {
            if (b.area !== a.area) return b.area - a.area;
            return b.score - a.score;
        });

        return matches[0].button;
    }

    function isActiveButtonUsable(video) {
        if (!(activeButtonEl instanceof HTMLElement)) return false;

        const hasActiveTextPatch =
            activeTextNode instanceof Text && activeTextNode.isConnected && activeButtonEl.contains(activeTextNode);

        return (
            activeButtonEl.isConnected &&
            hasActiveTextPatch &&
            !isRejectedButton(activeButtonEl) &&
            isInLikelyVideoControlArea(activeButtonEl, video)
        );
    }

    function getTargetButton(video) {
        if (isActiveButtonUsable(video)) return activeButtonEl;
        if (activeButtonEl || activeTextNode) restoreLiveText();
        return findLiveEdgeButton(video);
    }

    function getSeekableRange(video) {
        if (!(video instanceof HTMLVideoElement) || !video.seekable?.length) return null;
        try {
            const lastIndex = video.seekable.length - 1;
            const start = video.seekable.start(lastIndex);
            const end = video.seekable.end(lastIndex);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
            return { start, end, length: end - start };
        } catch {
            return null;
        }
    }

    function resetLiveEdgeEstimate() {
        liveEdgeEstimateVideo = null;
        liveEdgeEstimateSeconds = NaN;
        liveEdgeEstimateUpdatedAt = 0;
        resetDisplayedLabel();
    }

    function resetDisplayedLabel() {
        displayedLagSeconds = NaN;
        displayedLabel = "";
        displayedLabelUpdatedAt = 0;
    }

    function getEstimatedLiveEdge(video, seekableRange) {
        const now = performance.now();
        const seekableEnd = seekableRange.end;
        const shouldReset =
            liveEdgeEstimateVideo !== video ||
            !Number.isFinite(liveEdgeEstimateSeconds) ||
            seekableEnd < liveEdgeEstimateSeconds - 10;

        if (shouldReset) {
            liveEdgeEstimateVideo = video;
            liveEdgeEstimateSeconds = seekableEnd;
            liveEdgeEstimateUpdatedAt = now;
            return liveEdgeEstimateSeconds;
        }

        const elapsedSeconds = Math.max(0, (now - liveEdgeEstimateUpdatedAt) / 1000);
        const advancedEstimate = liveEdgeEstimateSeconds + elapsedSeconds;
        const maxReasonableEdge = seekableEnd + LIVE_EDGE_ESTIMATE_MAX_LEAD_SECONDS;

        liveEdgeEstimateSeconds = Math.max(seekableEnd, Math.min(advancedEstimate, maxReasonableEdge));
        liveEdgeEstimateUpdatedAt = now;
        return liveEdgeEstimateSeconds;
    }

    function getLagSeconds(video, seekableRange) {
        const currentTime = video.currentTime;
        if (!Number.isFinite(currentTime)) return NaN;

        const liveEdge = getEstimatedLiveEdge(video, seekableRange);
        const lag = Math.max(0, liveEdge - currentTime);
        return Number.isFinite(lag) ? lag : NaN;
    }

    function formatLagSeconds(totalSeconds) {
        const seconds = String(totalSeconds % 60).padStart(2, "0");
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const hours = Math.floor(totalSeconds / 3600);

        if (hours > 0) {
            return `-${hours}:${String(minutes).padStart(2, "0")}:${seconds}`;
        }
        return `-${minutes}:${seconds}`;
    }

    function formatStableLagLabel(video, seekableRange) {
        const lag = getLagSeconds(video, seekableRange);
        if (!Number.isFinite(lag)) {
            resetDisplayedLabel();
            return "";
        }

        const now = performance.now();
        const rawSeconds = Math.max(0, Math.floor(lag));
        if (rawSeconds <= LIVE_THRESHOLD_SECONDS) {
            resetDisplayedLabel();
            return "";
        }

        const hasDisplayedSeconds = Number.isFinite(displayedLagSeconds);
        const seekJumped =
            hasDisplayedSeconds && Math.abs(rawSeconds - displayedLagSeconds) >= DISPLAY_SEEK_JUMP_SECONDS;
        const updateDue = now - displayedLabelUpdatedAt >= DISPLAY_UPDATE_MIN_INTERVAL_MS;

        if (!hasDisplayedSeconds || seekJumped || updateDue) {
            displayedLagSeconds = rawSeconds;
            displayedLabel = formatLagSeconds(rawSeconds);
            displayedLabelUpdatedAt = now;
        }

        return displayedLabel;
    }

    function formatPatchedText(originalText, labelText) {
        const match = String(originalText || "").match(/^(\s*)(.*?)(\s*)$/);
        if (!match) return labelText;
        return `${match[1]}${labelText}${match[3]}`;
    }

    function injectPatchStyleOnce() {
        document.documentElement.removeAttribute("data-bctm-lag-active");

        let style = document.getElementById(PATCH_STYLE_ID);
        if (!style) {
            style = document.createElement("style");
            style.id = PATCH_STYLE_ID;
            document.documentElement.appendChild(style);
        }

        const cssText = `
[${TEXT_PATCHED_ATTR}="1"],
[${TEXT_PATCHED_ATTR}="1"] *{
  font-variant-numeric:tabular-nums;
  letter-spacing:0;
}
[${TEXT_PATCHED_ATTR}="1"] [class*='icon'],
[${TEXT_PATCHED_ATTR}="1"] [class*='Icon'],
[${TEXT_PATCHED_ATTR}="1"] [class*='dot'],
[${TEXT_PATCHED_ATTR}="1"] [class*='Dot'],
[${TEXT_PATCHED_ATTR}="1"] [class*='badge'],
[${TEXT_PATCHED_ATTR}="1"] [class*='Badge'],
[${TEXT_PATCHED_ATTR}="1"] svg{
  display:none !important;
}
`;
        if (style.textContent !== cssText) style.textContent = cssText;
    }

    function injectFallbackLabelStyleOnce() {
        let style = document.getElementById(FALLBACK_LABEL_STYLE_ID);
        if (!style) {
            style = document.createElement("style");
            style.id = FALLBACK_LABEL_STYLE_ID;
            document.documentElement.appendChild(style);
        }

        const cssText = `
#${FALLBACK_LABEL_ID}{
  display:inline-flex;
  align-items:center;
  height:24px;
  margin-left:8px;
  color:rgba(255,255,255,0.92);
  font-family:inherit;
  font-size:14px;
  font-weight:700;
  line-height:20px;
  letter-spacing:0;
  white-space:nowrap;
  pointer-events:none;
  user-select:none;
  font-variant-numeric:tabular-nums;
  order:9998;
}
`;
        if (style.textContent !== cssText) style.textContent = cssText;
    }

    function getFallbackLabelElement() {
        if (fallbackLabelEl?.isConnected) return fallbackLabelEl;
        fallbackLabelEl = document.getElementById(FALLBACK_LABEL_ID);
        return fallbackLabelEl;
    }

    function removeFallbackLagLabel() {
        const label = getFallbackLabelElement();
        if (label) label.remove();
        fallbackLabelEl = null;
    }

    function findLiveLeftButtonsContainer(video) {
        const candidates = [];
        for (const el of document.querySelectorAll(LIVE_LEFT_BUTTONS_SELECTOR)) {
            if (!(el instanceof HTMLElement) || getVisibleArea(el) <= 0) continue;
            if (video instanceof HTMLVideoElement && !isInLikelyVideoControlArea(el, video)) continue;

            const rect = el.getBoundingClientRect();
            candidates.push({ el, width: rect.width, left: rect.left });
        }

        if (!candidates.length) return null;
        candidates.sort((a, b) => a.left - b.left || a.width - b.width);
        return candidates[0].el;
    }

    function findFallbackLabelReference(container) {
        if (!(container instanceof HTMLElement)) return null;

        const children = Array.from(container.children || []).filter((child) => {
            return child instanceof HTMLElement && child.id !== FALLBACK_LABEL_ID;
        });
        const visibleChildren = children.filter((child) => getVisibleArea(child) > 0);
        const candidates = visibleChildren.length ? visibleChildren : children;
        if (!candidates.length) return null;

        candidates.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
        return candidates[0];
    }

    function syncFallbackLabelTypography(label, container) {
        const reference = findFallbackLabelReference(container);
        if (!(reference instanceof HTMLElement)) return;

        label.className = reference.className || "";
        const style = getComputedStyle(reference);
        label.style.fontFamily = style.fontFamily;
        label.style.fontSize = style.fontSize;
        label.style.opacity = style.opacity;
        label.style.visibility = style.visibility;
        label.style.transition = style.transition;
    }

    function mountFallbackLagLabel(labelText, video) {
        const container = findLiveLeftButtonsContainer(video);
        if (!(container instanceof HTMLElement)) return false;

        injectFallbackLabelStyleOnce();

        let label = getFallbackLabelElement();
        if (!label) {
            label = document.createElement("span");
            label.id = FALLBACK_LABEL_ID;
            label.setAttribute("aria-hidden", "true");
            fallbackLabelEl = label;
        }

        if (label.textContent !== labelText) label.textContent = labelText;
        syncFallbackLabelTypography(label, container);

        if (label.parentElement !== container) {
            if (label.parentElement) label.remove();
            container.appendChild(label);
        }

        return true;
    }

    function restoreLiveText({ resetEstimate = true } = {}) {
        if (activeTextNode && originalTextByNode.has(activeTextNode) && activeTextNode.isConnected) {
            const originalText = originalTextByNode.get(activeTextNode);
            if (activeTextNode.nodeValue !== originalText) activeTextNode.nodeValue = originalText;
        }
        if (activeButtonEl instanceof HTMLElement) activeButtonEl.removeAttribute(TEXT_PATCHED_ATTR);
        activeButtonEl = null;
        activeTextNode = null;
        removeFallbackLagLabel();
        if (resetEstimate) resetLiveEdgeEstimate();
    }

    function patchLiveText(button, labelText) {
        let textNode = activeButtonEl === button && activeTextNode?.isConnected ? activeTextNode : null;
        if (!textNode || !button.contains(textNode)) {
            if (activeButtonEl || activeTextNode) restoreLiveText({ resetEstimate: false });
            textNode = findLiveTextNode(button);
        }
        if (!textNode) return false;

        if (!originalTextByNode.has(textNode)) originalTextByNode.set(textNode, textNode.nodeValue);

        const nextText = formatPatchedText(originalTextByNode.get(textNode), labelText);
        if (textNode.nodeValue !== nextText) textNode.nodeValue = nextText;

        activeButtonEl = button;
        activeTextNode = textNode;
        injectPatchStyleOnce();
        if (button.getAttribute(TEXT_PATCHED_ATTR) !== "1") button.setAttribute(TEXT_PATCHED_ATTR, "1");
        removeFallbackLagLabel();
        return true;
    }

    function detachVideoListeners() {
        if (!attachedVideo) return;
        attachedVideo.removeEventListener("timeupdate", scheduleSync, true);
        attachedVideo.removeEventListener("progress", scheduleSync, true);
        attachedVideo = null;
        resetLiveEdgeEstimate();
    }

    function attachVideoListeners(video) {
        if (attachedVideo === video) return;
        detachVideoListeners();
        if (!(video instanceof HTMLVideoElement)) return;

        attachedVideo = video;
        attachedVideo.addEventListener("timeupdate", scheduleSync, true);
        attachedVideo.addEventListener("progress", scheduleSync, true);
    }

    function stopFallbackInterval() {
        if (!fallbackIntervalId) return;
        clearInterval(fallbackIntervalId);
        fallbackIntervalId = 0;
    }

    function startFallbackInterval() {
        if (fallbackIntervalId || document.hidden || !isFeatureEnabled() || !isLiveRoute()) return;
        fallbackIntervalId = setInterval(syncTimeMachineLagText, FALLBACK_SYNC_INTERVAL_MS);
    }

    function syncTimeMachineLagText() {
        if (!isFeatureEnabled() || !isLiveRoute()) {
            restoreLiveText();
            detachVideoListeners();
            stopFallbackInterval();
            return;
        }

        const video = getMainVideo();
        attachVideoListeners(video);

        if (!isVideoUsable(video)) {
            restoreLiveText();
            return;
        }

        const seekableRange = getSeekableRange(video);
        if (!seekableRange) {
            restoreLiveText();
            return;
        }

        const labelText = formatStableLagLabel(video, seekableRange);
        if (!labelText) {
            restoreLiveText({ resetEstimate: false });
            return;
        }

        const button = getTargetButton(video);
        if (button && !isRejectedButton(button) && patchLiveText(button, labelText)) return;

        if (activeButtonEl || activeTextNode) restoreLiveText({ resetEstimate: false });
        mountFallbackLagLabel(labelText, video);
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;

        const liveRoute = isLiveRoute();
        if (!liveRoute) {
            restoreLiveText();
            stopFallbackInterval();
            detachVideoListeners();
        } else {
            startFallbackInterval();
        }
        refreshDomObserverConfig();
        if (pageChangeTimer) clearTimeout(pageChangeTimer);

        pageChangeTimer = setTimeout(() => {
            pageChangeTimer = 0;
            scheduleSync();
        }, PAGE_CHANGE_DELAY_MS);
    }

    function clearRuntimeTimers() {
        if (pageChangeTimer) {
            clearTimeout(pageChangeTimer);
            pageChangeTimer = 0;
        }
        if (startupSyncTimer) {
            clearTimeout(startupSyncTimer);
            startupSyncTimer = 0;
        }
    }

    function mutationCouldAffectText(mutation) {
        if (mutation.type === "characterData") {
            return Boolean(mutation.target?.parentElement?.closest?.(LIVE_EDGE_TARGET_SELECTOR));
        }
        if (mutationMatchesSelector(mutation, RELEVANT_DOM_SELECTOR)) return true;
        if (mutation.target instanceof Element) {
            return Boolean(mutation.target.closest(LIVE_EDGE_TARGET_SELECTOR));
        }
        return false;
    }

    function startDomObserver() {
        if (domObserver) return;

        domObserver = createMutationObserverSync({
            onMutations(mutations) {
                handlePageChange();
                if (!isFeatureEnabled() || !isLiveRoute()) return;
                if (!mutations.some(mutationCouldAffectText)) return;
                scheduleSync();
            },
            onBodyReady() {
                refreshDomObserverConfig();
                scheduleSync();
            },
        });

        refreshDomObserverConfig();
    }

    function stopDomObserver() {
        if (domObserver) {
            domObserver.disconnectAll?.();
            domObserver.disconnect();
            domObserver = null;
            domObserverMode = "";
        }
    }

    function getDomObserverConfig(mode) {
        if (mode !== "live") {
            return {
                childList: true,
                subtree: true,
            };
        }

        return {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
            attributeFilter: ["aria-label", "title", "disabled", "aria-disabled", "style", "hidden", "class"],
        };
    }

    function refreshDomObserverConfig() {
        if (!domObserver || !document.body) return;
        const nextMode = isFeatureEnabled() && isLiveRoute() ? "live" : "idle";
        if (domObserverMode === nextMode) return;

        domObserver.disconnect();
        domObserver.observe(document.body, getDomObserverConfig(nextMode));
        domObserverMode = nextMode;
    }

    function handleVisibilityChange() {
        if (document.hidden) {
            stopFallbackInterval();
            return;
        }
        startFallbackInterval();
        syncTimeMachineLagText();
    }

    function installLifecycleListeners() {
        if (lifecycleListenersInstalled) return;
        lifecycleListenersInstalled = true;
        document.addEventListener("visibilitychange", handleVisibilityChange, true);
    }

    function uninstallLifecycleListeners() {
        if (!lifecycleListenersInstalled) return;
        lifecycleListenersInstalled = false;
        document.removeEventListener("visibilitychange", handleVisibilityChange, true);
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        injectPatchStyleOnce();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(handlePageChange);
        }
        startDomObserver();
        installLifecycleListeners();
        startFallbackInterval();
        scheduleSync();
        if (!startupSyncTimer) {
            startupSyncTimer = setTimeout(() => {
                startupSyncTimer = 0;
                scheduleSync();
            }, 800);
        }
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        clearRuntimeTimers();
        stopFallbackInterval();
        restoreLiveText();
        detachVideoListeners();
        stopDomObserver();
        uninstallLifecycleListeners();
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
    }

    function applyOptions(options) {
        featureOptions = options;
        if (!isFeatureEnabled()) {
            teardownRuntime();
            return;
        }

        installRuntime();
        refreshDomObserverConfig();
        startFallbackInterval();
        scheduleSync();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (isFeatureEnabled()) installRuntime();
    });
})();
