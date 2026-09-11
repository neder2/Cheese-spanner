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
    const { UPDATE_KEY, READ_KEY, NOTIFICATIONS_KEY } = globalThis.BetterChzzkUpdateNotice;
    const version = chrome.runtime.getManifest().version;
    const ID = "betterchzzk-update-notice";
    document.getElementById(ID)?.remove();
    let host = null;
    let generation = 0;
    let destroyed = false;
    let busy = false;
    try {
        // Discard a continuation saved by older versions; no tutorial is opened.
        sessionStorage.removeItem("betterchzzkUpdateGuideAfterReload");
    } catch {
        /* Session storage is optional for the refresh notice. */
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
        host?.remove();
        host = null;
    }

    function positionHost() {
        if (!host) return;
        const rect = document.getElementById("search-input")?.closest("form")?.getBoundingClientRect();
        if (rect?.width > 0) {
            host.style.left = `${Math.max(8, Math.min(rect.right + 12, window.innerWidth - 280 - 12))}px`;
            host.style.right = "auto";
        } else {
            host.style.left = "";
            host.style.right = "";
        }
    }

    function showError(text) {
        const error = host?.shadowRoot.getElementById("error");
        if (error) {
            error.textContent = text;
            error.hidden = false;
        }
    }

    async function act(action) {
        if (busy || destroyed) return;
        busy = true;
        const activeHost = host;
        activeHost?.shadowRoot.querySelectorAll("button").forEach((button) => {
            button.disabled = true;
        });
        try {
            if (action === "reload") {
                await storage("local", "set", { [READ_KEY]: version });
                if (!destroyed) location.reload();
            } else if (action === "mute") {
                await storage("sync", "set", { [NOTIFICATIONS_KEY]: false });
                remove();
            }
        } catch {
            showError("처리하지 못했어요. 잠시 후 다시 눌러 주세요.");
        } finally {
            busy = false;
            if (host === activeHost)
                host?.shadowRoot.querySelectorAll("button").forEach((button) => {
                    button.disabled = false;
                });
        }
    }

    function render() {
        if (destroyed || !document.documentElement) return;
        if (!host) {
            host = document.createElement("div");
            host.id = ID;
            const shadow = host.attachShadow({ mode: "open" });
            shadow.innerHTML = `<style>
:host{all:initial;position:fixed;z-index:2147483647;top:6px;right:24px;width:min(280px,calc(100vw - 24px));font:11px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--sem-color-content-neutral-cool-strong,#202224)}
:host-context(html.theme_dark){color:var(--sem-color-content-neutral-cool-strong,#dfe2ea)}
section{display:flex;align-items:center;gap:8px;padding:7px 8px;border:1px solid var(--sem-color-border-neutral-base,#d8dde6);border-radius:7px;background:var(--sem-color-surface-neutral-weak,#fff);box-shadow:0 2px 8px #0003}
:host-context(html.theme_dark) section{background:var(--sem-color-surface-neutral-weak,#202224);border-color:var(--sem-color-border-neutral-base,#4d4d4d)}
.copy{flex:1;min-width:0}h2{margin:0;font-size:11px;line-height:15px;text-align:left}p{margin:0;overflow-wrap:anywhere}#text{font-size:10px;line-height:14px}.buttons{display:flex;flex-shrink:0;gap:4px}button{flex:1 0 auto;font:inherit;white-space:nowrap;cursor:pointer;padding:3px 4px;border-radius:4px;border:1px solid var(--sem-color-border-neutral-base,#d8dde6);background:transparent;color:inherit}button.primary{background:#00ffa3;color:#072b20;border-color:#00ffa3;font-weight:700}button:focus-visible{outline:2px solid #00b977;outline-offset:2px}button:disabled{opacity:.5;cursor:default}#error{color:#d54b4b;font-size:11px;margin-top:4px}[hidden]{display:none!important}</style><section aria-label="Better Chzzk 업데이트 안내"><div class="copy"><div role="status" aria-live="polite"><h2 id="title">Better Chzzk 업데이트 완료</h2><p id="text">새로고침해서 업데이트를 적용해 주세요.</p></div><p id="error" role="status" hidden></p></div><div class="buttons"><button type="button" data-action="reload" class="primary">새로고침</button><button type="button" data-action="mute" aria-label="업데이트 다시 알리지 않음" title="앞으로 모든 업데이트 알림 끄기">알림 끄기</button></div></section>`;
            shadow.addEventListener("click", (event) => {
                const button = event.target.closest?.("button[data-action]");
                if (button) void act(button.dataset.action);
            });
            document.documentElement.appendChild(host);
        }
        host.title = `Better Chzzk ${version} 업데이트`;
        positionHost();
    }

    async function load() {
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
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("resize", positionHost);
        document.removeEventListener("DOMContentLoaded", load);
    }
    function onPageHide(event) {
        if (!event.persisted) destroy();
    }
    chrome.storage.onChanged.addListener(changed);
    window.addEventListener("pageshow", load);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("resize", positionHost);
    document.addEventListener("DOMContentLoaded", load, { once: true });
    globalThis.BetterChzzkUpdateNoticeRuntime = { destroy };
    void load();
})();
