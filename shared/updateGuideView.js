// Local, nonmodal update notice shared by the CHZZK page and extension options.
// Flat CHZZK-style card. Every --bcug-* alias reads the shared CHZZK theme (--bct-*, shared/uiTheme.js, requested by
// features/updateGuide.js) first and falls back to the extension page tokens of styles.css, which carry the same
// measured values, so both documents draw the same card without a palette of their own.
(() => {
    "use strict";
    const WIDTH = 300;
    const CSS_TEXT = `
[data-bcug-view],[data-bcug-toast]{--bcug-surface:var(--bct-surface,var(--surface));--bcug-item:var(--bct-surface-weak,var(--surface-2));--bcug-track:var(--bct-surface-base,var(--surface-3));--bcug-border:var(--bct-border,var(--border));--bcug-text:var(--bct-text,var(--text));--bcug-muted:var(--bct-text-muted,var(--text-muted));--bcug-brand:var(--bct-brand,var(--accent));--bcug-hover:var(--bct-hover,color-mix(in srgb,var(--text) 5%,transparent));--bcug-focus:var(--bct-focus-ring,var(--focus-ring));--bcug-shadow:var(--bct-shadow,var(--shadow-2));--bcug-font:var(--bct-font,var(--options-font));--bcug-radius:var(--bct-radius-lg,12px);--bcug-radius-item:var(--bct-radius-md,8px);--bcug-radius-full:var(--bct-radius-full,9999px);position:fixed;top:72px;right:12px;z-index:2147483645;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(${WIDTH}px,calc(100vw - 24px));max-height:calc(100dvh - 88px);overflow:hidden;padding:14px;border:1px solid var(--bcug-border);border-radius:var(--bcug-radius);background:var(--bcug-surface);color:var(--bcug-text);box-shadow:var(--bcug-shadow);animation:bcug-in .18s ease-out;font-family:var(--bcug-font);font-size:12px;font-weight:400;line-height:1.5;letter-spacing:0;text-align:start;word-break:keep-all;overflow-wrap:anywhere;isolation:isolate}
[data-bcug-view] *,[data-bcug-toast] *{box-sizing:border-box}
[data-bcug-heading]{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}
[data-bcug-heading] h2{margin:0;min-width:0;font-family:inherit;font-size:13px;font-weight:700;line-height:1.45;color:inherit;outline:none}
[data-bcug-heading] button{display:grid;place-items:center;flex-shrink:0;width:26px;height:26px;padding:0 0 2px;border:0;border-radius:var(--bcug-radius-full);background:transparent;color:var(--bcug-muted);font-family:inherit;font-size:18px;line-height:1;cursor:pointer}
[data-bcug-heading] button:hover{background:var(--bcug-hover);color:var(--bcug-text)}
[data-bcug-heading] button:focus-visible{outline:2px solid var(--bcug-focus);outline-offset:2px}
[data-bcug-content]{min-height:0;overflow:auto}
[data-bcug-content] p{margin:0;color:var(--bcug-muted)}
[data-bcug-features]{display:grid;gap:8px;list-style:none;margin:0;padding:0}
[data-bcug-features] li{display:grid;gap:2px;min-width:0;padding:10px 12px;border-radius:var(--bcug-radius-item);background:var(--bcug-item)}
[data-bcug-features] h3{margin:0;font-family:inherit;font-size:13px;font-weight:600;line-height:1.45;color:var(--bcug-text)}
[data-bcug-features] p{margin:0;font-family:inherit;font-size:12px;line-height:1.5;color:var(--bcug-muted)}
@keyframes bcug-in{from{opacity:0}to{opacity:1}}
[data-bcug-toast]{max-height:none}
[data-bcug-progress]{position:absolute;inset:0 0 auto;height:2px;overflow:hidden;pointer-events:none;background:var(--bcug-track)}
[data-bcug-progress-fill]{display:block;width:100%;height:100%;transform-origin:left center;background:var(--bcug-brand)}
@media(max-width:480px){[data-bcug-view],[data-bcug-toast]{top:64px;max-height:calc(100dvh - 76px)}[data-bcug-toast]{max-height:none}}
@media(prefers-reduced-motion:reduce){[data-bcug-view],[data-bcug-toast]{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

    function renderContent(root, guide, onClose) {
        const document = root.ownerDocument;
        const element = (tag, text) => {
            const node = document.createElement(tag);
            if (text !== undefined) node.textContent = text;
            return node;
        };
        const heading = element("div");
        heading.dataset.bcugHeading = "";
        const title = element("h2", `치즈 스패너 ${guide.version} ${guide.title}`);
        title.id = root.hasAttribute("data-bcug-toast")
            ? "cheese-spanner-update-toast-title"
            : "cheese-spanner-update-guide-title";
        const close = element("button", "×");
        close.type = "button";
        close.dataset.bcugAction = "close";
        close.setAttribute("aria-label", "닫기");
        close.addEventListener("click", onClose);
        heading.append(title, close);
        const body = element("div");
        body.dataset.bcugContent = "";
        if (guide.cards.length) {
            const list = element("ul");
            list.dataset.bcugFeatures = "";
            for (const card of guide.cards) {
                const item = element("li");
                item.append(element("h3", card.title));
                if (card.instructions.length) item.append(element("p", card.instructions.join(" ")));
                list.append(item);
            }
            body.append(list);
        } else body.append(element("p", guide.summary));
        root.replaceChildren(heading, body);
        return { title, body };
    }

    function create({ document, guide, onClose = () => {}, focusOnOpen = true }) {
        let root = null,
            style = null,
            priorFocus = null;
        let restoreFocus = true,
            destroyed = false;
        function focusChanged(event) {
            if (root && !root.contains(event.target) && event.target !== document.body) restoreFocus = false;
        }
        function keydown(event) {
            if (event.key !== "Escape" || !root?.contains(document.activeElement)) return;
            event.preventDefault();
            event.stopPropagation();
            close();
        }
        function fullscreenChanged() {
            if (document.fullscreenElement) dismiss(false);
        }
        function dismiss(returnFocus) {
            if (!root) return;
            const shouldRestore =
                returnFocus && restoreFocus && root.contains(document.activeElement) && priorFocus?.isConnected;
            document.removeEventListener("focusin", focusChanged);
            document.removeEventListener("fullscreenchange", fullscreenChanged);
            root.remove();
            style.remove();
            root = style = null;
            if (shouldRestore) priorFocus.focus({ preventScroll: true });
            onClose();
        }
        function close() {
            dismiss(true);
        }
        function open() {
            if (
                destroyed ||
                root ||
                !document.body ||
                !Array.isArray(guide?.cards) ||
                document.visibilityState === "hidden" ||
                document.fullscreenElement
            )
                return false;
            priorFocus = document.activeElement;
            restoreFocus = true;
            style = document.createElement("style");
            style.textContent = CSS_TEXT;
            root = document.createElement("section");
            root.dataset.bcugView = "";
            root.setAttribute("role", "dialog");
            root.setAttribute("aria-modal", "false");
            const { title } = renderContent(root, guide, close);
            title.tabIndex = -1;
            root.setAttribute("aria-labelledby", title.id);
            root.addEventListener("keydown", keydown);
            document.body.append(style, root);
            document.addEventListener("focusin", focusChanged);
            document.addEventListener("fullscreenchange", fullscreenChanged);
            if (focusOnOpen) title.focus({ preventScroll: true });
            return true;
        }
        return {
            open,
            close,
            get element() {
                return root;
            },
            destroy() {
                destroyed = true;
                dismiss(false);
            },
        };
    }
    globalThis.CheeseSpannerUpdateGuideView = Object.freeze({ create, renderContent, CSS_TEXT, WIDTH });
})();
