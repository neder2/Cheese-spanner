/**
 * 광고 차단 안내를 잠시 숨긴 뒤 실제 닫기 버튼으로 네이티브 모달 상태도 정리한다.
 * isolated world. 다음 프레임까지 남은 안내는 다시 표시하고 스크롤 잠금은 건드리지 않는다.
 * 옵션·라우트·DOM 수명주기에 맞춰 중복 클릭을 막는다.
 */
(() => {
    const POPUP =
        '[role="alertdialog"], [role="dialog"], [aria-modal="true"], [class^="popup_container__"], [class*=" popup_container__"]';
    const CLOSING_ATTR = "data-betterchzzk-adblock-popup-closing";
    const BACKDROP = '[class^="_dimmed_"], [class*=" _dimmed_"]';
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        mutationMatchesSelector,
        normalizeCompact,
        onReady,
        startPageChangeDetection,
        injectStyleOnce,
    } = BetterChzzk.utils;
    let options = BetterChzzkSettings.normalizeOptions();
    let observer = null;
    let removeRouteListener = null;
    let lastUrl = location.href;
    const attempts = new Map();
    const concealed = new Map();
    let restoreFrame = 0;

    function restoreConcealment(popup) {
        for (const node of concealed.get(popup) || []) node.removeAttribute(CLOSING_ATTR);
        concealed.delete(popup);
        if (!concealed.size && restoreFrame) {
            cancelAnimationFrame(restoreFrame);
            restoreFrame = 0;
        }
    }

    function restoreAllConcealment() {
        for (const popup of concealed.keys()) restoreConcealment(popup);
    }

    function concealForClose(popup) {
        injectStyleOnce(
            "betterchzzk-adblock-popup-style",
            `
[${CLOSING_ATTR}="1"] { visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }
`
        );
        const nodes = [popup];
        const backdrop = popup.parentElement?.closest(BACKDROP);
        // Never conceal another dialog sharing the same backdrop.
        if (backdrop && backdrop.querySelectorAll(POPUP).length === 1) nodes.push(backdrop);
        concealed.set(popup, nodes);
        for (const node of nodes) node.setAttribute(CLOSING_ATTR, "1");
        if (!restoreFrame) {
            restoreFrame = requestAnimationFrame(() => {
                restoreFrame = 0;
                restoreAllConcealment();
            });
        }
    }

    function publishReady() {
        document.documentElement.setAttribute(
            "data-betterchzzk-adblock-popup-ready",
            JSON.stringify({ href: location.href, at: Date.now() })
        );
        window.dispatchEvent(new Event("betterchzzk:adblock-popup:ready"));
    }

    function isAdblockPopupLike(popup) {
        if (!(popup instanceof HTMLElement)) return false;
        const text = normalizeCompact(popup.textContent || "");
        return (
            text.includes("adblock") ||
            (text.includes("광고") && text.includes("차단")) ||
            (text.includes("확장") && text.includes("기능") && text.includes("종료") && text.includes("광고"))
        );
    }

    function isShown(element) {
        if (!element.isConnected) return false;
        for (let node = element; node instanceof HTMLElement; node = node.parentElement) {
            if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")
                return false;
        }
        return true;
    }

    function closeAdsPopups() {
        if (!options.adblockPopupEnabled) return;
        const popups = new Set(document.querySelectorAll(POPUP));
        for (const popup of attempts.keys()) {
            if (!popups.has(popup)) attempts.delete(popup);
        }
        for (const popup of popups) {
            if (concealed.has(popup)) continue;
            const rect = popup.getBoundingClientRect();
            if (
                popup.querySelector(POPUP) ||
                !isAdblockPopupLike(popup) ||
                !isShown(popup) ||
                rect.width <= 0 ||
                rect.height <= 0
            ) {
                attempts.delete(popup);
                continue;
            }
            // CHZZK's modal close control uses aria-label from popup.close.
            // Generic confirmation, installation and navigation controls are not close controls.
            const buttons = Array.from(popup.querySelectorAll("button[aria-label]")).filter(
                (button) =>
                    button.closest(POPUP) === popup && normalizeCompact(button.getAttribute("aria-label")) === "닫기"
            );
            if (buttons.length !== 1) continue;
            const button = buttons[0];
            if (button.disabled || button.getAttribute("aria-disabled") === "true" || !isShown(button)) continue;
            const text = normalizeCompact(popup.textContent || "");
            const previous = attempts.get(popup);
            if (previous?.button === button && previous.text === text) continue;
            attempts.set(popup, { button, text });
            concealForClose(popup);
            try {
                button.click();
            } catch (_) {
                // Leave failed notices available for manual dismissal, without repeated clicks.
                restoreConcealment(popup);
            }
            if (!popup.isConnected) {
                restoreConcealment(popup);
                attempts.delete(popup);
            }
        }
    }

    function handlePageChange() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        restoreAllConcealment();
        attempts.clear();
        closeAdsPopups();
        publishReady();
    }

    function mutationCouldAffectPopup(mutation) {
        if (mutation.target instanceof Element && mutation.target.closest(POPUP)) return true;
        if (mutation.target.parentElement?.closest(POPUP)) return true;
        if (mutation.type === "attributes" && mutation.target.querySelector?.(POPUP)) return true;
        return mutationMatchesSelector(mutation, POPUP);
    }

    function syncRuntimeFromOptions() {
        if (!options.adblockPopupEnabled) {
            restoreAllConcealment();
            observer?.disconnectAll?.();
            observer?.disconnect();
            observer = null;
            removeRouteListener?.();
            removeRouteListener = null;
            attempts.clear();
            publishReady();
            return;
        }
        if (!removeRouteListener) removeRouteListener = startPageChangeDetection(handlePageChange);
        if (!observer) {
            observer = createMutationObserverSync({
                options: {
                    attributes: true,
                    attributeFilter: [
                        "aria-modal",
                        "class",
                        "role",
                        "style",
                        "hidden",
                        "aria-hidden",
                        "disabled",
                        "aria-disabled",
                        "aria-label",
                    ],
                    childList: true,
                    characterData: true,
                    subtree: true,
                },
                onMutations(mutations) {
                    // Removal also signals reuse when React reinserts the same node within one batch.
                    for (const mutation of mutations) {
                        for (const removed of mutation.removedNodes || []) {
                            for (const [popup, attempt] of attempts) {
                                if (
                                    removed === popup ||
                                    removed.contains?.(popup) ||
                                    removed === attempt.button ||
                                    removed.contains?.(attempt.button)
                                ) {
                                    restoreConcealment(popup);
                                    attempts.delete(popup);
                                }
                            }
                        }
                    }
                    handlePageChange();
                    if (mutations.some(mutationCouldAffectPopup)) closeAdsPopups();
                },
                onBodyReady: closeAdsPopups,
            });
        }
        closeAdsPopups();
        publishReady();
    }

    bindFeatureOptions((next) => {
        options = next;
        syncRuntimeFromOptions();
    });
    syncRuntimeFromOptions();
    onReady(syncRuntimeFromOptions);
})();
