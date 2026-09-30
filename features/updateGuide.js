// Updates are consumed by the worker before this document may display its notice.
(() => {
    "use strict";
    const ns = globalThis.BetterChzzk;
    const catalog = globalThis.BetterChzzkUpdateGuide,
        views = globalThis.BetterChzzkUpdateGuideView;
    if (
        !ns ||
        ns.updateGuide ||
        !catalog ||
        !views ||
        window.top !== window ||
        location.origin !== "https://chzzk.naver.com"
    )
        return;
    const runtime = globalThis.chrome?.runtime,
        settings = globalThis.BetterChzzkSettings;
    if (!runtime || !settings || !ns.utils?.startPageChangeDetection) return;
    const guide = catalog.getGuide(runtime.getManifest().version);
    const DISPLAY_DURATION_MS = 20000;
    const clientId = globalThis.crypto.randomUUID();
    let stopped = false,
        suspended = false,
        loaded = false,
        enabled = false,
        finished = !guide,
        inFlight = false,
        generation = 0;
    let delay = 0,
        toast = null,
        toastStyle = null,
        timedNotice = null,
        dismissTimedNotice = null,
        progressAnimation = null,
        expiry = 0,
        remaining = DISPLAY_DURATION_MS,
        started = 0,
        hovered = false;
    let tutorial = null,
        waitForLayout = false;

    function send(action, extra = {}) {
        return new Promise((resolve) => {
            try {
                runtime.sendMessage(
                    {
                        type: catalog.MESSAGE_TYPE,
                        protocol: catalog.PROTOCOL,
                        action,
                        guideVersion: guide.version,
                        clientId,
                        ...extra,
                    },
                    (response) => {
                        const error = runtime.lastError;
                        resolve(error ? null : response);
                    }
                );
            } catch {
                resolve(null);
            }
        });
    }
    function editable(node) {
        return !!node?.closest?.(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'
        );
    }
    function visible() {
        return !suspended && document.visibilityState === "visible" && !document.fullscreenElement && !!document.body;
    }
    function eligible() {
        return !stopped && loaded && enabled && visible() && document.hasFocus() && !editable(document.activeElement);
    }
    function pauseTimer() {
        if (!expiry) return;
        window.clearTimeout(expiry);
        expiry = 0;
        remaining = Math.max(0, remaining - (performance.now() - started));
        if (progressAnimation) {
            progressAnimation.pause();
            progressAnimation.currentTime = DISPLAY_DURATION_MS - remaining;
        }
    }
    function resumeTimer() {
        pauseTimer();
        if (
            !timedNotice ||
            timedNotice.hasAttribute("inert") ||
            !visible() ||
            !document.hasFocus() ||
            hovered ||
            timedNotice.contains(document.activeElement)
        )
            return;
        if (remaining <= 0) {
            expireCountdown();
            return;
        }
        started = performance.now();
        if (progressAnimation) {
            progressAnimation.currentTime = DISPLAY_DURATION_MS - remaining;
            progressAnimation.play();
        }
        expiry = window.setTimeout(expireCountdown, remaining);
    }
    function stopCountdown() {
        pauseTimer();
        progressAnimation?.cancel();
        progressAnimation = null;
        timedNotice = dismissTimedNotice = null;
        hovered = false;
    }
    function expireCountdown() {
        const dismiss = dismissTimedNotice;
        stopCountdown();
        dismiss?.();
    }
    function startCountdown(node, dismiss) {
        stopCountdown();
        timedNotice = node;
        dismissTimedNotice = dismiss;
        remaining = DISPLAY_DURATION_MS;
        hovered = node.matches(":hover");
        const fill = node.querySelector("[data-bcug-progress-fill]");
        try {
            progressAnimation = fill.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], {
                duration: DISPLAY_DURATION_MS,
                easing: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "steps(20, end)" : "linear",
                fill: "both",
            });
            progressAnimation.pause();
            progressAnimation.currentTime = 0;
        } catch {
            // A visual effect failure must not prevent the notice from expiring.
            progressAnimation?.cancel();
            progressAnimation = null;
            fill.parentElement.remove();
            node.removeAttribute("data-bcug-timed");
        }
        resumeTimer();
    }
    function prepareCountdown(node) {
        node.dataset.bcugTimed = "";
        node.setAttribute(
            "aria-description",
            "20초 뒤 자동으로 닫혀요. 안내를 살펴보거나 화면을 떠난 동안에는 시간이 멈춰요."
        );
        const progress = document.createElement("div");
        progress.dataset.bcugProgress = "";
        progress.setAttribute("aria-hidden", "true");
        const fill = document.createElement("span");
        fill.dataset.bcugProgressFill = "";
        progress.append(fill);
        node.prepend(progress);
        node.addEventListener("mouseenter", () => {
            if (timedNotice !== node) return;
            hovered = true;
            pauseTimer();
        });
        node.addEventListener("mouseleave", () => {
            if (timedNotice !== node) return;
            hovered = false;
            resumeTimer();
        });
        node.addEventListener("focusin", () => {
            if (timedNotice === node) pauseTimer();
        });
    }
    function removeToast() {
        if (timedNotice === toast) stopCountdown();
        toast?.remove();
        toastStyle?.remove();
        toast = toastStyle = null;
    }
    function clearDelay() {
        if (delay) window.clearTimeout(delay);
        delay = 0;
    }
    function cancelPending() {
        generation++;
        clearDelay();
    }
    function removeTutorial() {
        const current = tutorial;
        tutorial = null;
        current?.destroy();
    }
    function openTutorial() {
        if (!guide || !visible() || stopped) return false;
        finished = true;
        cancelPending();
        removeToast();
        removeTutorial();
        let root = null;
        const next = views.create({
            document,
            guide,
            focusOnOpen: false,
            onClose() {
                if (tutorial === next) tutorial = null;
                if (timedNotice === root) stopCountdown();
            },
        });
        tutorial = next;
        if (!next.open()) {
            tutorial = null;
            next.destroy();
            return false;
        }
        root = next.element;
        prepareCountdown(root);
        startCountdown(root, next.close);
        return true;
    }
    function showToast() {
        if (!toast || !placeToast()) {
            removeToast();
            return;
        }
        toast.style.removeProperty("visibility");
        toast.removeAttribute("aria-hidden");
        toast.removeAttribute("inert");
        startCountdown(toast, removeToast);
    }
    function prepareToast() {
        const node = document.createElement("section");
        node.dataset.bcugToast = "";
        node.setAttribute("aria-label", "치즈 스패너 새 기능 안내");
        const style = document.createElement("style");
        style.textContent = views.CSS_TEXT;
        const { body } = views.renderContent(node, guide, removeToast);
        prepareCountdown(node);
        body.setAttribute("role", "status");
        node.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && node.contains(document.activeElement)) {
                event.preventDefault();
                event.stopPropagation();
                removeToast();
            }
        });
        toast = node;
        toastStyle = style;
        remaining = DISPLAY_DURATION_MS;
        node.style.visibility = "hidden";
        node.setAttribute("aria-hidden", "true");
        node.setAttribute("inert", "");
        document.body.append(style, node);
        if (!placeToast()) {
            removeToast();
            return false;
        }
        return true;
    }
    function placeToast() {
        if (!toast) return false;
        const width = Math.min(views.WIDTH, window.innerWidth - 24);
        toast.style.width = `${width}px`;
        const measured = toast.getBoundingClientRect();
        const height = Math.max(measured.height, toast.scrollHeight);
        if (width < 200 || !Number.isFinite(height) || height <= 0 || height > window.innerHeight - 88) return false;
        const obstacles = [];
        const video = ns.utils.getMainVideoElement?.();
        const videoRect = video && (ns.utils.getVideoViewportRect?.(video) || video.getBoundingClientRect());
        if (videoRect?.width > 0 && videoRect.height > 0) {
            obstacles.push({
                left: videoRect.left + videoRect.width * 0.2,
                right: videoRect.left + videoRect.width * 0.8,
                top: videoRect.top + videoRect.height * 0.2,
                bottom: videoRect.top + videoRect.height * 0.8,
            });
            obstacles.push({
                left: videoRect.left,
                right: videoRect.right,
                top: videoRect.bottom - 72,
                bottom: videoRect.bottom,
            });
        }
        for (const input of document.querySelectorAll(
            'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],.pzp-pc__bottom,.pzp-pc__top'
        )) {
            const rect = input.getBoundingClientRect(),
                css = getComputedStyle(input);
            if (rect.width > 0 && rect.height > 0 && css.display !== "none" && css.visibility !== "hidden")
                obstacles.push(rect);
        }
        const top = window.innerWidth <= 480 ? 64 : 72;
        const candidates = [window.innerWidth - width - 12, 12, (window.innerWidth - width) / 2];
        for (const left of candidates) {
            const rect = { left, right: left + width, top, bottom: top + height };
            if (
                obstacles.some(
                    (other) =>
                        rect.left < other.right &&
                        rect.right > other.left &&
                        rect.top < other.bottom &&
                        rect.bottom > other.top
                )
            )
                continue;
            toast.style.left = `${left}px`;
            toast.style.right = "auto";
            toast.style.top = `${top}px`;
            return true;
        }
        return false;
    }
    async function attempt() {
        delay = 0;
        if (finished || inFlight || !eligible()) return;
        if (!prepareToast()) {
            waitForLayout = true;
            return;
        }
        inFlight = true;
        const current = generation;
        try {
            const claim = await send("claim");
            if (!claim?.ok || typeof claim.token !== "string" || !claim.token) {
                finished = true;
                removeToast();
                return;
            }
            if (current !== generation || !eligible() || finished) {
                removeToast();
                await send("release", { token: claim.token });
                return;
            }
            if (!placeToast()) {
                waitForLayout = true;
                removeToast();
                await send("release", { token: claim.token });
                return;
            }
            // An uncertain commit must never become another automatic attempt.
            finished = true;
            const response = await send("commit", { token: claim.token });
            if (current === generation && eligible() && response?.ok === true && response.show === true) showToast();
            else removeToast();
        } finally {
            inFlight = false;
            schedule();
        }
    }
    function schedule() {
        if (finished || inFlight || delay || waitForLayout || !eligible()) return;
        delay = window.setTimeout(attempt, 2000);
    }
    function visibilityChanged() {
        if (document.fullscreenElement) {
            cancelPending();
            removeToast();
            removeTutorial();
        } else if (!visible()) {
            blurred();
        } else {
            waitForLayout = false;
            resumeTimer();
            schedule();
        }
    }
    function blurred() {
        cancelPending();
        if (toast?.hasAttribute("inert")) removeToast();
        else pauseTimer();
    }
    function focused() {
        resumeTimer();
        schedule();
    }
    function focusChanged() {
        if (editable(document.activeElement)) cancelPending();
        else schedule();
        if (timedNotice) resumeTimer();
    }
    function routeChanged() {
        cancelPending();
        removeToast();
        removeTutorial();
        waitForLayout = false;
        schedule();
    }
    function layoutChanged() {
        waitForLayout = false;
        if (toast && !placeToast()) {
            waitForLayout = true;
            cancelPending();
            removeToast();
        }
        schedule();
    }
    function applyOptions(options) {
        if (stopped) return;
        loaded = true;
        enabled = options[catalog.OPTION_KEY] === true;
        if (!enabled) {
            finished = true;
            cancelPending();
            removeToast();
        } else schedule();
    }
    function replay(message, sender, respond) {
        if (message?.type !== catalog.MESSAGE_TYPE || message.action !== "replay") return false;
        let trusted = false;
        try {
            const url = new URL(sender.url),
                expected = new URL(runtime.getURL("options.html"));
            trusted =
                sender.id === runtime.id &&
                url.protocol === expected.protocol &&
                url.hostname === expected.hostname &&
                url.pathname === expected.pathname &&
                !url.search &&
                !url.username &&
                !url.password &&
                !url.port;
        } catch {
            /* Invalid senders have no view capability. */
        }
        const ok =
            trusted &&
            message.protocol === catalog.PROTOCOL &&
            message.guideVersion === guide?.version &&
            openTutorial();
        respond({ ok: !!ok });
        return false;
    }
    function pageHidden(event) {
        if (!event.persisted) {
            stop();
            return;
        }
        // BFCache preserves this document and its receiver; only its active UI is disposable.
        suspended = true;
        cancelPending();
        removeToast();
        removeTutorial();
    }
    function pageShown(event) {
        if (!event.persisted || !suspended || stopped) return;
        suspended = false;
        loaded = false;
        waitForLayout = false;
        // Kept listeners receive option changes while cached; re-read before preparing a new notice.
        settings.getOptions(applyOptions);
    }
    function stop() {
        if (stopped) return;
        stopped = true;
        cancelPending();
        removeToast();
        removeTutorial();
        removeOptions();
        removeRoute();
        runtime.onMessage.removeListener(replay);
        document.removeEventListener("visibilitychange", visibilityChanged);
        document.removeEventListener("fullscreenchange", visibilityChanged);
        document.removeEventListener("focusin", focusChanged);
        document.removeEventListener("focusout", focusChanged);
        document.removeEventListener("DOMContentLoaded", schedule);
        window.removeEventListener("blur", blurred);
        window.removeEventListener("focus", focused);
        window.removeEventListener("pagehide", pageHidden);
        window.removeEventListener("pageshow", pageShown);
        window.removeEventListener("resize", layoutChanged);
        document.removeEventListener("loadedmetadata", layoutChanged, true);
    }
    ns.updateGuide = { stop };
    const removeOptions = settings.addOptionsChangeListener(applyOptions),
        removeRoute = ns.utils.startPageChangeDetection(routeChanged);
    runtime.onMessage.addListener(replay);
    document.addEventListener("visibilitychange", visibilityChanged);
    document.addEventListener("fullscreenchange", visibilityChanged);
    document.addEventListener("focusin", focusChanged);
    document.addEventListener("focusout", focusChanged);
    document.addEventListener("DOMContentLoaded", schedule);
    window.addEventListener("blur", blurred);
    window.addEventListener("focus", focused);
    window.addEventListener("pagehide", pageHidden);
    window.addEventListener("pageshow", pageShown);
    window.addEventListener("resize", layoutChanged);
    document.addEventListener("loadedmetadata", layoutChanged, true);
    settings.getOptions(applyOptions);
})();
