(() => {
    const APPLY_EVENT = "betterchzzk:auto-quality:apply";
    const REQUEST_ATTR = "data-betterchzzk-auto-quality-request";
    const RESULT_ATTR = "data-betterchzzk-auto-quality-result";
    const STATE_EVENT = "betterchzzk:auto-quality:state";
    const STATE_ATTR = "data-betterchzzk-auto-quality-state";
    const ADBLOCK_READY_EVENT = "betterchzzk:adblock-popup:ready";
    const ADBLOCK_READY_ATTR = "data-betterchzzk-adblock-popup-ready";
    const APPLY_BURST_WINDOW_MS = 6000;
    const RECOVERY_BURST_WINDOW_MS = 3000;
    const FAST_RETRY_WINDOW_MS = 1000;
    const FAST_RETRY_DELAY_MS = 400;
    const SLOW_RETRY_DELAY_MS = 1000;
    const DOM_APPLY_THROTTLE_MS = 300;
    const PAGE_CHANGE_APPLY_DELAY_MS = 0;
    const VOD_STARTUP_APPLY_DELAY_MS = 1800;
    const VOD_SHARED_TIME_APPLY_DELAY_MS = 3600;
    const ADBLOCK_GATE_TIMEOUT_MS = 1200;
    let featureOptions = BetterChzzkSettings.normalizeOptions();
    const preferredQuality = BetterChzzkSettings.DEFAULT_QUALITY;
    let lastUrl = location.href;
    let pageChangeTimer = 0;
    let applyTimer = 0;
    let applyBurstStartedAt = 0;
    let applyBurstDeadline = 0;
    let applyInProgress = false;
    let applyAgainRequested = false;
    let adblockReady = false;
    let adblockGateTimer = 0;
    let adblockGateTimedOut = false;
    let pendingAdblockGateWindowMs = 0;
    let requestSeq = 0;
    let domObserver = null;
    let removePageChangeDetection = null;
    let runtimeInstalled = false;
    let adblockReadyListenerInstalled = false;
    let playbackStartupHref = "";
    let playbackStartupReadyAt = 0;

    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        isPlaybackRoute,
        isVodRoute,
        mutationMatchesSelector,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;
    const scheduleDomApply = createThrottledDomSync(() => requestQualityApplyBurst(RECOVERY_BURST_WINDOW_MS), DOM_APPLY_THROTTLE_MS);

    function isSupportedRoute() {
        return isPlaybackRoute();
    }

    function isEnabled() {
        return featureOptions.autoQualityEnabled && isSupportedRoute();
    }

    function getSharedStartTimeSeconds() {
        if (!isVodRoute()) return NaN;

        try {
            const seconds = Number(new URL(location.href).searchParams.get("currentTime"));
            return Number.isFinite(seconds) && seconds > 0 ? seconds : NaN;
        } catch (_) {
            return NaN;
        }
    }

    function markPlaybackStartupWindow() {
        if (!isEnabled()) {
            playbackStartupHref = location.href;
            playbackStartupReadyAt = 0;
            return;
        }

        if (playbackStartupHref === location.href) return;

        playbackStartupHref = location.href;
        if (!isVodRoute()) {
            playbackStartupReadyAt = 0;
            return;
        }

        const delayMs = Number.isFinite(getSharedStartTimeSeconds())
            ? VOD_SHARED_TIME_APPLY_DELAY_MS
            : VOD_STARTUP_APPLY_DELAY_MS;
        playbackStartupReadyAt = performance.now() + delayMs;
    }

    function getStartupApplyDelay(delayMs) {
        const remainingMs = playbackStartupReadyAt
            ? Math.ceil(playbackStartupReadyAt - performance.now())
            : 0;
        return Math.max(delayMs, remainingMs > 0 ? remainingMs : 0);
    }

    function publishState() {
        const state = {
            enabled: isEnabled(),
            quality: preferredQuality,
        };
        const serializedState = JSON.stringify(state);

        document.documentElement.setAttribute(STATE_ATTR, serializedState);
        window.dispatchEvent(new Event(STATE_EVENT));
    }

    function isAdblockReadyForCurrentUrl() {
        const raw = document.documentElement.getAttribute(ADBLOCK_READY_ATTR);
        if (!raw) return false;

        try {
            const state = JSON.parse(raw);
            return state?.href === location.href;
        } catch {
            return false;
        }
    }

    function clearAdblockGateTimer() {
        if (!adblockGateTimer) return;
        clearTimeout(adblockGateTimer);
        adblockGateTimer = 0;
    }

    function flushPendingAdblockGateApply() {
        if (!pendingAdblockGateWindowMs) return;

        const windowMs = pendingAdblockGateWindowMs;
        pendingAdblockGateWindowMs = 0;
        if (isEnabled()) startQualityApplyBurst(windowMs);
    }

    function markAdblockReady() {
        if (featureOptions.adblockPopupEnabled && !isAdblockReadyForCurrentUrl()) return;

        adblockReady = true;
        adblockGateTimedOut = false;
        clearAdblockGateTimer();
        flushPendingAdblockGateApply();
    }

    function resetAdblockGate() {
        clearAdblockGateTimer();
        pendingAdblockGateWindowMs = 0;
        adblockGateTimedOut = false;
        adblockReady = !featureOptions.adblockPopupEnabled || isAdblockReadyForCurrentUrl();
    }

    function shouldWaitForAdblock() {
        return featureOptions.adblockPopupEnabled && !adblockReady && !adblockGateTimedOut;
    }

    function requestQualityApplyBurst(windowMs = APPLY_BURST_WINDOW_MS) {
        if (!isEnabled()) return;

        if (!shouldWaitForAdblock()) {
            startQualityApplyBurst(windowMs);
            return;
        }

        pendingAdblockGateWindowMs = Math.max(pendingAdblockGateWindowMs, windowMs);
        if (adblockGateTimer) return;

        adblockGateTimer = setTimeout(() => {
            adblockGateTimer = 0;
            adblockGateTimedOut = true;
            flushPendingAdblockGateApply();
        }, ADBLOCK_GATE_TIMEOUT_MS);
    }

    function parseResult(requestId) {
        const raw = document.documentElement.getAttribute(RESULT_ATTR);
        if (!raw) return null;

        try {
            const result = JSON.parse(raw);
            return result?.requestId === requestId ? result : null;
        } catch {
            return null;
        }
    }

    function applyQualityInPageContext() {
        const requestId = `${Date.now()}:${++requestSeq}`;
        const payload = {
            requestId,
            quality: preferredQuality,
        };

        document.documentElement.setAttribute(REQUEST_ATTR, JSON.stringify(payload));
        window.dispatchEvent(new Event(APPLY_EVENT));

        return parseResult(requestId) || {
            requestId,
            status: "pending",
            reason: "page-handler-missing",
        };
    }

    async function applyPreferredQuality() {
        if (!isEnabled()) return "disabled";
        if (applyInProgress) {
            applyAgainRequested = true;
            return "pending";
        }

        applyInProgress = true;
        applyAgainRequested = false;

        try {
            const result = applyQualityInPageContext();
            return result.status || "pending";
        } finally {
            applyInProgress = false;
            if (applyAgainRequested && isEnabled()) scheduleQualityApplyRun(0);
        }
    }

    function scheduleQualityApplyRun(delayMs) {
        delayMs = getStartupApplyDelay(delayMs);

        if (applyTimer) {
            if (delayMs > 0) return;
            clearTimeout(applyTimer);
        }

        applyTimer = setTimeout(runQualityApply, delayMs);
    }

    function startQualityApplyBurst(windowMs = APPLY_BURST_WINDOW_MS) {
        if (!isEnabled()) return;

        const now = performance.now();
        if (!applyBurstDeadline || now > applyBurstDeadline) applyBurstStartedAt = now;
        applyBurstDeadline = Math.max(applyBurstDeadline, now + windowMs);
        scheduleQualityApplyRun(0);
    }

    async function runQualityApply() {
        applyTimer = 0;
        if (!isEnabled()) return;

        const result = await applyPreferredQuality();
        if (!isEnabled()) return;

        if (result === "already") return;
        if (performance.now() >= applyBurstDeadline) return;

        const elapsed = performance.now() - applyBurstStartedAt;
        if (result === "selected") return;

        scheduleQualityApplyRun(elapsed < FAST_RETRY_WINDOW_MS ? FAST_RETRY_DELAY_MS : SLOW_RETRY_DELAY_MS);
    }

    function clearAutoQualityTimers() {
        if (applyTimer) {
            clearTimeout(applyTimer);
            applyTimer = 0;
        }
        if (pageChangeTimer) {
            clearTimeout(pageChangeTimer);
            pageChangeTimer = 0;
        }
        applyBurstDeadline = 0;
        applyBurstStartedAt = 0;
        clearAdblockGateTimer();
        pendingAdblockGateWindowMs = 0;
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        resetAdblockGate();
        publishState();
        markPlaybackStartupWindow();

        if (!isEnabled()) {
            clearAutoQualityTimers();
            return;
        }

        if (pageChangeTimer) clearTimeout(pageChangeTimer);
        pageChangeTimer = setTimeout(() => {
            pageChangeTimer = 0;
            requestQualityApplyBurst();
        }, PAGE_CHANGE_APPLY_DELAY_MS);
    }

    function mutationCouldAffectQuality(mutation) {
        if (isVodRoute()) return mutationMatchesSelector(mutation, "video");
        return mutationMatchesSelector(mutation, "video, [class*='pzp'], [id*='player'], [class*='player']");
    }

    function startDomObserver() {
        if (domObserver) return;

        domObserver = createMutationObserverSync({
            onMutations(mutations) {
                handlePageChange();
                if (!isEnabled()) return;
                if (!mutations.some(mutationCouldAffectQuality)) return;
                scheduleDomApply();
            },
            onBodyReady: requestQualityApplyBurst,
        });
    }

    function stopDomObserver() {
        if (domObserver) {
            domObserver.disconnectAll?.();
            domObserver.disconnect();
            domObserver = null;
        }
    }

    function installAdblockReadyListener() {
        if (adblockReadyListenerInstalled) return;
        adblockReadyListenerInstalled = true;
        window.addEventListener(ADBLOCK_READY_EVENT, markAdblockReady);
    }

    function uninstallAdblockReadyListener() {
        if (!adblockReadyListenerInstalled) return;
        adblockReadyListenerInstalled = false;
        window.removeEventListener(ADBLOCK_READY_EVENT, markAdblockReady);
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        installAdblockReadyListener();
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(handlePageChange);
        }
        startDomObserver();
        markPlaybackStartupWindow();
        if (isEnabled()) requestQualityApplyBurst();
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        clearAutoQualityTimers();
        stopDomObserver();
        uninstallAdblockReadyListener();
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
    }

    function applyOptions(options) {
        featureOptions = options;
        if (!featureOptions.adblockPopupEnabled || isAdblockReadyForCurrentUrl()) {
            markAdblockReady();
        }
        publishState();
        if (!featureOptions.autoQualityEnabled) {
            teardownRuntime();
            return;
        }

        // Enabled installs runtime listeners; route support only gates scheduled work.
        installRuntime();
        if (isEnabled()) {
            requestQualityApplyBurst();
            return;
        }

        clearAutoQualityTimers();
    }

    bindFeatureOptions(applyOptions);

    onReady(() => {
        if (featureOptions.autoQualityEnabled) installRuntime();
    });
})();
