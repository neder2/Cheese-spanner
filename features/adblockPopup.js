/**
 * 광고 차단 안내를 잠시 숨긴 뒤 실제 닫기 버튼으로 네이티브 모달 상태도 정리한다.
 * 닫기 경로는 팝업 자체의 측정된 안내 정체성(로그 영역 또는 보이는 단일 제목)만 인정하고, 닉네임·본문·버튼의
 * 광고·차단 단어나 숨은·다른 팝업의 근거로는 누르지 않는다. 미확인 변형은 화면에 남긴다.
 * isolated world. 다음 프레임까지 남은 안내는 다시 표시하고 스크롤 잠금은 건드리지 않는다.
 * 옵션·라우트·DOM 수명주기에 맞춰 중복 클릭을 막는다.
 * 닫기 버튼 없이 확인 버튼만 있는 실측 안내(ad_blocking_info_layer)는 클릭하지 않고, MAIN의
 * adblockPopupPage.js에 동기 요청을 보내 버튼의 현재 확인 콜백을 표시 주기마다 한 번 호출하게 한다.
 * 이 안내는 가시성이 아니라 연결·정체성·호출 가능성으로 판단하며, 숨김 → 호출 → 실제 노드 제거까지
 * 숨김을 유지하고 NOTICE_REMOVAL_WAIT_MS 안에 제거되지 않거나 거절되면 숨김만 풀어 직접 확인하게 한다.
 * 같은 경로에서 자동으로 닫은 안내가 다시 뜨면 NOTICE_CONFIRM_LIMIT 이후에는 직접 확인하도록 남긴다.
 */
