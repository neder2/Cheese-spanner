(() => {
    const STYLE_ID = "betterchzzk-title-tooltip-style";
    const TOOLTIP_CLASS = "bctt-tooltip";
    const TOOLTIP_ATTR = "data-bctt-tooltip";
    const ACTIVE_ATTR = "data-bctt-active";
    const TITLE_SELECTOR = "a[class*='title'], [class*='title']";
    const ITEM_LINK_SELECTOR = "a[href*='/live/'], a[href*='/video/'], a[href*='/clips/']";
    const CARD_SELECTOR = "article, li, [class*='card'], [class*='item'], [class*='video']";
    const IGNORED_TEXT_SELECTOR = [
        "script",
        "style",
        "noscript",
        "svg",
        "[hidden]",
        "[aria-hidden='true']",
    ].join(", ");
    const VISUALLY_HIDDEN_TOKEN_RE = /(^|[\s_-])(blind|sr-only|screen-reader|visually-hidden|a11y-hidden)([\s_-]|$)/i;
    const HOVER_OPEN_DELAY_MS = 400;
    const TOOLTIP_MAX_WIDTH = 420;
    const STYLE_TEXT = `
.bctt-tooltip{
  display:none;
  position:fixed;
  left:0; top:0;
  width:max-content;
  max-width:min(420px, calc(100vw - 32px));
  padding:8px 10px;
  border:1px solid rgba(17,17,20,0.14);
  border-radius:6px;
  background:#fff;
  color:#111114;
  box-shadow:0 8px 24px rgba(0,0,0,0.18);
  font-family:inherit;
  font-size:13px;
  font-weight:600;
  line-height:18px;
  white-space:normal;
  word-break:break-word;
  z-index:2147483647;
  pointer-events:none;
}
.bctt-tooltip[data-show="1"]{ display:block; }
[data-bctt-active="1"]{
  background:rgba(0,255,163,0.12) !important;
  border-radius:4px;
  box-shadow:0 0 0 1px rgba(0,168,107,0.32);
}
html[dark] .bctt-tooltip,
body[theme="dark"] .bctt-tooltip,
[class*="dark"] .bctt-tooltip{
  border-color:rgba(157,165,182,0.22);
  background:#1B1D20;
  color:#F2F4F7;
  box-shadow:0 10px 30px rgba(0,0,0,0.34);
}
html[dark] [data-bctt-active="1"],
body[theme="dark"] [data-bctt-active="1"],
[class*="dark"] [data-bctt-active="1"]{
  background:rgba(0,255,163,0.16) !important;
  box-shadow:0 0 0 1px rgba(0,255,163,0.4);
}
@media (max-width: 520px){
  .bctt-tooltip{ max-width:calc(100vw - 16px); }
}
`;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let tooltip = null;
    let activeTitleEl = null;
    let pendingTitleEl = null;
    let openTimer = 0;
    let listenersInstalled = false;
    let removePageChangeDetection = null;

    const {
        bindFeatureOptions,
        injectStyleOnce,
        normSpace,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    function isFeatureEnabled() {
        return featureOptions.titleTooltipEnabled;
    }

    function injectStyle() {
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
    }

    function getCardContext(el) {
        let card = el.closest(CARD_SELECTOR);
        if (card === el && !el.matches(ITEM_LINK_SELECTOR)) {
            card = el.parentElement?.closest(CARD_SELECTOR) || el.parentElement;
        }
        return card || el.parentElement;
    }

    function resolveTitleElement(target) {
        if (!(target instanceof Element)) return null;

        const el = target.closest(TITLE_SELECTOR);
        if (!(el instanceof HTMLElement)) return null;
        if (el.closest(`[${TOOLTIP_ATTR}="1"]`)) return null;

        const card = getCardContext(el);
        if (card && !card.querySelector(ITEM_LINK_SELECTOR) && !el.closest(ITEM_LINK_SELECTOR)) return null;
        return el;
    }

    function isTruncated(el) {
        return (el.scrollWidth - el.clientWidth > 1) || (el.scrollHeight - el.clientHeight > 1);
    }

    function isVisuallyHiddenTextElement(el) {
        if (!(el instanceof Element)) return true;
        if (el.matches(IGNORED_TEXT_SELECTOR)) return true;

        const marker = `${el.className || ""} ${el.id || ""}`;
        if (VISUALLY_HIDDEN_TOKEN_RE.test(marker)) return true;

        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
        if (style.clip && style.clip !== "auto") return true;
        if (style.clipPath && style.clipPath !== "none") return true;

        return false;
    }

    function collectReadableText(node, out) {
        if (node.nodeType === Node.TEXT_NODE) {
            out.push(node.nodeValue || "");
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;

        const el = /** @type {Element} */ (node);
        if (isVisuallyHiddenTextElement(el)) return;

        for (const child of el.childNodes) collectReadableText(child, out);
    }

    function getReadableTitleText(el) {
        const chunks = [];
        collectReadableText(el, chunks);
        return normSpace(chunks.join(" "));
    }

    function getFullTitle(el) {
        const text = getReadableTitleText(el);
        if (text) return text;

        const anchor = el.closest("a[aria-label], a[title]") || el.querySelector("a[aria-label], a[title]");
        return normSpace(anchor?.getAttribute("aria-label") || anchor?.getAttribute("title") || "");
    }

    function getTooltip() {
        if (tooltip?.isConnected) return tooltip;

        const el = document.createElement("div");
        el.className = TOOLTIP_CLASS;
        el.setAttribute(TOOLTIP_ATTR, "1");
        document.body.appendChild(el);
        tooltip = el;
        return el;
    }

    function showTooltip(titleEl) {
        const text = getFullTitle(titleEl);
        if (!text) return;

        if (activeTitleEl && activeTitleEl !== titleEl) activeTitleEl.removeAttribute(ACTIVE_ATTR);

        const tip = getTooltip();
        tip.textContent = text;
        activeTitleEl = titleEl;
        titleEl.setAttribute(ACTIVE_ATTR, "1");
        positionTooltip(titleEl);
        tip.setAttribute("data-show", "1");
    }

    function hideTooltip() {
        clearOpenTimer();
        if (activeTitleEl) activeTitleEl.removeAttribute(ACTIVE_ATTR);
        activeTitleEl = null;
        if (tooltip) tooltip.removeAttribute("data-show");
    }

    function clearOpenTimer() {
        if (!openTimer) return;
        window.clearTimeout(openTimer);
        openTimer = 0;
        pendingTitleEl = null;
    }

    function positionTooltip(anchor) {
        if (!tooltip || !anchor?.isConnected) return;

        const margin = 8;
        const gap = 4;
        const maxWidth = Math.max(160, Math.min(TOOLTIP_MAX_WIDTH, window.innerWidth - margin * 2));

        tooltip.style.maxWidth = `${maxWidth}px`;
        tooltip.style.left = "0px";
        tooltip.style.top = "0px";
        tooltip.style.visibility = "hidden";
        tooltip.setAttribute("data-show", "1");

        const a = anchor.getBoundingClientRect();
        const t = tooltip.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - t.width - margin);
        const left = Math.min(Math.max(margin, a.left), maxLeft);

        let top = a.top - t.height - gap;
        if (top < margin) top = a.bottom + gap;
        if (top + t.height > window.innerHeight - margin) {
            top = Math.max(margin, window.innerHeight - t.height - margin);
        }

        tooltip.style.left = `${Math.round(left)}px`;
        tooltip.style.top = `${Math.round(top)}px`;
        tooltip.style.visibility = "";
    }

    function handlePointerOver(event) {
        const titleEl = resolveTitleElement(event.target);
        if (!titleEl) return;
        if (titleEl === activeTitleEl) return;
        if (!isTruncated(titleEl)) return;

        clearOpenTimer();
        pendingTitleEl = titleEl;
        openTimer = window.setTimeout(() => {
            openTimer = 0;
            if (pendingTitleEl === titleEl && titleEl.isConnected && isTruncated(titleEl)) showTooltip(titleEl);
            pendingTitleEl = null;
        }, HOVER_OPEN_DELAY_MS);
    }

    function handlePointerOut(event) {
        if (!activeTitleEl && !openTimer) return;

        const currentTitleEl = activeTitleEl || pendingTitleEl || resolveTitleElement(event.target);
        const related = event.relatedTarget;
        if (related instanceof Node && currentTitleEl?.contains(related)) return;

        const movedToSameTitle = related instanceof Element && resolveTitleElement(related) === currentTitleEl;
        if (movedToSameTitle) return;

        hideTooltip();
    }

    function handleScroll() {
        if (activeTitleEl?.isConnected) positionTooltip(activeTitleEl);
        else hideTooltip();
    }

    function handleResize() {
        if (activeTitleEl?.isConnected) positionTooltip(activeTitleEl);
        else hideTooltip();
    }

    function installListeners() {
        if (listenersInstalled) return;

        listenersInstalled = true;
        injectStyle();
        document.addEventListener("pointerover", handlePointerOver, true);
        document.addEventListener("pointerout", handlePointerOut, true);
        window.addEventListener("scroll", handleScroll, true);
        window.addEventListener("resize", handleResize);
        removePageChangeDetection = startPageChangeDetection(hideTooltip);
    }

    function uninstallListeners() {
        if (!listenersInstalled) return;

        listenersInstalled = false;
        document.removeEventListener("pointerover", handlePointerOver, true);
        document.removeEventListener("pointerout", handlePointerOut, true);
        window.removeEventListener("scroll", handleScroll, true);
        window.removeEventListener("resize", handleResize);

        if (removePageChangeDetection) {
            removePageChangeDetection();
            removePageChangeDetection = null;
        }

        hideTooltip();
        if (tooltip) {
            tooltip.remove();
            tooltip = null;
        }
        document.getElementById(STYLE_ID)?.remove();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isFeatureEnabled()) installListeners();
        else uninstallListeners();
    }

    bindFeatureOptions(applyOptions);
    onReady(() => {
        if (isFeatureEnabled()) installListeners();
    });
})();
