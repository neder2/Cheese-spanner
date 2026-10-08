// Local, nonmodal update notice shared by the CHZZK page and extension options.
(() => {
    "use strict";
    const WIDTH = 300;
    const CSS_TEXT = `
[data-bcug-view],[data-bcug-toast]{--bcug-bg:#fff;--bcug-text:#1d1d1f;--bcug-muted:#636366;--bcug-border:#e0e0e0;--bcug-accent:#006b45;--bcug-hover:#f0f0f2;--bcug-text-color:var(--sem-color-content-neutral-primary,var(--text,var(--bcug-text)));--bcug-muted-color:var(--sem-color-content-neutral-cool-strong,var(--text-muted,var(--bcug-muted)));--bcug-accent-color:var(--sem-color-content-brand-strong,var(--accent-text,var(--bcug-accent)));position:fixed;top:72px;right:12px;z-index:2147483645;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:min(${WIDTH}px,calc(100vw - 24px));max-height:calc(100dvh - 88px);overflow:hidden;padding:14px;border:1px solid var(--sem-color-border-neutral-weak,var(--border,var(--bcug-border)));border-top:2px solid var(--sem-color-border-brand-alpha-base,var(--success-border,rgba(0,230,147,.3)));border-radius:14px;background:var(--sem-color-surface-neutral-weaker,var(--surface,var(--bcug-bg)));background-image:radial-gradient(120% 70% at 100% 0%,color-mix(in srgb,var(--bcug-accent-color) 12%,transparent),transparent 65%);color:var(--bcug-text-color);box-shadow:0 1px 2px #0000000f,0 14px 36px -10px #0000004d;animation:bcug-in .18s ease-out;font:12px/1.5 system-ui,sans-serif;text-align:start;word-break:keep-all;overflow-wrap:anywhere;isolation:isolate}
[data-bcug-view] *,[data-bcug-toast] *{box-sizing:border-box}
[data-bcug-heading]{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}
[data-bcug-heading] h2{display:flex;align-items:center;gap:8px;margin:0;min-width:0;font:650 13px/1.45 system-ui,sans-serif;color:inherit;outline:none}
[data-bcug-heading] h2::before{content:"";flex-shrink:0;width:22px;height:22px;border-radius:7px;background:color-mix(in srgb,var(--bcug-accent-color) 16%,transparent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%2300b073'%3E%3Cpath d='M12 2.5l2.1 6.4 6.4 2.1-6.4 2.1L12 19.5l-2.1-6.4L3.5 11l6.4-2.1z'/%3E%3C/svg%3E") center/14px no-repeat}
[data-bcug-heading] button{display:grid;place-items:center;flex-shrink:0;width:26px;height:26px;padding:0 0 2px;border:0;border-radius:50%;background:transparent;color:var(--bcug-muted-color);font:18px/1 system-ui,sans-serif;cursor:pointer}
[data-bcug-heading] button:hover{background:var(--sem-color-surface-brand-alpha-weak,var(--accent-weak,rgba(0,230,147,.12)));color:var(--bcug-accent-color)}
[data-bcug-heading] button:focus-visible{outline:2px solid var(--focus-ring,var(--bcug-accent-color));outline-offset:2px}
[data-bcug-content]{min-height:0;overflow:auto}
[data-bcug-content] p{margin:0;color:var(--bcug-muted-color)}
[data-bcug-features]{display:grid;gap:8px;list-style:none;margin:0;padding:0}
[data-bcug-features] li{position:relative;display:grid;gap:2px;min-width:0;padding:10px 12px 10px 16px;border:1px solid color-mix(in srgb,var(--bcug-accent-color) 18%,transparent);border-radius:10px;background:color-mix(in srgb,var(--bcug-accent-color) 6%,transparent)}
[data-bcug-features] li::before{content:"";position:absolute;left:7px;top:11px;bottom:11px;width:3px;border-radius:2px;background:var(--bcug-accent-color)}
[data-bcug-features] h3{margin:0;font:650 13px/1.45 system-ui,sans-serif;color:inherit}
[data-bcug-features] p{margin:0;font:12px/1.5 system-ui,sans-serif;color:var(--bcug-muted-color)}
@keyframes bcug-in{from{opacity:0}to{opacity:1}}
[data-bcug-toast]{max-height:none}
[data-bcug-timed]{border-top:0}
[data-bcug-progress]{position:absolute;inset:0 0 auto;height:2px;overflow:hidden;pointer-events:none;background:var(--sem-color-border-brand-alpha-base,var(--success-border,rgba(0,230,147,.3)))}
[data-bcug-progress-fill]{display:block;width:100%;height:100%;transform-origin:left center;background:var(--sem-color-surface-brand-stronger-static,var(--accent,#00e693))}
@media(prefers-color-scheme:dark){:root:not([data-theme]):not(.theme_light):not(.theme_dark) :is([data-bcug-view],[data-bcug-toast]){--bcug-bg:#272729;--bcug-text:#f5f5f7;--bcug-muted:#b4b4ba;--bcug-border:#3d3d40;--bcug-accent:#00e693;--bcug-hover:#2a2a2c}}
:root.theme_dark :is([data-bcug-view],[data-bcug-toast]),:root[data-theme="dark"] :is([data-bcug-view],[data-bcug-toast]){--bcug-bg:#272729;--bcug-text:#f5f5f7;--bcug-muted:#b4b4ba;--bcug-border:#3d3d40;--bcug-accent:#00e693;--bcug-hover:#2a2a2c}
:root.theme_light :is([data-bcug-view],[data-bcug-toast]),:root[data-theme="light"] :is([data-bcug-view],[data-bcug-toast]){--bcug-bg:#fff;--bcug-text:#1d1d1f;--bcug-muted:#636366;--bcug-border:#e0e0e0;--bcug-accent:#006b45;--bcug-hover:#f0f0f2}
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
            ? "betterchzzk-update-toast-title"
            : "betterchzzk-update-guide-title";
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
    globalThis.BetterChzzkUpdateGuideView = Object.freeze({ create, renderContent, CSS_TEXT, WIDTH });
})();
