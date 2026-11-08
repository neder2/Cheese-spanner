/** 채팅 헤더의 네이티브 더보기 메뉴 안에서 문구 숨김 설정을 편집한다. */
(() => {
    "use strict";
    const root = (window.CheeseSpanner = window.CheeseSpanner || {});
    const namespace = (root.chatTools = root.chatTools || {});
    if (namespace.keywordSettingsInstalled) return;
    namespace.keywordSettingsInstalled = true;
    const settings = globalThis.CheeseSpannerSettings;
    const {
        createMutationObserverSync,
        createThrottledDomSync,
        ensureUiTheme,
        injectStyleOnce,
        isLiveRoute,
        onReady,
        settingsStoreSet,
        startPageChangeDetection,
        startStorageChangeListener,
        storageGet,
    } = root.utils;
    const KEYS = [
        "chatKeywordFilterEnabled",
        "chatKeywordFilterWords",
        "chatKeywordFilterApplyMode",
        "chatKeywordFilterMatchMode",
        "chatKeywordFilterExactWords",
    ];
    const ENTRY = "data-bcct-keyword-settings-entry";
    const PANEL = "data-bcct-keyword-settings-panel";
    const STYLE_ID = "cheese-spanner-chat-keyword-settings-style";
    const STYLE = `
[${PANEL}]{position:fixed;z-index:10020;box-sizing:border-box;width:340px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;padding:16px;border:1px solid var(--bct-border);border-radius:var(--bct-radius-lg);background:var(--bct-surface);color:var(--bct-text);box-shadow:var(--bct-shadow);font:13px/1.5 var(--bct-font);text-align:left;overflow-wrap:anywhere;overscroll-behavior:contain}
[${PANEL}] *{box-sizing:border-box}
[${PANEL}] h2{margin:0 0 12px;font:700 15px/1.4 var(--bct-font);color:var(--bct-text)}
[${PANEL}] label{display:block;margin:10px 0 6px;color:var(--bct-text)}
[${PANEL}] .bcct-keyword-toggle{display:flex;gap:8px;align-items:center}
[${PANEL}] input[type=checkbox]{width:16px;height:16px;flex:none;accent-color:var(--bct-brand-text)}
[${PANEL}] textarea{display:block;width:100%;min-height:120px;max-height:240px;resize:vertical;padding:8px;border:1px solid var(--bct-border-strong);border-radius:var(--bct-radius-sm);background:var(--bct-surface-weak);color:var(--bct-text);font:inherit;line-height:1.5}
[${PANEL}] select{max-width:100%;padding:6px;border:1px solid var(--bct-border-strong);border-radius:var(--bct-radius-sm);background:var(--bct-surface-weak);color:var(--bct-text);font:inherit}
[${PANEL}] .bcct-keyword-choice{display:flex;align-items:center;justify-content:space-between;gap:8px}
[${PANEL}] [data-field=rules]{max-height:200px;overflow-y:auto;overscroll-behavior:contain;padding:4px}
[${PANEL}] [data-field=rules] label{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:8px;margin:0 0 8px}
[${PANEL}] p{margin:6px 0;color:var(--bct-text-muted);font-size:12px}
[${PANEL}] [role=status]{min-height:18px;color:var(--bct-text-body)}
[${PANEL}][data-error=true] [role=status]{color:var(--bct-danger)}
[${PANEL}] .bcct-keyword-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px}
[${PANEL}] button{padding:7px 12px;border:1px solid var(--bct-border);border-radius:var(--bct-radius-sm);background:var(--bct-surface-weak);color:var(--bct-text);font:inherit;cursor:pointer}
[${PANEL}] button[data-action=save]{background:var(--bct-brand);color:var(--bct-on-brand);border-color:transparent;font-weight:700}
[${PANEL}] button:disabled{opacity:.5;cursor:default}
[${PANEL}] :is(button,input,textarea,select):focus-visible{outline:2px solid var(--bct-brand-text);outline-offset:2px}
[${PANEL}] [hidden]{display:none!important}
`;
    let observer = null;
    let removeRouteListener = null;
    let entry = null;
    let session = null;
    let suspended = false;
    const sync = createThrottledDomSync(syncMenu, 80);

    function host() {
        return isLiveRoute() ? document.querySelector("aside#aside-chatting") : null;
    }
    function nativeMenu() {
        const chat = host();
        if (!chat) return null;
        // 2026-11-08 live and /live/{id}/chat: the header menu is outside the chat log.
        for (const trigger of chat.querySelectorAll(
            'button[aria-label="더보기 메뉴"][aria-haspopup="true"][aria-expanded="true"]'
        )) {
            if (trigger.closest('[role="log"]') || trigger.closest(`[${PANEL}]`)) continue;
            const parent = trigger.parentElement;
            // The moderator panel wraps the native trigger, while its menu stays beside that wrapper.
            const menuHost = parent?.matches('[data-bcct-moderator-actions="1"]') ? parent.parentElement : parent;
            for (const menu of menuHost?.children || []) {
                if (!Array.from(menu.classList).some((name) => name.startsWith("_container_"))) continue;
                const sample = Array.from(menu.querySelectorAll("button")).find(
                    (button) =>
                        !button.closest(`[${ENTRY}], [${PANEL}]`) &&
                        button.parentElement?.parentElement === menu &&
                        Array.from(button.classList).some((name) => name.startsWith("_button_")) &&
                        Array.from(button.parentElement.classList).some((name) => name.startsWith("_wrapper_")) &&
                        Array.from(button.querySelectorAll("span")).some((span) => span.textContent.trim() === "클린봇")
                );
                if (sample) return { chat, trigger, menu, sample };
            }
        }
        return null;
    }
    function valid(s) {
        return (
            session === s &&
            !suspended &&
            isLiveRoute() &&
            s.chat.isConnected &&
            s.menu.isConnected &&
            s.trigger.getAttribute("aria-expanded") === "true" &&
            s.panel.isConnected &&
            s.entryButton.isConnected &&
            s.menu.contains(s.entryButton) &&
            s.menu.contains(s.panel) &&
            host() === s.chat
        );
    }
    function close(restore = false) {
        const s = session;
        if (!s) return;
        session = null;
        s.removeStorage?.();
        s.resizeObserver?.disconnect();
        s.panel.remove();
        if (restore && s.entryButton.isConnected) s.entryButton.focus({ preventScroll: true });
    }
    function removeEntry() {
        close(false);
        entry?.wrapper.remove();
        entry = null;
    }
    function status(s, message, error = false) {
        if (!valid(s)) return;
        s.note.textContent = message;
        s.panel.dataset.error = String(error);
        position(s);
    }
    function expected(raw) {
        return Object.fromEntries(
            KEYS.map((key) => [key, Object.hasOwn(raw, key) ? { value: raw[key] } : { absent: true }])
        );
    }
    function same(a, b) {
        return KEYS.every((key) => Object.hasOwn(a, key) === Object.hasOwn(b, key) && a[key] === b[key]);
    }
    function normalized(raw) {
        const value = settings.normalizeOptions(raw);
        return Object.fromEntries(KEYS.map((key) => [key, value[key]]));
    }
    function form(s) {
        return {
            chatKeywordFilterEnabled: s.toggle.checked,
            chatKeywordFilterWords: s.words.value,
            chatKeywordFilterApplyMode: s.applyMode.value,
            chatKeywordFilterMatchMode: s.matchMode.value,
            chatKeywordFilterExactWords: s.exactWords,
        };
    }
    function isDirty(s) {
        const values = form(s);
        return KEYS.some((key) => values[key] !== s.baseForm[key]);
    }
    function controls(s) {
        const busy = s.loading || s.pending;
        s.toggle.disabled = busy;
        s.words.disabled = busy;
        s.applyMode.disabled = busy;
        const individual = s.applyMode.value === "individual";
        s.matchMode.disabled = busy || individual;
        s.matchMode.parentElement.hidden = individual;
        s.individual.hidden = !individual;
        renderRules(s, busy || !individual);
        s.save.disabled = busy || s.conflict;
        s.reload.disabled = busy;
        s.reload.hidden = !s.conflict && !s.readFailed;
    }
    function display(s, raw) {
        s.raw = { ...raw };
        s.baseRaw = { ...raw };
        s.baseForm = normalized(raw);
        s.toggle.checked = s.baseForm.chatKeywordFilterEnabled;
        s.words.value = s.baseForm.chatKeywordFilterWords;
        s.applyMode.value = s.baseForm.chatKeywordFilterApplyMode;
        s.matchMode.value = s.baseForm.chatKeywordFilterMatchMode;
        s.exactWords = s.baseForm.chatKeywordFilterExactWords;
        s.conflict = false;
        s.readFailed = false;
        controls(s);
    }

    function renderRules(s, disabled) {
        const invalid = settings.normalizeChatKeywordFilterWords(s.words.value) === null;
        const rules = settings.getChatKeywordFilterRules({ ...form(s), chatKeywordFilterApplyMode: "individual" });
        const signature = JSON.stringify(rules.map((rule) => rule.phrase));
        if (!invalid && s.rules.dataset.words !== signature) {
            s.rules.dataset.words = signature;
            s.rules.replaceChildren();
            for (const { phrase } of rules) {
                const label = document.createElement("label");
                const text = document.createElement("span");
                text.textContent = phrase;
                const select = document.createElement("select");
                select.dataset.keywordPhrase = phrase;
                select.setAttribute("aria-label", `${phrase} 일치 조건`);
                select.setAttribute("aria-describedby", "cheese-spanner-chat-keywords-match-help");
                select.innerHTML = '<option value="contains">포함</option><option value="exact">완전 일치</option>';
                label.append(text, select);
                s.rules.append(label);
            }
            if (!rules.length) s.rules.textContent = "숨길 문구를 입력하면 문구별 조건이 나타나요.";
        }
        for (const select of s.rules.querySelectorAll("select")) {
            const rule = rules.find((item) => item.phrase === select.dataset.keywordPhrase);
            if (rule) select.value = rule.matchMode;
            select.disabled = disabled || invalid;
        }
    }
    async function readCurrent(s, focus = false) {
        s.loading = true;
        s.readChanges = new Map();
        controls(s);
        status(s, "설정을 불러오는 중이에요.");
        try {
            const raw = await storageGet(chrome.storage.sync, KEYS);
            if (!valid(s)) return;
            const current = { ...raw };
            for (const [key, value] of s.readChanges) {
                if (value === undefined) delete current[key];
                else current[key] = value;
            }
            s.loading = false;
            display(s, current);
            status(s, "");
            if (focus) s.words.focus({ preventScroll: true });
        } catch (_) {
            if (!valid(s)) return;
            s.loading = false;
            s.readFailed = true;
            s.conflict = true;
            controls(s);
            status(s, "설정을 불러오지 못했어요. 다시 불러와 주세요.", true);
        }
    }
    function storageChanged(s, changes, area) {
        if (!valid(s) || area !== "sync" || !KEYS.some((key) => Object.hasOwn(changes || {}, key))) return;
        for (const key of KEYS) {
            if (!Object.hasOwn(changes, key)) continue;
            const value = changes[key]?.newValue;
            if (s.loading) s.readChanges.set(key, value);
            if (value === undefined) delete s.raw[key];
            else s.raw[key] = value;
        }
        if (s.loading) return;
        if (s.pending && KEYS.every((key) => s.raw[key] === s.pendingValues[key])) return;
        if (!s.pending && !isDirty(s)) {
            display(s, s.raw);
            status(s, "다른 곳에서 바뀐 설정을 불러왔어요.");
        } else if (!same(s.raw, s.baseRaw)) {
            s.conflict = true;
            controls(s);
            status(
                s,
                "다른 곳에서 설정이 바뀌었어요. 입력은 유지했어요. 최신 설정을 불러온 뒤 다시 편집해 주세요.",
                true
            );
        }
    }
    async function save(s, event) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted || !valid(s) || s.loading || s.pending || s.conflict) return;
        const words = settings.normalizeChatKeywordFilterWords(s.words.value);
        if (words === null) {
            status(s, "한 줄에 100자 이하, 최대 50개·전체 2,000자까지 입력해 주세요.", true);
            s.words.focus({ preventScroll: true });
            return;
        }
        const values = { ...form(s), chatKeywordFilterWords: words };
        s.pending = true;
        s.pendingValues = values;
        controls(s);
        status(s, "저장 중이에요.");
        try {
            await settingsStoreSet("sync", values, expected(s.baseRaw));
            if (!valid(s)) return;
            s.pending = false;
            if (s.conflict) {
                controls(s);
                status(s, "저장 중 다른 곳에서 설정이 바뀌었어요. 입력은 유지했어요. 최신 설정을 확인해 주세요.", true);
                return;
            }
            display(s, values);
            status(s, "저장했어요.");
        } catch (error) {
            if (!valid(s)) return;
            s.pending = false;
            if (error?.code === "conflict") s.conflict = true;
            controls(s);
            status(
                s,
                error?.code === "conflict"
                    ? "다른 곳에서 설정이 바뀌어 저장하지 않았어요. 입력은 유지했어요. 최신 설정을 불러와 주세요."
                    : "저장하지 못했어요. 입력은 유지했어요. 다시 시도해 주세요.",
                true
            );
        }
    }
    function position(s) {
        if (!valid(s)) return;
        const anchor = s.menu.getBoundingClientRect();
        const width = Math.min(340, Math.max(0, innerWidth - 16));
        s.panel.style.width = `${width}px`;
        const left = Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8));
        const top = Math.max(8, Math.min(anchor.top, innerHeight - s.panel.offsetHeight - 8));
        s.panel.style.left = `${left}px`;
        s.panel.style.top = `${top}px`;
        // A transformed native ancestor can establish a fixed-position containing block.
        const actual = s.panel.getBoundingClientRect();
        s.panel.style.left = `${left + left - actual.left}px`;
        s.panel.style.top = `${top + top - actual.top}px`;
    }
    function open(e, event) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted || suspended || !e.menu.isConnected || e.trigger.getAttribute("aria-expanded") !== "true")
            return;
        close(false);
        ensureUiTheme?.();
        injectStyleOnce(STYLE_ID, STYLE);
        const panel = document.createElement("section");
        panel.setAttribute(PANEL, "1");
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "문구 숨김");
        panel.innerHTML = `<h2>문구 숨김</h2>
<label class="bcct-keyword-toggle"><input type="checkbox" data-field="enabled">지정한 문구와 일치하는 채팅 숨기기</label>
<label class="bcct-keyword-choice">조건 적용 방식<select data-field="applyMode" aria-describedby="cheese-spanner-chat-keywords-mode-help"><option value="all">전체 적용</option><option value="individual">부분 적용</option></select></label>
<p id="cheese-spanner-chat-keywords-mode-help">전체 적용은 모든 문구에 같은 조건을, 부분 적용은 문구마다 다른 조건을 설정해요.</p>
<label class="bcct-keyword-choice">모든 문구의 일치 조건<select data-field="matchMode" aria-describedby="cheese-spanner-chat-keywords-match-help"><option value="contains">포함</option><option value="exact">완전 일치</option></select></label>
<p id="cheese-spanner-chat-keywords-match-help">완전 일치는 본문 전체가 문구와 같을 때, 포함은 본문 안에 문구가 들어 있을 때 숨겨요.</p>
<label for="cheese-spanner-chat-keywords">숨길 문구</label><textarea id="cheese-spanner-chat-keywords" data-field="words" rows="5" maxlength="2000" aria-describedby="cheese-spanner-chat-keywords-help" placeholder="한 줄에 문구 하나씩 입력" spellcheck="false"></textarea>
<p id="cheese-spanner-chat-keywords-help">영문 대소문자는 구분하지 않아요. 최대 50개·한 문구 100자·전체 2,000자예요.</p>
<div data-field="individual" hidden><p>문구별 일치 조건을 선택해요. 새 문구의 기본 조건은 포함이에요.</p><div data-field="rules" role="group" aria-label="문구별 일치 조건"></div></div>
<p role="status" aria-live="polite"></p><div class="bcct-keyword-actions"><button type="button" data-action="reload" hidden>최신 설정 불러오기</button><button type="button" data-action="close">닫기</button><button type="button" data-action="save">저장</button></div>`;
        const s = {
            ...e,
            entryButton: e.button,
            panel,
            raw: {},
            baseRaw: {},
            baseForm: normalized({}),
            loading: true,
            pending: false,
            conflict: false,
            readFailed: false,
            toggle: panel.querySelector('[data-field="enabled"]'),
            words: panel.querySelector("textarea"),
            applyMode: panel.querySelector('[data-field="applyMode"]'),
            matchMode: panel.querySelector('[data-field="matchMode"]'),
            exactWords: "",
            individual: panel.querySelector('[data-field="individual"]'),
            rules: panel.querySelector('[data-field="rules"]'),
            note: panel.querySelector('[role="status"]'),
            save: panel.querySelector('[data-action="save"]'),
            reload: panel.querySelector('[data-action="reload"]'),
        };
        session = s;
        e.menu.append(panel);
        s.save.addEventListener("click", (click) => void save(s, click));
        s.reload.addEventListener("click", (click) => {
            if (click.isTrusted && valid(s) && !s.pending && !s.loading) void readCurrent(s, true);
        });
        panel.querySelector('[data-action="close"]').addEventListener("click", () => close(true));
        panel.addEventListener("input", (input) => {
            if (
                input.target === s.words &&
                !s.pending &&
                !s.loading &&
                settings.normalizeChatKeywordFilterWords(s.words.value) !== null
            ) {
                s.exactWords = settings
                    .getChatKeywordFilterRules({ ...form(s), chatKeywordFilterApplyMode: "individual" })
                    .filter((rule) => rule.matchMode === "exact")
                    .map((rule) => rule.phrase)
                    .join("\n");
                controls(s);
            }
            if (!s.conflict && !s.pending && !s.loading) status(s, "저장 전 변경사항이 있어요.");
        });
        panel.addEventListener("change", (change) => {
            if (s.pending || s.loading) return;
            if (change.target.closest?.('[data-field="rules"]')) {
                s.exactWords = [...s.rules.querySelectorAll("select")]
                    .filter((select) => select.value === "exact")
                    .map((select) => select.dataset.keywordPhrase)
                    .join("\n");
            }
            controls(s);
            if (!s.conflict) status(s, "저장 전 변경사항이 있어요.");
        });
        for (const type of ["click", "pointerdown", "mousedown"])
            panel.addEventListener(type, (click) => click.stopPropagation());
        s.removeStorage = startStorageChangeListener((changes, area) => storageChanged(s, changes, area));
        controls(s);
        position(s);
        if (typeof ResizeObserver === "function") {
            s.resizeObserver = new ResizeObserver(() => position(s));
            s.resizeObserver.observe(panel);
        }
        void readCurrent(s, true);
    }
    function syncMenu() {
        if (suspended) return;
        const next = nativeMenu();
        if (!next || entry?.menu !== next.menu || entry?.chat !== next.chat) removeEntry();
        if (!next) return;
        if (session && !valid(session)) close(false);
        if (entry?.wrapper.isConnected) return;
        const wrapper = document.createElement("div");
        wrapper.setAttribute(ENTRY, "1");
        wrapper.className = next.sample.parentElement.className;
        const button = document.createElement("button");
        button.type = "button";
        button.className = next.sample.className;
        const contents = document.createElement("span");
        contents.className = next.sample.querySelector("span")?.className || "";
        contents.style.display = "flex";
        contents.style.alignItems = "center";
        contents.style.justifyContent = "flex-start";
        contents.style.gap = "8px";
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("width", "18");
        icon.setAttribute("height", "18");
        icon.setAttribute("aria-hidden", "true");
        icon.setAttribute("fill", "none");
        icon.setAttribute("stroke", "currentColor");
        icon.setAttribute("stroke-width", "1.8");
        icon.setAttribute("stroke-linecap", "round");
        icon.setAttribute("stroke-linejoin", "round");
        icon.style.flexShrink = "0";
        icon.innerHTML =
            '<path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5c-1.4 0-2.7-.4-3.8-1L4 19l1.1-4.4A7.5 7.5 0 1 1 20 11.5z"/><path d="M2 12h20"/>';
        const label = document.createElement("span");
        label.textContent = "문구 숨김";
        contents.append(icon, label);
        button.append(contents);
        wrapper.append(button);
        entry = { ...next, wrapper, button };
        const owned = entry;
        button.addEventListener("click", (event) => open(owned, event));
        next.menu.append(wrapper);
    }
    function observe() {
        observer?.disconnectAll?.();
        observer = null;
        if (suspended || !isLiveRoute()) return;
        observer = createMutationObserverSync({
            target: host,
            options: { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-expanded"] },
            shouldSchedule: (records) =>
                records.some((record) => {
                    const target = record.target instanceof Element ? record.target : record.target.parentElement;
                    return !target?.closest(`[role="log"], [${PANEL}], [${ENTRY}]`);
                }),
            schedule: sync,
            onObserved: sync,
            onBodyReady: sync,
        });
    }
    function routeChanged() {
        removeEntry();
        sync.cancel();
        observe();
        sync();
    }
    function start() {
        if (suspended) return;
        if (!removeRouteListener) removeRouteListener = startPageChangeDetection(routeChanged);
        observe();
        sync();
    }
    // Loaded before player features: panel keys must not reach their window-capture shortcuts.
    function panelKey(event) {
        const s = session;
        if (!s || !s.panel.contains(event.target)) return;
        if (!valid(s)) {
            close(false);
            return;
        }
        event.stopImmediatePropagation();
        if (event.type !== "keydown") return;
        if (event.key === "Escape") {
            event.preventDefault();
            close(true);
        }
        if (event.key === "Tab") {
            const controls = [...s.panel.querySelectorAll("input,textarea,select,button")].filter(
                (item) => !item.disabled && !item.closest("[hidden]")
            );
            const index = controls.indexOf(document.activeElement);
            if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === controls.length - 1)) {
                event.preventDefault();
                controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
            }
        }
    }
    window.addEventListener("keydown", panelKey, true);
    window.addEventListener("keyup", panelKey, true);
    document.addEventListener(
        "pointerdown",
        (event) => {
            if (session && !session.panel.contains(event.target) && !session.entryButton.contains(event.target))
                close(false);
        },
        true
    );
    window.addEventListener("resize", () => {
        if (session) position(session);
    });
    window.addEventListener("pagehide", () => {
        suspended = true;
        sync.cancel();
        observer?.disconnectAll?.();
        observer = null;
        removeRouteListener?.();
        removeRouteListener = null;
        removeEntry();
        document.getElementById(STYLE_ID)?.remove();
    });
    window.addEventListener("pageshow", () => {
        suspended = false;
        start();
    });
    onReady(start);
})();
