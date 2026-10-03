/**
 * features/vodReplayChatFix.js — 열린 다시보기 채팅 패널의 제목 누락만 제한적으로 복구한다.
 *
 * 동작 위치: 치지직 VOD 시청 페이지(/video/{id}) SPA 라우트.
 * 하는 일: SPA 내비게이션으로 VOD 라우트에 들어오면 일정 지연 후 채팅 다시보기 UI가 나타났는지
 *   본문 텍스트로 확인한다. 닫힌/없는 패널과 준비되지 않은 영상은 재로드하지 않는다. 열린 패널의
 *   제목만 누락됐으면 한 번 새로고침하며 위치는 sessionStorage의 짧은 일회용 상태로 넘긴다.
 *   첫 playing 뒤 복원 성공 또는 사용자 탐색·이탈 시 상태를 소비하고 URL 시간은 만들지 않는다.
 * 의존: BetterChzzk.utils(createMutationObserverSync, getMainVideoElement, onReady,
 *   startPageChangeDetection), sessionStorage.
 */
(() => {
    const VOD_ROUTE_RE = /^\/video\/\d+(?:\/|$)/;
    const CHAT_HEADING_TEXT = "\uB77C\uC774\uBE0C \uCC44\uD305 \uB2E4\uC2DC\uBCF4\uAE30";
    const RELOAD_KEY_PREFIX = "betterchzzk:vod-chat-reload:";
    const RESUME_KEY = "betterchzzk:vod-chat-resume";
    const RELOAD_MARK_TTL_MS = 60 * 1000;
    const RESUME_SETTLE_MS = 650;
    const RESUME_TIME_EPSILON_SECONDS = 1.25;
    const MIN_RELOAD_DELAY_MS = 12000;
    const LAYOUT_SETTLE_DELAY_MS = 2500;
    const LAYOUT_SETTLE_MAX_WAIT_MS = 6000;
    const CHECK_DELAYS_MS = [12000, 16000, 22000];
    const EXPANDED_PLAYER_TERMS = [
        "\uAE30\uBCF8 \uD654\uBA74",
        "\uC881\uC740 \uD654\uBA74",
        "\uC77C\uBC18 \uD654\uBA74",
        "exit wide",
        "normal screen",
    ];

    const { createMutationObserverSync, getMainVideoElement, onReady, startPageChangeDetection } = BetterChzzk.utils;

    let lastHref = location.href;
    let lastVodRouteKey = getVodRouteKey();
    let lastLayoutMutationAt = 0;
    let layoutSettleStartedAt = 0;
    let checkSeq = 0;
    let observer = null;
    let routeStartedAt = performance.now();
    let routeNeedsReplayChatFix = false;
    let removePageChangeDetection = null;
    let runtimeInstalled = false;
    let observerCheckTimer = 0;
    let pendingResume = null;
    let resumeSettleTimer = 0;
    let resumeExpiryTimer = 0;
    const RESUME_EVENTS = ["playing", "seeked", "timeupdate"];
    const RESUME_INTENT_EVENTS = ["pointerdown", "mousedown", "touchstart", "click"];

    function clearPendingResume() {
        if (resumeSettleTimer) clearTimeout(resumeSettleTimer);
        if (resumeExpiryTimer) clearTimeout(resumeExpiryTimer);
        resumeSettleTimer = 0;
        resumeExpiryTimer = 0;
        pendingResume = null;
        for (const type of RESUME_EVENTS) document.removeEventListener(type, restorePendingResume, true);
        for (const type of RESUME_INTENT_EVENTS) document.removeEventListener(type, cancelResumeOnUserIntent, true);
        window.removeEventListener("keydown", cancelResumeOnUserIntent, true);
        window.removeEventListener("pagehide", clearPendingResume, true);
        try {
            sessionStorage.removeItem(RESUME_KEY);
        } catch (_) {
            // The short expiry still limits an unavailable storage cleanup.
        }
    }

    function cancelResumeOnUserIntent(event) {
        if (!(event.target instanceof Element) && event.type !== "keydown") return;
        if (event.target?.closest?.("input, textarea, select, [contenteditable]")) return;
        if (event.type === "keydown") {
            if (
                !["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "j", "J", "l", "L"].includes(
                    event.key
                )
            )
                return;
        } else if (!event.target.closest(".pzp-progress-slider")) {
            const timecode = event.target.closest("#vod-aside button, #commentArea button");
            if (!timecode || !/^(?:\d{1,2}:)?\d{1,2}:\d{2}$/.test(timecode.textContent?.trim() || "")) return;
        }
        clearPendingResume();
    }

    function isResumeSatisfied(video, state) {
        const currentTime = Number(video.currentTime);
        const elapsed = Math.max(0, (performance.now() - state.appliedAt) / 1000);
        const rate = Number(video.playbackRate) || 1;
        return (
            Number.isFinite(currentTime) &&
            currentTime >= state.seconds - RESUME_TIME_EPSILON_SECONDS &&
            currentTime <= state.seconds + elapsed * rate + RESUME_TIME_EPSILON_SECONDS
        );
    }

    function restorePendingResume(event) {
        const state = pendingResume;
        if (!state) return;
        if (location.href !== state.href) {
            clearPendingResume();
            return;
        }
        const video = getMainVideoElement?.() || document.querySelector("video");
        if (!(video instanceof HTMLVideoElement) || (event && event.target !== video)) return;
        if (
            video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
            !Number.isFinite(video.duration) ||
            video.duration <= 0
        )
            return;
        if (state.seconds > video.duration) {
            clearPendingResume();
            return;
        }
        if (!state.video) {
            // Native first-play resume runs before playing; never seek during metadata initialization.
            const progressed = event?.type === "timeupdate" && !video.paused && video.currentTime > state.observedTime;
            state.observedTime = video.currentTime;
            if (event?.type !== "playing" && !progressed) return;
            state.video = video;
            state.appliedAt = performance.now();
            try {
                if (!isResumeSatisfied(video, state)) video.currentTime = state.seconds;
            } catch (_) {
                state.video = null;
                return;
            }
        }
        if (state.video !== video) {
            clearPendingResume();
            return;
        }
        if (video.seeking || !isResumeSatisfied(video, state) || resumeSettleTimer) return;
        resumeSettleTimer = setTimeout(() => {
            resumeSettleTimer = 0;
            if (pendingResume !== state) return;
            if (location.href !== state.href || !video.isConnected) {
                clearPendingResume();
                return;
            }
            if (!video.seeking && isResumeSatisfied(video, state)) clearPendingResume();
        }, RESUME_SETTLE_MS);
    }

    function readPendingResume() {
        let state;
        try {
            state = JSON.parse(sessionStorage.getItem(RESUME_KEY));
        } catch (_) {
            clearPendingResume();
            return;
        }
        if (!state) return;
        const age = Date.now() - state.at;
        if (
            !isVodRoute() ||
            state.href !== location.href ||
            !Number.isFinite(state.at) ||
            !Number.isFinite(state.seconds) ||
            state.seconds <= 1 ||
            !Number.isFinite(age) ||
            age < 0 ||
            age > RELOAD_MARK_TTL_MS ||
            new URL(location.href).searchParams.has("currentTime")
        ) {
            clearPendingResume();
            return;
        }
        const video = getMainVideoElement?.() || document.querySelector("video");
        pendingResume = { ...state, video: null, appliedAt: 0, observedTime: Number(video?.currentTime) };
        for (const type of RESUME_EVENTS) document.addEventListener(type, restorePendingResume, true);
        for (const type of RESUME_INTENT_EVENTS) document.addEventListener(type, cancelResumeOnUserIntent, true);
        window.addEventListener("keydown", cancelResumeOnUserIntent, true);
        window.addEventListener("pagehide", clearPendingResume, true);
        resumeExpiryTimer = setTimeout(clearPendingResume, RELOAD_MARK_TTL_MS - age);
    }

    function isVodRoute() {
        return VOD_ROUTE_RE.test(location.pathname);
    }

    function getVodRouteKey() {
        const match = location.pathname.match(/^\/video\/\d+/);
        return match ? match[0] : "";
    }

    function getReloadKey() {
        return `${RELOAD_KEY_PREFIX}${location.pathname}`;
    }

    function getReloadMark() {
        try {
            const value = Number(sessionStorage.getItem(getReloadKey()));
            return Number.isFinite(value) ? value : 0;
        } catch (_) {
            return 0;
        }
    }

    function setReloadMark() {
        try {
            sessionStorage.setItem(getReloadKey(), String(Date.now()));
        } catch (_) {
            // If sessionStorage is unavailable, location.replace still prevents history churn.
        }
    }

    function hasRecentReloadMark() {
        const mark = getReloadMark();
        if (!mark) return false;

        if (Date.now() - mark <= RELOAD_MARK_TTL_MS) return true;
        try {
            sessionStorage.removeItem(getReloadKey());
        } catch (_) {
            // Ignore storage cleanup failures; the stale mark naturally expires.
        }
        return false;
    }

    function hasReplayChat() {
        return Boolean(document.body?.textContent?.includes(CHAT_HEADING_TEXT));
    }

    function compact(value) {
        return String(value || "")
            .replace(/\s+/g, "")
            .toLowerCase();
    }

    function getControlText(el) {
        return compact([el?.getAttribute?.("aria-label"), el?.getAttribute?.("title"), el?.textContent].join(" "));
    }

    function isExpandedPlayerLayout() {
        for (const button of document.querySelectorAll("button, [role='button']")) {
            const text = getControlText(button);
            if (!text) continue;
            if (EXPANDED_PLAYER_TERMS.some((term) => text.includes(compact(term)))) return true;
        }
        return false;
    }

    function noteLayoutMutation() {
        const now = performance.now();
        if (!lastLayoutMutationAt || now - lastLayoutMutationAt >= LAYOUT_SETTLE_DELAY_MS) {
            layoutSettleStartedAt = now;
        }
        lastLayoutMutationAt = now;
    }

    function isLayoutSettling() {
        if (!lastLayoutMutationAt || !layoutSettleStartedAt) return false;
        const now = performance.now();
        return (
            now - lastLayoutMutationAt < LAYOUT_SETTLE_DELAY_MS &&
            now - layoutSettleStartedAt < LAYOUT_SETTLE_MAX_WAIT_MS
        );
    }

    function clearObserverCheckTimer() {
        if (!observerCheckTimer) return;
        clearTimeout(observerCheckTimer);
        observerCheckTimer = 0;
    }

    function scheduleObserverCheck() {
        clearObserverCheckTimer();
        const now = performance.now();
        const quietDelayMs = Math.max(0, LAYOUT_SETTLE_DELAY_MS - Math.max(0, now - lastLayoutMutationAt));
        const maxWaitDelayMs = Math.max(0, LAYOUT_SETTLE_MAX_WAIT_MS - Math.max(0, now - layoutSettleStartedAt));
        const delayMs = isLayoutSettling() ? Math.min(quietDelayMs, maxWaitDelayMs) : 0;
        observerCheckTimer = setTimeout(() => {
            observerCheckTimer = 0;
            if (!routeNeedsReplayChatFix || !isVodRoute()) return;
            if (isLayoutSettling()) {
                scheduleObserverCheck();
                return;
            }
            reloadOnceForReplayChat();
        }, delayMs);
    }

    function hasPlayableVod() {
        const video = getMainVideoElement?.() || document.querySelector("video");
        return (
            video instanceof HTMLVideoElement &&
            video.isConnected &&
            video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
            Number.isFinite(video.duration) &&
            video.duration > 0
        );
    }

    function prepareReloadResume() {
        const video = getMainVideoElement?.() || document.querySelector("video");
        const currentTime = Number(video?.currentTime);
        try {
            // An explicit timecode belongs to the user and is handled by the native page.
            if (
                new URL(location.href).searchParams.has("currentTime") ||
                !Number.isFinite(currentTime) ||
                currentTime <= 1
            ) {
                sessionStorage.removeItem(RESUME_KEY);
                return true;
            }
            sessionStorage.setItem(
                RESUME_KEY,
                JSON.stringify({ href: location.href, seconds: currentTime, at: Date.now() })
            );
            return true;
        } catch (_) {
            // Do not replace a failed transient handoff with a permanent URL timecode.
            return false;
        }
    }

    function reloadOnceForReplayChat() {
        if (!routeNeedsReplayChatFix || !isVodRoute()) {
            return;
        }
        if (hasReplayChat() || hasRecentReloadMark()) {
            routeNeedsReplayChatFix = false;
            return;
        }
        if (
            !document.querySelector("aside#vod-aside") ||
            isExpandedPlayerLayout() ||
            isLayoutSettling() ||
            !hasPlayableVod()
        )
            return;
        if (performance.now() - routeStartedAt < MIN_RELOAD_DELAY_MS) return;
        if (!prepareReloadResume()) return;

        setReloadMark();
        routeNeedsReplayChatFix = false;
        location.replace(location.href);
    }

    function scheduleChecks({ spaNavigation = false } = {}) {
        clearObserverCheckTimer();
        routeStartedAt = performance.now();
        lastLayoutMutationAt = 0;
        layoutSettleStartedAt = 0;
        routeNeedsReplayChatFix = spaNavigation && isVodRoute();
        checkSeq += 1;
        const seq = checkSeq;
        for (const delay of CHECK_DELAYS_MS) {
            setTimeout(() => {
                if (seq !== checkSeq) return;
                reloadOnceForReplayChat();
            }, delay);
        }
    }

    function handlePageChange() {
        if (location.href === lastHref) return;
        if (pendingResume) clearPendingResume();
        const previousVodRouteKey = lastVodRouteKey;
        lastHref = location.href;
        lastVodRouteKey = getVodRouteKey();

        if (!lastVodRouteKey) {
            routeNeedsReplayChatFix = false;
            checkSeq += 1;
            clearObserverCheckTimer();
            return;
        }

        if (lastVodRouteKey !== previousVodRouteKey) {
            scheduleChecks({ spaNavigation: true });
        }
    }

    function startObserver() {
        if (observer) return;

        observer = createMutationObserverSync({
            onMutations() {
                handlePageChange();
                noteLayoutMutation();
                if (routeNeedsReplayChatFix && isVodRoute() && !hasReplayChat() && !hasRecentReloadMark()) {
                    scheduleObserverCheck();
                }
            },
            onBodyReady() {
                scheduleChecks({ spaNavigation: false });
            },
        });
    }

    function installRuntime({ checkCurrentRoute = false } = {}) {
        if (!runtimeInstalled) {
            runtimeInstalled = true;
            if (!removePageChangeDetection) {
                removePageChangeDetection = startPageChangeDetection(handlePageChange);
            }
            startObserver();
        }
        scheduleChecks({ spaNavigation: checkCurrentRoute });
    }

    onReady(() => {
        readPendingResume();
        installRuntime();
    });
})();
