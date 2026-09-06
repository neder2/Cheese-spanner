/* Standalone isolated-world notice, also injected into open tabs after an update.
 * 2026-09-06 https://chzzk.naver.com/: theme_dark and --sem-color-* tokens measured.
 * Works without the previous extension's invalidated content-script context.
 */
(() => {
    if (location.origin !== "https://chzzk.naver.com") return;
    try {
        globalThis.BetterChzzkUpdateNoticeRuntime?.destroy();
    } catch {
        /* Previous context may be invalidated. */
    }
    const { UPDATE_KEY, READ_KEY, NOTIFICATIONS_KEY, RELOAD_GUIDE_KEY, steps } = globalThis.BetterChzzkUpdateGuide;
    const version = chrome.runtime.getManifest().version;
    const ID = "betterchzzk-update-notice";
    document.getElementById(ID)?.remove();
    let host = null;
    let generation = 0;
    let destroyed = false;
    let busy = false;
    let preview = false;
    let step = -1;
    let anchor = null;
    let guideObserver = null;
    let guideResizeObserver = null;
    let positionFrame = 0;
    let moveAnimation = null;
    let moveGeneration = 0;
    try {
        const continuation = sessionStorage.getItem(RELOAD_GUIDE_KEY);
        preview = continuation === `preview:${version}`;
        if (continuation === version || preview) step = 0;
        sessionStorage.removeItem(RELOAD_GUIDE_KEY);
    } catch {
        /* Restricted storage only prevents automatic guide continuation. */
    }

    function storage(area, method, value) {
        return new Promise((resolve, reject) => {
            chrome.storage[area][method](value, (data) => {
                const error = chrome.runtime.lastError;
                if (error) reject(error);
                else resolve(data || {});
            });
        });
    }

    function remove() {
        cancelMove();
        stopGuideTracking();
        host?.remove();
        host = null;
    }

    function cancelMove() {
        moveGeneration++;
        moveAnimation?.cancel();
        moveAnimation = null;
        host?.removeAttribute("data-transition");
    }

    async function moveToStep(nextStep) {
        const target = host;
        if (!target) return false;
        if (typeof target.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
            step = nextStep;
            render();
            return true;
        }
        const token = ++moveGeneration;
        const current = () => !destroyed && host === target && moveGeneration === token;
        target.setAttribute("data-transition", "");
        try {
            moveAnimation = target.animate(
                [
                    { transform: "translateY(0)", opacity: 1 },
                    { transform: "translateY(8px)", opacity: 0 },
                ],
                { duration: 140, easing: "ease-in", fill: "forwards" }
            );
            await moveAnimation.finished;
            if (!current()) return false;
            step = nextStep;
            render();
            moveAnimation.cancel();
            moveAnimation = target.animate(
                [
                    { transform: "translateY(8px)", opacity: 0 },
                    { transform: "translateY(0)", opacity: 1 },
                ],
                { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }
            );
            await moveAnimation.finished;
            return current();
        } catch {
            return false;
        } finally {
            if (moveGeneration === token) {
                moveAnimation?.cancel();
                moveAnimation = null;
                target.removeAttribute("data-transition");
            }
        }
    }

    function focusNavigation() {
        host?.shadowRoot
            .querySelector(step === steps.length - 1 ? '[data-action="finish"]' : '[data-action="next"]')
            ?.focus();
    }

    function positionHost() {
        if (!host) return;
        host.removeAttribute("data-arrow");
        host.style.width = "";
        host.style.top = "";
        const target =
            step === 0
                ? document.getElementById("sidebar")
                : step === 1
                  ? document.getElementById("betterchzzk-multiview-launcher")
                  : step === 2
                    ? getSettingsGuideAnchor()
                    : null;
        if (target !== anchor) {
            anchor = target;
            guideResizeObserver?.disconnect();
            if (anchor) guideResizeObserver?.observe(anchor);
            guideResizeObserver?.observe(host);
        }
        const box = anchor?.getBoundingClientRect();
        if (box?.width > 0 && box.height > 0) {
            const width = Math.min(step === 0 && box.width >= 160 ? box.width - 16 : 240, window.innerWidth - 16);
            host.style.width = `${width}px`;
            const left = Math.max(
                8,
                Math.min(
                    step === 0
                        ? box.width >= 160
                            ? box.left + 8
                            : box.right + 8
                        : box.left + box.width / 2 - width / 2,
                    window.innerWidth - width - 8
                )
            );
            host.style.left = `${left}px`;
            host.style.right = "auto";
            const height = host.getBoundingClientRect().height;
            const top = step === 0 ? box.top + 8 : step === 2 ? box.bottom + 10 : box.top - height - 26;
            host.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
            if (
                (step === 1 && top >= 8) ||
                (step === 2 &&
                    anchor.id === "betterchzzk-multiview-chat-settings" &&
                    top + height <= window.innerHeight - 8)
            ) {
                host.setAttribute("data-arrow", step === 2 ? "top" : "bottom");
                host.style.setProperty(
                    "--arrow-x",
                    `${Math.max(12, Math.min(box.left + box.width / 2 - left, width - 12))}px`
                );
            }
            return;
        }
        if (step === 2) {
            host.style.left = "";
            host.style.right = "12px";
            return;
        }
        // #search-input inside a form was measured on CHZZK's desktop header (2026-09-06).
        const search = document.getElementById("search-input")?.closest("form");
        const rect = search?.getBoundingClientRect();
        if (rect?.width > 0) {
            const width = step < 0 ? 280 : 240;
            host.style.left = `${Math.max(8, Math.min(rect.right + 12, window.innerWidth - width - 12))}px`;
            host.style.right = "auto";
        } else {
            host.style.left = "";
            host.style.right = "";
        }
    }

    function getSettingsGuideAnchor() {
        const button = document.getElementById("betterchzzk-multiview-chat-settings");
        const box = button?.getBoundingClientRect();
        if (box?.width > 0 && box.height > 0) return button;
        // 2026-09-06 /live/6c837d7222ccc4431ca7835a4340be8e:
        // Without multiview, aside#aside-chatting still has a direct h2 "채팅" inside its 44px header.
        const title = document.querySelector("aside#aside-chatting h2");
        return title?.textContent.trim() === "채팅" ? title.parentElement : null;
    }

    function schedulePosition() {
        if (host && step >= 0 && !positionFrame)
            positionFrame = window.requestAnimationFrame(() => {
                positionFrame = 0;
                positionHost();
            });
    }

    function stopGuideTracking() {
        guideObserver?.disconnect();
        guideObserver = null;
        guideResizeObserver?.disconnect();
        guideResizeObserver = null;
        if (positionFrame) window.cancelAnimationFrame(positionFrame);
        positionFrame = 0;
        anchor = null;
        window.removeEventListener("scroll", schedulePosition, true);
        document.removeEventListener("click", onMultiviewLauncherClick, true);
    }

    function trackGuide() {
        if (step < 0) {
            stopGuideTracking();
            return;
        }
        if (guideObserver) return;
        if (typeof ResizeObserver === "function") guideResizeObserver = new ResizeObserver(schedulePosition);
        guideObserver = new MutationObserver((mutations) => {
            if (
                mutations.some(
                    (mutation) =>
                        mutation.target !== host &&
                        (!anchor?.isConnected ||
                            mutation.target.contains?.(anchor) ||
                            anchor.contains?.(mutation.target))
                )
            )
                schedulePosition();
        });
        guideObserver.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style", "aria-hidden"],
        });
        window.addEventListener("scroll", schedulePosition, true);
        document.addEventListener("click", onMultiviewLauncherClick, true);
    }

    function onMultiviewLauncherClick(event) {
        if (step !== 1 || busy || destroyed || !host || event.button !== 0) return;
        const launcher = event.target.closest?.("#betterchzzk-multiview-launcher");
        if (!launcher || launcher !== document.getElementById("betterchzzk-multiview-launcher") || launcher.disabled)
            return;
        const currentHost = host;
        // The launcher stops bubbling. Observe in capture, then let its native click finish before advancing.
        window.queueMicrotask(() => {
            if (host === currentHost && step === 1 && !busy && !destroyed) void act("next", false);
        });
    }

    function syncNavigation() {
        const shadow = host?.shadowRoot;
        const previous = shadow?.querySelector('[data-action="previous"]');
        const next = shadow?.querySelector('[data-action="next"]');
        if (previous) previous.disabled = step <= 0;
        if (next) next.disabled = step >= steps.length - 1;
    }

    function showError(text) {
        const error = host?.shadowRoot.getElementById("error");
        if (error) {
            error.textContent = text;
            error.hidden = false;
        }
    }

    async function act(action, restoreFocus = true) {
        if (busy || destroyed) return;
        busy = true;
        const activeHost = host;
        let focusAfterMove = false;
        activeHost?.shadowRoot.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
        });
        try {
            if (action === "reload") {
                sessionStorage.setItem(RELOAD_GUIDE_KEY, preview ? `preview:${version}` : version);
                location.reload();
            } else if (action === "mute") {
                if (!preview) await storage("sync", "set", { [NOTIFICATIONS_KEY]: false });
                preview = false;
                remove();
            } else if (action === "next") {
                if (step < steps.length - 1) {
                    focusAfterMove = await moveToStep(step + 1);
                }
            } else if (action === "finish" && step === steps.length - 1) {
                if (!preview) await storage("local", "set", { [READ_KEY]: version });
                preview = false;
                remove();
            } else if (action === "previous" && step > 0) {
                focusAfterMove = await moveToStep(step - 1);
            }
        } catch {
            showError("처리하지 못했어요. 잠시 후 다시 눌러 주세요.");
        } finally {
            busy = false;
            if (host === activeHost)
                host?.shadowRoot.querySelectorAll("button").forEach((button) => {
                    button.disabled = false;
                });
            syncNavigation();
            if (focusAfterMove && restoreFocus) focusNavigation();
        }
    }

    function render(focus = false) {
        if (destroyed || !document.documentElement) return;
        if (!host) {
            host = document.createElement("div");
            host.id = ID;
            const shadow = host.attachShadow({ mode: "open" });
            shadow.innerHTML = `<style>
:host{all:initial;position:fixed;z-index:2147483647;top:6px;right:24px;width:min(280px,calc(100vw - 24px));font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--sem-color-content-neutral-cool-strong,#202224)}
:host-context(html.theme_dark){color:var(--sem-color-content-neutral-cool-strong,#dfe2ea)}
:host-context(html.theme_dark) .tag{color:#00ffa3}
section{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--sem-color-border-neutral-base,#d8dde6);border-radius:7px;background:var(--sem-color-surface-neutral-weak,#fff);box-shadow:0 2px 8px #0003}
:host-context(html.theme_dark) section{background:var(--sem-color-surface-neutral-weak,#202224);border-color:var(--sem-color-border-neutral-base,#4d4d4d)}
.copy{flex:1;min-width:0}.tag{display:none;color:#008f5b}h2{margin:0;font-size:11px;line-height:15px;text-align:left}p{margin:0;overflow-wrap:anywhere}#text{font-size:10px;line-height:14px}.buttons{display:flex;flex-shrink:0;gap:4px}button{flex:1 0 auto;font:inherit;white-space:nowrap;cursor:pointer;padding:3px 4px;border-radius:4px;border:1px solid var(--sem-color-border-neutral-base,#d8dde6);background:transparent;color:inherit}button.primary{background:#00ffa3;color:#072b20;border-color:#00ffa3;font-weight:700}button:focus-visible{outline:2px solid #00b977;outline-offset:2px}button:disabled{opacity:.5;cursor:default}#error{color:#d54b4b;font-size:11px;margin-top:4px}[hidden]{display:none!important}
.guide-top{display:none}:host([data-guide]){top:64px;width:min(240px,calc(100vw - 16px));font-size:11px}:host([data-guide]) section{flex-direction:column;align-items:stretch;padding:10px;gap:7px}:host([data-guide]) h2{font-size:12px;line-height:1.5;margin-bottom:4px}:host([data-guide]) #text{font-size:11px;line-height:1.55}:host([data-guide]) .buttons{flex-wrap:wrap;justify-content:flex-end}:host([data-guide]) button{flex:0 0 auto;padding:3px 6px}:host([data-guide]) .guide-top{display:flex;align-items:center;justify-content:space-between;color:var(--sem-color-content-neutral-cool-strong,#697183)}.navigation{display:flex;gap:4px}.navigation button{width:22px;height:22px;padding:0!important;font-size:17px;line-height:18px}.navigation button svg{width:12px;height:12px;display:block;margin:auto;pointer-events:none}
:host([data-arrow])::after{content:"";position:absolute;width:10px;height:10px;left:calc(var(--arrow-x) - 5px);bottom:-5px;transform:rotate(45deg);background:var(--sem-color-surface-neutral-weak,#fff);border-right:1px solid var(--sem-color-border-neutral-base,#d8dde6);border-bottom:1px solid var(--sem-color-border-neutral-base,#d8dde6)}:host([data-arrow="top"])::after{bottom:auto;top:-5px;transform:rotate(225deg)}:host([data-arrow]):host-context(html.theme_dark)::after{background:var(--sem-color-surface-neutral-weak,#202224);border-color:var(--sem-color-border-neutral-base,#4d4d4d)}
@keyframes betterchzzk-guide-nudge{0%,72%,100%{transform:translateY(0)}86%{transform:translateY(-2px)}}
:host([data-guide]){animation:betterchzzk-guide-nudge 3s ease-in-out infinite}
:host([data-transition]){animation:none}
@media(prefers-reduced-motion:reduce){:host([data-guide]){animation:none}}
</style><section aria-label="Better Chzzk 업데이트 안내"><div class="guide-top"><span id="progress" aria-live="polite"></span><div class="navigation"></div></div><div class="copy"><span class="tag">BETTER CHZZK UPDATE</span><div role="status" aria-live="polite"><h2 id="title"></h2><p id="text"></p></div><p id="error" role="status" hidden></p></div><div class="buttons"></div></section>`;
            shadow.addEventListener("click", (event) => {
                const button = event.target.closest?.("button[data-action]");
                if (button) void act(button.dataset.action);
            });
            document.documentElement.appendChild(host);
        }
        const shadow = host.shadowRoot;
        host.toggleAttribute("data-guide", step >= 0);
        host.title = preview
            ? step >= 0
                ? "튜토리얼 다시보기"
                : "업데이트 알림 미리보기 · 실제 설정은 변경되지 않아요"
            : `Better Chzzk ${version} 업데이트`;
        shadow.querySelector(".tag").textContent = preview
            ? step >= 0
                ? "튜토리얼 다시보기"
                : "미리보기 · 실제 설정은 변경되지 않아요"
            : "BETTER CHZZK UPDATE";
        shadow.getElementById("title").textContent = step < 0 ? "Better Chzzk 업데이트 완료" : steps[step].title;
        shadow.getElementById("progress").textContent = step < 0 ? "" : `${step + 1} / ${steps.length}`;
        shadow.getElementById("text").textContent = step < 0 ? "새로고침 후 새 기능을 확인해요." : steps[step].text;
        const buttons = shadow.querySelector(".buttons");
        buttons.replaceChildren();
        const navigation = shadow.querySelector(".navigation");
        navigation.replaceChildren();
        const add = (label, action, primary = false) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.dataset.action = action;
            if (action === "mute") {
                button.setAttribute("aria-label", preview && step >= 0 ? "튜토리얼 닫기" : "업데이트 다시 알리지 않음");
                button.title = preview ? "안내만 닫고 업데이트 알림 설정은 유지해요" : "앞으로 모든 업데이트 알림 끄기";
            }
            if (primary) button.className = "primary";
            if (action === "previous" || action === "next") {
                button.setAttribute("aria-label", label);
                button.title = label;
                button.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="${action === "previous" ? "M8 2 4 6l4 4" : "m4 2 4 4-4 4"}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
                navigation.appendChild(button);
            } else buttons.appendChild(button);
        };
        if (step < 0) {
            add("새로고침", "reload", true);
            add("알림 끄기", "mute");
        } else {
            add("이전", "previous");
            add("다음", "next");
            if (step === steps.length - 1) add("확인", "finish", true);
            add(preview ? "닫기" : "알림 끄기", "mute");
        }
        syncNavigation();
        if (busy)
            shadow.querySelectorAll("button").forEach((button) => {
                button.disabled = true;
            });
        trackGuide();
        positionHost();
        if (focus) focusNavigation();
    }

    async function load() {
        if (preview && !destroyed) {
            render();
            return;
        }
        const token = ++generation;
        try {
            const [local, sync] = await Promise.all([
                storage("local", "get", [UPDATE_KEY, READ_KEY]),
                storage("sync", "get", NOTIFICATIONS_KEY),
            ]);
            if (destroyed || token !== generation) return;
            if (
                sync[NOTIFICATIONS_KEY] === false ||
                local[UPDATE_KEY]?.version !== version ||
                local[READ_KEY] === version
            )
                remove();
            else render();
        } catch {
            /* No verified update state means no update claim. */
        }
    }

    function changed(changes, area) {
        if (
            (area === "local" && (Object.hasOwn(changes, UPDATE_KEY) || Object.hasOwn(changes, READ_KEY))) ||
            (area === "sync" && Object.hasOwn(changes, NOTIFICATIONS_KEY))
        )
            void load();
    }
    function destroy() {
        destroyed = true;
        generation++;
        remove();
        chrome.storage.onChanged.removeListener(changed);
        window.removeEventListener("pageshow", load);
        window.removeEventListener("resize", positionHost);
        document.removeEventListener("DOMContentLoaded", load);
    }
    chrome.storage.onChanged.addListener(changed);
    window.addEventListener("pageshow", load);
    window.addEventListener("resize", positionHost);
    document.addEventListener("DOMContentLoaded", load, { once: true });
    function showPreview(startStep = -1) {
        if (destroyed) return false;
        cancelMove();
        generation++;
        preview = true;
        step = startStep;
        render();
        return Boolean(host?.isConnected);
    }
    globalThis.BetterChzzkUpdateNoticeRuntime = { destroy, showPreview, showTutorial: () => showPreview(0) };
    void load();
})();