(() => {
    const POPUP =
        '[role="alertdialog"], [role="dialog"], [aria-modal="true"], [class^="popup_container__"], [class*=" popup_container__"]';
    const CLOSING_ATTR = "data-cheese-spanner-adblock-popup-closing";
    const BACKDROP = '[class^="_dimmed_"], [class*=" _dimmed_"]';
    const NOTICE_REQUEST = "cheese-spanner:adblock-notice-confirm";
    const NOTICE_AREA = "ad_blocking_info_layer";
    const NOTICE = `[role="alertdialog"][aria-modal="true"][data-nlog-area="${NOTICE_AREA}"]`;
    // 2026-10-11·10-17 안내의 식별자·도움말과 의미를 유지하며 조사·문장 분리만 허용한다.
    const NOTICE_TITLE = /^광고차단프로그램(?:을)?사용(?:중이신가요|중인가요|하시나요|하고계신가요)[?？.!。！]*$/;
    const NOTICE_DESCRIPTION = [
        "광고차단프로그램",
        "사용",
        "재생환경",
        "영향",
        "확장프로그램",
        "삭제",
        "서비스",
        "이용",
    ];
    const NOTICE_HEADINGS = "strong, h1, h2, h3, h4, h5, h6, [role=heading]";
    const TITLE_WRAPPERS = new Set(["DIV", "HEADER", "SECTION"]);
    const NOTICE_CONFIRM = "확인";
    const NOTICE_HELP_URL = "https://help.naver.com/alias/navergame/chzzkars49.naver";
    const NOTICE_ROUTE = /^\/(?:live\/[^/]+|video\/\d+)\/?$/;
    // dab 반영과 프리롤 AD_NOT_DISPLAYED가 각각 한 번 켤 수 있다. 그 이상 반복되면 재생 오류일 수 있어 남긴다.
    const NOTICE_CONFIRM_LIMIT = 2;
    const NOTICE_RESULT_ATTR = "data-cheese-spanner-adblock-notice-result";
    // 2026-10-11 Edge 실측에서 호출 뒤 React 제거까지 2.5~3.9ms였다. 페이지 로딩 중 긴 작업을 감안한 상한이다.
    const NOTICE_REMOVAL_WAIT_MS = 1000;
    const REVEAL_EVENTS = ["transitionend", "animationend"];
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        mutationMatchesSelector,
        normalizeCompact,
        onReady,
        startPageChangeDetection,
        injectStyleOnce,
        hasNativeHideMutation,
    } = CheeseSpanner.utils;
    let options = null;
    let observer = null;
    let removeRouteListener = null;
    let lastUrl = location.href;
    let noticePath = location.pathname;
    let noticeConfirms = 0;
    let noticeGeneration = 0;
    let noticeWait = null;
    let removePageHideListener = null;
    let removeRevealListener = null;
    const noticeResults = { removed: 0, timedOut: 0, refused: 0 };
    const attempts = new Map();
    const concealed = new Map();
    const confirmedNoticeButtons = new WeakSet();
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

    function ensureConcealStyle() {
        injectStyleOnce(
            "cheese-spanner-adblock-popup-style",
            `
[${CLOSING_ATTR}="1"] { visibility:hidden !important; opacity:0 !important; pointer-events:none !important; }
`
        );
    }

    function conceal(popup) {
        ensureConcealStyle();
        const nodes = [popup];
        const backdrop = popup.parentElement?.closest(BACKDROP);
        // Never conceal another dialog sharing the same backdrop.
        if (backdrop && backdrop.querySelectorAll(POPUP).length === 1) nodes.push(backdrop);
        concealed.set(popup, nodes);
        for (const node of nodes) node.setAttribute(CLOSING_ATTR, "1");
    }

    function concealForClose(popup) {
        conceal(popup);
        if (!restoreFrame) {
            restoreFrame = requestAnimationFrame(() => {
                restoreFrame = 0;
                // The exact notice waits for its own native removal or timeout instead of this frame.
                const closingPopups = Array.from(concealed.keys()).filter((item) => item !== noticeWait?.popup);
                closingPopups.forEach(restoreConcealment);
                // Native CSS hiding can be masked by our temporary visibility rule.
                for (const popup of closingPopups) if (!isShown(popup)) attempts.delete(popup);
            });
        }
    }

    function publishNoticeResult(result, waitMs = null) {
        const counter = { removed: "removed", timeout: "timedOut", refused: "refused" }[result];
        if (counter) noticeResults[counter] += 1;
        document.documentElement.setAttribute(
            NOTICE_RESULT_ATTR,
            JSON.stringify({ last: result, waitMs, ...noticeResults })
        );
    }

    // Ends the bounded wait. Concealment is released in every case; success is only an observed removal.
    function finishNoticeWait(result) {
        const wait = noticeWait;
        if (!wait) return;
        noticeWait = null;
        clearTimeout(wait.timer);
        restoreConcealment(wait.popup);
        publishNoticeResult(result, Math.round(performance.now() - wait.startedAt));
    }

    function cancelNoticeWork() {
        noticeGeneration += 1;
        finishNoticeWait("cancelled");
    }

    function publishReady() {
        document.documentElement.setAttribute(
            "data-cheese-spanner-adblock-popup-ready",
            JSON.stringify({ href: location.href, at: Date.now() })
        );
        window.dispatchEvent(new Event("cheese-spanner:adblock-popup:ready"));
    }

    // The close path only trusts the measured notice's own identity: its log area on the popup itself, or its
    // single visible top-level title. Words such as 광고·차단·adblock in nicknames, bodies or buttons are not
    // evidence, and neither are hidden nodes or another popup's content. Unknown variants stay visible.
    function hasMeasuredNoticeIdentity(popup) {
        if (!(popup instanceof HTMLElement)) return false;
        if (popup.getAttribute("data-nlog-area") === NOTICE_AREA) return true;
        const titles = Array.from(popup.querySelectorAll(NOTICE_HEADINGS)).filter(
            (node) => node.closest(POPUP) === popup && !node.parentElement.closest(NOTICE_HEADINGS)
        );
        const title = titles[0];
        return (
            titles.length === 1 &&
            isTitlePlacement(popup, title) &&
            isShown(title) &&
            NOTICE_TITLE.test(normalizeCompact(shownText(title)))
        );
    }

    // 2026-10-11 notice: popup > div > div > strong. A heading inside body copy, a button, a link or another
    // role is quoted or control text, not the popup's title, so only plain layout containers may wrap it.
    function isTitlePlacement(popup, title) {
        for (let node = title.parentElement; node !== popup; node = node.parentElement) {
            if (!node || !TITLE_WRAPPERS.has(node.tagName) || node.hasAttribute("role")) return false;
        }
        return true;
    }

    // Only text the user can see counts: hidden, aria-hidden, display:none or invisible descendants, text under a
    // fully transparent title, descendant or ancestor, zero-size text and text outside the viewport are not
    // evidence (Codex r3-m1 Chrome: such normal modals were closed). The title's own rect is not enough, since a
    // positive-size title can hold 0x0 text.
    function shownText(root) {
        if (!isOpaqueChain(root)) return "";
        let text = "";
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (isShownWithin(node.parentElement, root) && isTextVisible(node)) text += node.data;
        }
        return text;
    }

    function isTransparent(style) {
        return parseFloat(style.opacity) <= 0;
    }

    function isOpaqueChain(element) {
        for (let node = element; node instanceof Element; node = node.parentElement) {
            if (isTransparent(getComputedStyle(node))) return false;
        }
        return true;
    }

    function isTextVisible(textNode) {
        if (!textNode.data.trim()) return true;
        if (parseFloat(getComputedStyle(textNode.parentElement).fontSize) <= 0) return false;
        const range = document.createRange();
        // Engines without layout (jsdom) have no text geometry; the style checks above still apply there.
        if (typeof range.getClientRects !== "function") return true;
        range.selectNodeContents(textNode);
        const width = window.innerWidth || document.documentElement.clientWidth;
        const height = window.innerHeight || document.documentElement.clientHeight;
        return Array.from(range.getClientRects()).some(
            (rect) =>
                rect.width > 0 &&
                rect.height > 0 &&
                Math.min(rect.right, width) > Math.max(rect.left, 0) &&
                Math.min(rect.bottom, height) > Math.max(rect.top, 0)
        );
    }

    function isShownWithin(element, root) {
        for (let node = element; node && node !== root; node = node.parentElement) {
            if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
            const style = getComputedStyle(node);
            if (
                style.display === "none" ||
                style.visibility === "hidden" ||
                style.visibility === "collapse" ||
                isTransparent(style)
            )
                return false;
        }
        return true;
    }

    function hasClassFamily(element, prefix) {
        return Array.from(element.classList).some(
            (token) => token.startsWith(prefix) && /^\d+$/.test(token.slice(prefix.length))
        );
    }

    function hasOwnPopupElement(popup, selector, matches = () => true) {
        return Array.from(popup.querySelectorAll(selector)).some(
            (element) => element.closest(POPUP) === popup && matches(element)
        );
    }

    function isRequiredPopup(popup) {
        // 2026-10-17 Chrome profile DOM: module identity + local controls, never nickname/copy alone.
        // Numeric CSS suffixes and intermediate wrappers may change; unrelated modules stay untrusted.
        if (
            hasClassFamily(popup, "_container_xwsra_") &&
            hasOwnPopupElement(popup, 'button[class*="_profile_xwsra_"]', (element) =>
                hasClassFamily(element, "_profile_xwsra_")
            )
        )
            return true;
        if (
            hasClassFamily(popup, "_container_y6scg_") &&
            ["_contents_y6scg_", "_control_y6scg_"].every((prefix) =>
                hasOwnPopupElement(popup, `[class*="${prefix}"]`, (element) => hasClassFamily(element, prefix))
            )
        )
            return true;
        // Current native video/shop report forms include user-supplied titles. Both purpose and form
        // structure must belong to this popup; a sibling profile/report must not exempt an ad notice.
        return [
            ["신고하기", "radiogroup", "radio"],
            ["스트리머샵신고하기", "group", "checkbox"],
        ].some(
            ([title, role, type]) =>
                hasOwnPopupElement(
                    popup,
                    NOTICE_HEADINGS,
                    (element) => normalizeCompact(element.textContent) === title
                ) &&
                hasOwnPopupElement(
                    popup,
                    `ul[role="${role}"] input[name="report-reason"][type="${type}"]`,
                    (input) => input.closest(`ul[role="${role}"]`)?.closest(POPUP) === popup
                )
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

    // Keep this target validation identical to the MAIN helper; neither world trusts the other's marker.
    function hasOnlyNoticeChild(parent, child) {
        return (
            parent?.children.length === 1 &&
            parent.firstElementChild === child &&
            Array.from(parent.childNodes).every((node) => node === child || !node.textContent.trim())
        );
    }

    function isNoticeWrapper(parent, child) {
        return (
            parent?.tagName === "DIV" &&
            !parent.matches(POPUP) &&
            !["role", "data-nlog-area", "tabindex", "contenteditable"].some((name) => parent.hasAttribute(name)) &&
            hasOnlyNoticeChild(parent, child)
        );
    }

    function findNoticeBackdrop(popup) {
        let child = popup;
        let backdrop = child.parentElement;
        for (let depth = 0; depth < 2 && !backdrop?.matches(BACKDROP); depth++) {
            if (!isNoticeWrapper(backdrop, child)) return null;
            child = backdrop;
            backdrop = child.parentElement;
        }
        if (!backdrop?.matches(BACKDROP) || backdrop.matches(POPUP) || !hasOnlyNoticeChild(backdrop, child))
            return null;
        child = backdrop;
        for (let depth = 0; depth < 2 && child.parentElement !== document.body; depth++) {
            if (!isNoticeWrapper(child.parentElement, child)) return null;
            child = child.parentElement;
        }
        return child.parentElement === document.body ? backdrop : null;
    }

    function hasNoticeCopy(popup) {
        const titles = Array.from(popup.querySelectorAll(NOTICE_HEADINGS)).filter(
            (node) => !node.parentElement.closest(NOTICE_HEADINGS)
        );
        if (titles.length !== 1 || !NOTICE_TITLE.test(normalizeCompact(titles[0].textContent))) return false;
        const text = Array.from(popup.querySelectorAll("p"), (node) => normalizeCompact(node.textContent)).join("");
        if (text.length > 1000) return false;
        let position = 0;
        return NOTICE_DESCRIPTION.every((anchor) => {
            const index = text.indexOf(anchor, position);
            if (index < 0) return false;
            position = index + anchor.length;
            return true;
        });
    }

    // Exact measured notice only, judged by connection, identity and its confirm button rather than visibility.
    // MAIN repeats these checks with the current React props before calling.
    function findNoticeConfirm(popup) {
        if (
            !NOTICE_ROUTE.test(location.pathname) ||
            !popup.isConnected ||
            popup.ownerDocument !== document ||
            !popup.matches(NOTICE) ||
            popup.querySelector(POPUP)
        )
            return null;
        if (document.querySelectorAll(`[data-nlog-area="${NOTICE_AREA}"]`).length !== 1 || !findNoticeBackdrop(popup))
            return null;
        const links = popup.querySelectorAll("a");
        const buttons = popup.querySelectorAll("button");
        const button = buttons[0];
        return hasNoticeCopy(popup) &&
            links.length === 1 &&
            links[0].getAttribute("href") === NOTICE_HELP_URL &&
            buttons.length === 1 &&
            button.closest(NOTICE) === popup &&
            normalizeCompact(button.textContent) === NOTICE_CONFIRM &&
            button.type === "button" &&
            !button.disabled &&
            button.getAttribute("aria-disabled") !== "true"
            ? button
            : null;
    }

    function confirmNotice(popup, button) {
        const text = normalizeCompact(popup.textContent || "");
        const previous = attempts.get(popup);
        if (previous?.button === button && previous.text === text) return;
        attempts.set(popup, { button, text });
        // Failed, repeated or over-limit notices stay visible and are never concealed again.
        if (confirmedNoticeButtons.has(button) || noticeConfirms >= NOTICE_CONFIRM_LIMIT) return;
        confirmedNoticeButtons.add(button);
        conceal(popup);
        // MAIN handles the request synchronously, so no late response can act on a later page state.
        let invoked = false;
        try {
            invoked = !button.dispatchEvent(new Event(NOTICE_REQUEST, { cancelable: true }));
        } catch (_) {
            invoked = false;
        }
        if (!invoked) {
            restoreConcealment(popup);
            publishNoticeResult("refused");
            return;
        }
        noticeConfirms += 1;
        const generation = noticeGeneration;
        const wait = { popup, button, generation, startedAt: performance.now(), timer: 0 };
        noticeWait = wait;
        if (!popup.isConnected) {
            finishNoticeWait("removed");
            return;
        }
        // A returned callback is not success; keep the notice concealed until React removes it.
        wait.timer = setTimeout(() => {
            if (noticeWait === wait && noticeGeneration === generation) finishNoticeWait("timeout");
        }, NOTICE_REMOVAL_WAIT_MS);
    }

    function closeAdsPopups() {
        if (!options?.adblockPopupEnabled) return;
        const popups = new Set(document.querySelectorAll(POPUP));
        for (const popup of attempts.keys()) {
            if (!popups.has(popup)) attempts.delete(popup);
        }
        for (const popup of popups) {
            if (concealed.has(popup)) continue;
            // The exact notice is routed before the visibility filter so early concealment cannot reject it.
            const noticeButton = findNoticeConfirm(popup);
            if (noticeButton) {
                confirmNotice(popup, noticeButton);
                continue;
            }
            const rect = popup.getBoundingClientRect();
            if (
                popup.querySelector(POPUP) ||
                !hasMeasuredNoticeIdentity(popup) ||
                isRequiredPopup(popup) ||
                !isShown(popup) ||
                rect.width <= 0 ||
                rect.height <= 0
            ) {
                attempts.delete(popup);
                continue;
            }
            // CHZZK's modal close control uses aria-label from popup.close.
            // Generic confirmation, installation and navigation controls are not close controls.
            const buttons = Array.from(popup.querySelectorAll("button[aria-label]")).filter((button) => {
                const rect = button.getBoundingClientRect();
                return (
                    button.closest(POPUP) === popup &&
                    ["닫기", "팝업닫기"].includes(normalizeCompact(button.getAttribute("aria-label"))) &&
                    !button.disabled &&
                    button.getAttribute("aria-disabled") !== "true" &&
                    isShown(button) &&
                    rect.width > 0 &&
                    rect.height > 0
                );
            });
            if (buttons.length !== 1) continue;
            const button = buttons[0];
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
        if (location.pathname !== noticePath) {
            noticePath = location.pathname;
            noticeConfirms = 0;
        }
        cancelNoticeWork();
        restoreAllConcealment();
        attempts.clear();
        closeAdsPopups();
        publishReady();
    }

    // BFCache or unload ends this generation; a restored page shows any remaining notice for manual dismissal.
    function handlePageHide() {
        cancelNoticeWork();
        restoreAllConcealment();
    }

    function noticeWaitAffected(mutations) {
        const wait = noticeWait;
        if (!wait) return;
        for (const mutation of mutations) {
            for (const removed of mutation.removedNodes || []) {
                if (
                    removed === wait.popup ||
                    removed.contains?.(wait.popup) ||
                    removed === wait.button ||
                    removed.contains?.(wait.button)
                ) {
                    // Only the disconnected notice node counts as a native close.
                    finishNoticeWait(wait.popup.isConnected ? "replaced" : "removed");
                    return;
                }
            }
        }
        if (hasNativeHideMutation(mutations, wait.popup)) finishNoticeWait("hidden");
    }

    // A CSS fade or slide-in changes opacity or position without a DOM mutation, so a title that was transparent
    // or off-screen at insertion is checked again when its transition or animation ends.
    function handlePopupReveal(event) {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (target.closest(POPUP) || target.querySelector(POPUP)) closeAdsPopups();
    }

    function mutationCouldAffectPopup(mutation) {
        if (mutation.target instanceof Element && mutation.target.closest(POPUP)) return true;
        if (mutation.target.parentElement?.closest(POPUP)) return true;
        if (mutation.type === "attributes" && mutation.target.querySelector?.(POPUP)) return true;
        return mutationMatchesSelector(mutation, POPUP);
    }

    function syncRuntimeFromOptions() {
        if (!options) return;
        if (!options.adblockPopupEnabled) {
            cancelNoticeWork();
            restoreAllConcealment();
            observer?.disconnectAll?.();
            observer?.disconnect();
            observer = null;
            removeRouteListener?.();
            removeRouteListener = null;
            removePageHideListener?.();
            removePageHideListener = null;
            removeRevealListener?.();
            removeRevealListener = null;
            attempts.clear();
            publishReady();
            return;
        }
        // Prepare the packaged concealment rule as soon as ON is confirmed, before any notice appears.
        ensureConcealStyle();
        if (!removeRouteListener) removeRouteListener = startPageChangeDetection(handlePageChange);
        if (!removePageHideListener) {
            window.addEventListener("pagehide", handlePageHide, true);
            removePageHideListener = () => window.removeEventListener("pagehide", handlePageHide, true);
        }
        if (!removeRevealListener) {
            for (const type of REVEAL_EVENTS) document.addEventListener(type, handlePopupReveal, true);
            removeRevealListener = () => {
                for (const type of REVEAL_EVENTS) document.removeEventListener(type, handlePopupReveal, true);
            };
        }
        if (!observer) {
            observer = createMutationObserverSync({
                options: {
                    attributes: true,
                    attributeOldValue: true,
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
                        "name",
                        "type",
                    ],
                    childList: true,
                    characterData: true,
                    subtree: true,
                },
                onMutations(mutations) {
                    noticeWaitAffected(mutations);
                    for (const popup of attempts.keys()) {
                        if (hasNativeHideMutation(mutations, popup)) {
                            restoreConcealment(popup);
                            attempts.delete(popup);
                        }
                    }
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
