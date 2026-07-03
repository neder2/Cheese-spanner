(() => {
    const LEGACY_AD_POPUP_SELECTOR = [
        ".popup_container__Aqx-3",
        '[class^="popup_container__"]',
        '[class*=" popup_container__"]',
    ].join(",");
    const LEGACY_AD_DIMMED_SELECTOR = [
        ".popup_dimmed__zs78t",
        '[class^="popup_dimmed__"]',
        '[class*=" popup_dimmed__"]',
    ].join(",");
    const POPUP_CANDIDATE_SELECTOR = [
        LEGACY_AD_POPUP_SELECTOR,
        '[role="alertdialog"]',
        '[role="dialog"]',
        '[aria-modal="true"]',
    ].join(",");
    const POPUP_BACKDROP_SELECTOR = [
        LEGACY_AD_DIMMED_SELECTOR,
        '[class*="dimmed"]',
        '[class*="backdrop"]',
        '[class*="overlay"]',
    ].join(",");
    const AD_SUPPRESS_ATTR = "data-betterchzzk-suppress-adblock-popup";
    const AD_STYLE_ID = "betterchzzk-adblock-popup-style";
    const READY_EVENT = "betterchzzk:adblock-popup:ready";
    const READY_ATTR = "data-betterchzzk-adblock-popup-ready";
    const SCROLL_UNLOCK_DELAYS_MS = [0, 80, 250, 800];
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        mutationMatchesSelector,
        normalizeCompact,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let lastUrl = location.href;
    let pageChangeTimer = null;
    let scrollUnlockScheduled = false;
    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let domObserver = null;
    let removePageChangeDetection = null;
    let runtimeInstalled = false;

    function isEnabled() {
        return featureOptions.adblockPopupEnabled;
    }

    function publishReady() {
        document.documentElement.setAttribute(
            READY_ATTR,
            JSON.stringify({
                href: location.href,
                at: Date.now(),
            })
        );
        window.dispatchEvent(new Event(READY_EVENT));
    }

    function injectAdblockPopupStyleOnce() {
        BetterChzzk.utils.injectStyleOnce(
            AD_STYLE_ID,
            `
[${AD_SUPPRESS_ATTR}="1"]{
  display:none !important;
  pointer-events:none !important;
  visibility:hidden !important;
}
`
        );
    }

    function getClassText(el) {
        const raw = el?.getAttribute?.("class") || el?.className || "";
        return typeof raw === "string" ? raw.toLowerCase() : "";
    }

    function isBackdropLike(el) {
        const classText = getClassText(el);
        return classText.includes("dimmed") || classText.includes("backdrop") || classText.includes("overlay");
    }

    function isAdblockPopupLike(el) {
        if (!(el instanceof HTMLElement)) return false;

        const t = normalizeCompact(el.textContent || "");
        return (
            t.includes("adblock") ||
            t.includes("adblocker") ||
            t.includes("\uAD11\uACE0\uCC28\uB2E8") ||
            (t.includes("\uAD11\uACE0") && t.includes("\uCC28\uB2E8")) ||
            (t.includes("\uD655\uC7A5") &&
                t.includes("\uAE30\uB2A5") &&
                t.includes("\uC885\uB8CC") &&
                t.includes("\uAD11\uACE0"))
        );
    }

    function getPopupCandidates() {
        return Array.from(document.querySelectorAll(POPUP_CANDIDATE_SELECTOR)).filter(
            (popup) => popup instanceof HTMLElement
        );
    }

    function getPopupBackdrop(popup) {
        const legacyDimmed = popup?.closest?.(LEGACY_AD_DIMMED_SELECTOR);
        if (legacyDimmed instanceof HTMLElement) return legacyDimmed;

        for (
            let parent = popup?.parentElement;
            parent && parent !== document.body && parent !== document.documentElement;
            parent = parent.parentElement
        ) {
            if (isBackdropLike(parent)) return parent;
        }

        return null;
    }

    function getPopupBackdrops() {
        const backdrops = new Set();

        for (const dimmed of document.querySelectorAll(LEGACY_AD_DIMMED_SELECTOR)) {
            if (dimmed instanceof HTMLElement) backdrops.add(dimmed);
        }

        for (const popup of getPopupCandidates()) {
            const backdrop = getPopupBackdrop(popup);
            if (backdrop) backdrops.add(backdrop);
        }

        return Array.from(backdrops);
    }

    function isSuppressed(el) {
        return el?.getAttribute?.(AD_SUPPRESS_ATTR) === "1";
    }

    function isRendered(el) {
        if (!(el instanceof HTMLElement)) return false;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function hasSuppressedAdblockPopup() {
        return Boolean(document.querySelector(`[${AD_SUPPRESS_ATTR}="1"]`));
    }

    function hasActiveUnsuppressedPopup() {
        for (const popup of getPopupCandidates()) {
            if (isSuppressed(popup) || isSuppressed(getPopupBackdrop(popup))) continue;
            if (isRendered(popup)) return true;
        }

        return false;
    }

    function unlockBodyScrollIfOnlySuppressedPopups() {
        if (!document.body || !hasSuppressedAdblockPopup() || hasActiveUnsuppressedPopup()) return;

        const style = document.body.style;
        const hadScrollLock = style.overflow === "hidden" || style.overflowY === "hidden";
        if (!hadScrollLock) return;

        if (style.overflow === "hidden") style.removeProperty("overflow");
        if (style.overflowY === "hidden") style.removeProperty("overflow-y");
        style.removeProperty("padding-right");

        if (!document.body.getAttribute("style")?.trim()) {
            document.body.removeAttribute("style");
        }
    }

    function scheduleScrollUnlock() {
        if (scrollUnlockScheduled) return;
        scrollUnlockScheduled = true;

        for (const delay of SCROLL_UNLOCK_DELAYS_MS) {
            setTimeout(unlockBodyScrollIfOnlySuppressedPopups, delay);
        }

        setTimeout(
            () => {
                scrollUnlockScheduled = false;
            },
            Math.max(...SCROLL_UNLOCK_DELAYS_MS) + 50
        );
    }

    function syncBackdropSuppression() {
        const popups = getPopupCandidates();

        for (const backdrop of getPopupBackdrops()) {
            const containedPopups = popups.filter((popup) => backdrop.contains(popup));
            const shouldSuppress = containedPopups.length > 0 && containedPopups.every(isSuppressed);
            if (shouldSuppress) backdrop.setAttribute(AD_SUPPRESS_ATTR, "1");
            else backdrop.removeAttribute(AD_SUPPRESS_ATTR);
        }
    }

    function removeAdsPopup() {
        if (!isEnabled()) {
            restoreAdsPopups();
            return;
        }

        const popups = getPopupCandidates();
        if (!popups.length) {
            unlockBodyScrollIfOnlySuppressedPopups();
            return;
        }

        injectAdblockPopupStyleOnce();
        let suppressedCount = 0;

        for (const popup of popups) {
            const isAdblock = isAdblockPopupLike(popup);

            if (isAdblock) {
                popup.setAttribute(AD_SUPPRESS_ATTR, "1");
                suppressedCount += 1;
            } else {
                popup.removeAttribute(AD_SUPPRESS_ATTR);
            }
        }

        syncBackdropSuppression();
        if (suppressedCount > 0) scheduleScrollUnlock();
    }

    function runPopupPass() {
        if (isEnabled()) removeAdsPopup();
        else restoreAdsPopups();
        publishReady();
    }

    function restoreAdsPopups() {
        document.querySelectorAll(`[${AD_SUPPRESS_ATTR}="1"]`).forEach((el) => {
            el.removeAttribute(AD_SUPPRESS_ATTR);
        });
    }

    function mutationCouldAffectPopup(mutation) {
        if (mutation.type === "attributes" && mutation.target === document.body && mutation.attributeName === "style") {
            return hasSuppressedAdblockPopup();
        }

        if (mutation.target instanceof Element) {
            if (mutation.target.closest?.(POPUP_CANDIDATE_SELECTOR) || isBackdropLike(mutation.target)) return true;
        }

        return mutationMatchesSelector(mutation, `${POPUP_CANDIDATE_SELECTOR}, ${POPUP_BACKDROP_SELECTOR}`);
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        if (!isEnabled()) {
            restoreAdsPopups();
            publishReady();
            return;
        }

        if (pageChangeTimer) clearTimeout(pageChangeTimer);
        pageChangeTimer = setTimeout(() => {
            pageChangeTimer = null;
            runPopupPass();
        }, 500);
    }

    function startDomObserver() {
        if (domObserver) return;

        const config = {
            attributes: true,
            attributeFilter: ["aria-modal", "class", "role", "style"],
            childList: true,
            subtree: true,
        };

        domObserver = createMutationObserverSync({
            options: config,
            onMutations(mutations) {
                handlePageChange();
                if (mutations.some(mutationCouldAffectPopup)) removeAdsPopup();
            },
            onBodyReady: removeAdsPopup,
        });
    }

    function stopDomObserver() {
        if (domObserver) {
            domObserver.disconnectAll?.();
            domObserver.disconnect();
            domObserver = null;
        }
    }

    function clearRuntimeTimers() {
        if (!pageChangeTimer) return;
        clearTimeout(pageChangeTimer);
        pageChangeTimer = null;
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        if (!removePageChangeDetection) {
            removePageChangeDetection = startPageChangeDetection(handlePageChange);
        }
        startDomObserver();
        runPopupPass();
    }

    function teardownRuntime() {
        runtimeInstalled = false;
        clearRuntimeTimers();
        stopDomObserver();
        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }
        restoreAdsPopups();
        publishReady();
    }

    function syncRuntimeFromOptions() {
        if (isEnabled()) installRuntime();
        else teardownRuntime();
    }

    bindFeatureOptions((options) => {
        featureOptions = options;
        syncRuntimeFromOptions();
    });

    syncRuntimeFromOptions();

    onReady(() => {
        if (runtimeInstalled) runPopupPass();
        else syncRuntimeFromOptions();
    });
})();
