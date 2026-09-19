/* Header channel search and device-local live notification registration. Isolated world. */
(() => {
    const ID = "betterchzzk-live-start-registration";
    const PANEL_ID = ID + "-panel";
    const STYLE_ID = ID + "-style";
    const { CHANNELS_KEY, MAX_CHANNELS, normalizeChannels } = globalThis.BetterChzzkLiveStart;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        fetchJson,
        injectStyleOnce,
        normalizeChzzkImageUrl,
        onReady,
        startPageChangeDetection,
        storageGet,
    } = BetterChzzk.utils;
    const part = (name) => '[class^="_' + name + '_"], [class*=" _' + name + '_"]';
    const WATCH = "#" + ID + ", " + part("container") + ", " + part("section");
    let running = false,
        active = false,
        ready = false;
    let options = {},
        channels = [],
        loadError = "";
    let loadVersion = 0,
        lifecycle = 0,
        frame = 0;
    let entry = null,
        panel = null,
        observer = null,
        removeOptions = null,
        removeRoute = null;
    const pending = new Set();
    const profileCache = new Map();
    const ACTIONS = [
        { key: "notify", label: "데스크톱 알림", kind: "set-notify", option: "liveStartNotificationsEnabled" },
        { key: "autoOpen", label: "자동 입장", kind: "set-auto-open", option: "liveStartAutoOpenEnabled" },
    ];

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }
    function button(text, label = text) {
        const node = el("button", "", text);
        node.type = "button";
        node.setAttribute("aria-label", label);
        return node;
    }
    function findControl() {
        const header = document.getElementById("header");
        if (!header) return null;
        // 2026-09-19: the right toolbar is a section directly inside the header's container.
        const matches = [];
        for (const container of header.children) {
            if (!container.matches(part("container"))) continue;
            for (const section of container.children) if (section.matches(part("section"))) matches.push(section);
        }
        return matches.length === 1 ? matches[0] : null;
    }
    function cancelSearch(target) {
        target.controller?.abort();
        target.controller = null;
        target.searching = false;
    }
    function closePanel(restoreFocus = false) {
        if (!panel) return;
        cancelSearch(panel);
        cancelProfiles(panel);
        panel.node.remove();
        panel = null;
        entry?.button.setAttribute("aria-expanded", "false");
        window.removeEventListener("resize", positionPanel);
        window.removeEventListener("scroll", positionPanel, true);
        if (restoreFocus && entry?.button.isConnected) entry.button.focus();
    }
    function positionPanel() {
        if (!panel || !entry?.node.isConnected) return;
        const rect = entry.button.getBoundingClientRect();
        const width = Math.min(360, Math.max(0, window.innerWidth - 24));
        const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 100));
        panel.node.style.width = width + "px";
        panel.node.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + "px";
        panel.node.style.top = top + "px";
        panel.node.style.maxHeight = Math.max(0, window.innerHeight - top - 12) + "px";
    }
    function showMessage(target, text) {
        if (panel === target) target.message.textContent = text;
    }
    function register(target, channel, action) {
        if (!active || panel !== target || !ready || pending.has(channel.channelId)) return;
        const id = channel.channelId;
        const removing = action.kind === "remove";
        if (removing && !channels.some((item) => item.channelId === id)) return;
        const enabled = !removing && !channels.some((item) => item.channelId === id && item[action.key]);
        const version = loadVersion,
            cycle = lifecycle;
        pending.add(id);
        showMessage(target, "");
        render();
        const finish = (response, error) => {
            if (!active || cycle !== lifecycle) return;
            pending.delete(id);
            if (error || !response?.ok || !Array.isArray(response.channels)) {
                showMessage(target, response?.error || "채널 설정을 저장하지 못했어요. 다시 시도해 주세요.");
            } else {
                if (version === loadVersion) channels = normalizeChannels(response.channels);
                const saved = channels.some((item) => item.channelId === id && (removing || item[action.key]));
                showMessage(
                    target,
                    saved !== enabled
                        ? "현재 저장된 채널 설정을 반영했어요."
                        : removing
                          ? "채널 등록을 해제했어요."
                          : action.label + (enabled ? " 대상으로 등록했어요." : " 선택을 해제했어요.")
                );
            }
            render();
        };
        try {
            chrome.runtime.sendMessage(
                {
                    type: "betterchzzk:live-start:channels",
                    kind: action.kind,
                    channel: { channelId: id, ...(!removing ? { [action.key]: enabled } : {}) },
                },
                (response) => {
                    const error = chrome.runtime.lastError;
                    finish(response, error);
                }
            );
        } catch (error) {
            finish(null, error);
        }
    }
    function syncAvatar(row, imageUrl) {
        if (row.imageUrl === imageUrl) return;
        row.imageUrl = imageUrl;
        row.avatar.replaceChildren();
        if (imageUrl) {
            const image = el("img");
            image.alt = "";
            image.width = image.height = 32;
            image.loading = "lazy";
            image.decoding = "async";
            image.referrerPolicy = "no-referrer";
            image.src = imageUrl;
            image.addEventListener("error", () => image.remove(), { once: true });
            row.avatar.append(image);
        }
    }
    function cacheProfile(id, imageUrl) {
        profileCache.delete(id);
        profileCache.set(id, imageUrl);
        while (profileCache.size > MAX_CHANNELS) profileCache.delete(profileCache.keys().next().value);
    }
    function cancelProfiles(target) {
        target.profileController?.abort();
        target.profileController = null;
        target.profileLoading = false;
        target.profileAttempts.clear();
    }
    async function loadMissingProfiles(target) {
        if (target.profileLoading) return;
        const missing = channels.filter(
            (item) =>
                !item.channelImageUrl &&
                !profileCache.has(item.channelId) &&
                !target.profileAttempts.has(item.channelId)
        );
        if (!missing.length) return;
        target.profileLoading = true;
        const controller = new AbortController();
        target.profileController = controller;
        const current = () =>
            active && panel === target && target.profileController === controller && !controller.signal.aborted;
        let index = 0;
        const next = async () => {
            while (current() && index < missing.length) {
                const id = missing[index++].channelId;
                if (!channels.some((item) => item.channelId === id)) continue;
                target.profileAttempts.add(id);
                try {
                    const json = await fetchJson("https://api.chzzk.naver.com/service/v1/channels/" + id, {
                        signal: controller.signal,
                        timeoutMs: 8000,
                    });
                    if (!current()) return;
                    if (json?.code !== 200 || json.content?.channelId !== id) continue;
                    if (!channels.some((item) => item.channelId === id)) continue;
                    cacheProfile(id, normalizeChzzkImageUrl(json.content.channelImageUrl));
                    render();
                } catch (_) {
                    // A profile lookup must not disable the saved notification/entry controls.
                    if (!current()) return;
                }
            }
        };
        await Promise.all([next(), next()]);
        if (current()) {
            target.profileController = null;
            target.profileLoading = false;
            render();
        }
    }
    function createRow(target, channel) {
        const node = el("li", "bcls-row"),
            avatar = el("span", "bcls-avatar");
        const info = el("span", "bcls-info"),
            name = el("span", "bcls-name");
        const detail = el("span", "bcls-detail");
        if (Number.isSafeInteger(channel.followerCount) && channel.followerCount >= 0)
            detail.textContent = "팔로워 " + channel.followerCount.toLocaleString("ko-KR") + "명";
        detail.title = detail.textContent;
        info.append(name, detail);
        const controls = el("div", "bcls-actions");
        const actions = ACTIONS.map((action) => {
            const toggle = button("");
            toggle.dataset.channelId = channel.channelId;
            toggle.dataset.action = action.key;
            const state = el("span", "bcls-state");
            state.setAttribute("aria-hidden", "true");
            toggle.append(el("span", "", action.label), state);
            toggle.addEventListener("click", () => register(target, channel, action));
            controls.append(toggle);
            return { ...action, toggle, state };
        });
        const remove = button("×", "등록 해제");
        remove.className = "bcls-remove";
        remove.dataset.channelId = channel.channelId;
        remove.dataset.action = "remove";
        remove.title = "등록 해제";
        remove.addEventListener("click", () => register(target, channel, { kind: "remove" }));
        controls.append(remove);
        node.append(avatar, info, controls);
        return { node, name, actions, remove, avatar, imageUrl: "" };
    }
    function render() {
        const target = panel;
        if (!target) return;
        const keyword = target.input.value.trim();
        const data = keyword ? target.results : channels;
        target.heading.textContent = keyword ? "검색 결과" : "등록 채널";
        const disabled = ACTIONS.filter((action) => !options[action.option]).map((action) => action.label);
        target.hint.textContent = disabled.length
            ? "전체 " + disabled.join("·") + " 기능이 꺼져 있어요. 설정의 ‘방송 알림’ 탭에서 켜고 저장해 주세요."
            : "데스크톱 알림과 자동 입장을 각각 선택해 주세요. 채널별 선택은 바로 저장돼요.";
        target.submit.disabled = target.searching || !keyword;
        target.list.setAttribute("aria-busy", String(target.searching));
        target.empty.textContent =
            loadError ||
            (!ready
                ? "등록 채널을 불러오는 중이에요."
                : target.searching
                  ? "검색 중이에요…"
                  : keyword
                    ? target.searchError ||
                      (target.searched ? "검색 결과가 없어요." : "채널명을 입력하고 검색을 눌러 주세요.")
                    : "등록한 채널이 없어요. 채널명을 검색해 추가해 주세요.");
        target.empty.hidden = data.length > 0 && !loadError;
        const ids = new Set(data.map((item) => item.channelId));
        for (const [id, row] of target.rows) {
            if (ids.has(id)) continue;
            if (row.node.contains(document.activeElement)) target.input.focus();
            row.node.remove();
            target.rows.delete(id);
        }
        for (const channel of data) {
            let row = target.rows.get(channel.channelId);
            if (!row) {
                row = createRow(target, channel);
                target.rows.set(channel.channelId, row);
                target.list.append(row.node);
            }
            row.name.textContent = channel.channelName || channel.channelId;
            row.name.title = row.name.textContent;
            syncAvatar(
                row,
                normalizeChzzkImageUrl(channel.channelImageUrl) || profileCache.get(channel.channelId) || ""
            );
            const saved = channels.find((item) => item.channelId === channel.channelId);
            if (!saved && row.remove === document.activeElement) row.restoreFocus = true;
            row.remove.hidden = !saved;
            row.remove.disabled = !ready || pending.has(channel.channelId);
            row.remove.setAttribute("aria-label", (channel.channelName || channel.channelId) + " 등록 해제");
            row.remove.setAttribute("aria-busy", String(pending.has(channel.channelId)));
            for (const action of row.actions) {
                const enabled = saved?.[action.key] === true;
                action.state.textContent = enabled ? "켬" : "끔";
                action.toggle.disabled = !ready || pending.has(channel.channelId);
                action.toggle.setAttribute("aria-pressed", String(enabled));
                action.toggle.setAttribute("aria-busy", String(pending.has(channel.channelId)));
                action.toggle.setAttribute(
                    "aria-label",
                    (channel.channelName || channel.channelId) + " " + action.label + (enabled ? " 끄기" : " 켜기")
                );
            }
            if (row.restoreFocus && !pending.has(channel.channelId)) {
                if (document.activeElement === row.remove || document.activeElement === document.body)
                    row.actions[0].toggle.focus();
                row.restoreFocus = false;
            }
        }
        if (ready && !keyword) void loadMissingProfiles(target);
    }
    async function search(target) {
        const keyword = target.input.value.trim();
        if (panel !== target || !keyword || target.searching) return;
        cancelSearch(target);
        target.results = [];
        target.searched = false;
        target.searchError = "";
        target.searching = true;
        const controller = new AbortController();
        target.controller = controller;
        showMessage(target, "");
        render();
        const current = () =>
            active && panel === target && target.controller === controller && !controller.signal.aborted;
        try {
            const params = new URLSearchParams({ keyword, offset: "0", size: "5", withFirstChannelContent: "false" });
            const response = await fetchJson("https://api.chzzk.naver.com/service/v1/search/channels?" + params, {
                signal: controller.signal,
                timeoutMs: 8000,
            });
            if (!current()) return;
            if (response?.code !== 200 || !Array.isArray(response.content?.data))
                throw new Error("Invalid channel search response");
            const seen = new Set();
            target.results = response.content.data
                .slice(0, 5)
                .map((item) => item?.channel)
                .filter((channel) => {
                    if (
                        !/^[a-f0-9]{32}$/.test(channel?.channelId) ||
                        typeof channel.channelName !== "string" ||
                        !channel.channelName.trim() ||
                        seen.has(channel.channelId)
                    )
                        return false;
                    seen.add(channel.channelId);
                    return true;
                });
            target.searched = true;
            for (const channel of target.results)
                cacheProfile(channel.channelId, normalizeChzzkImageUrl(channel.channelImageUrl));
        } catch (_) {
            if (!current()) return;
            target.searchError = "채널을 검색하지 못했어요. 잠시 후 다시 시도해 주세요.";
        } finally {
            if (current()) {
                target.controller = null;
                target.searching = false;
                render();
            }
        }
    }
    function openPanel() {
        if (!active || !entry?.node.isConnected) return;
        if (panel) {
            closePanel();
            return;
        }
        const node = el("section");
        node.id = PANEL_ID;
        node.setAttribute("role", "dialog");
        node.setAttribute("aria-labelledby", PANEL_ID + "-title");
        const top = el("div", "bcls-top"),
            title = el("h2", "", "방송 알림");
        title.id = PANEL_ID + "-title";
        const close = button("닫기", "방송 알림 닫기");
        close.addEventListener("click", () => closePanel(true));
        top.append(title, close);
        const hint = el("p", "bcls-hint"),
            form = el("form", "bcls-search");
        const label = el("label", "", "채널명 검색"),
            input = el("input");
        input.id = PANEL_ID + "-input";
        label.htmlFor = input.id;
        input.type = "search";
        input.placeholder = "채널명을 입력해 주세요";
        input.autocomplete = "off";
        input.maxLength = 100;
        const submit = button("검색");
        submit.type = "submit";
        form.append(label, input, submit);
        const heading = el("h3"),
            empty = el("p", "bcls-hint"),
            list = el("ul", "bcls-list");
        empty.setAttribute("role", "status");
        list.setAttribute("aria-label", "방송 알림 채널");
        const message = el("p", "bcls-message");
        message.setAttribute("role", "status");
        node.append(top, hint, form, heading, empty, list, message);
        const target = {
            node,
            hint,
            input,
            submit,
            heading,
            empty,
            list,
            message,
            rows: new Map(),
            results: [],
            searching: false,
            searched: false,
            searchError: "",
            controller: null,
            profileController: null,
            profileLoading: false,
            profileAttempts: new Set(),
        };
        panel = target;
        input.addEventListener("input", () => {
            cancelSearch(target);
            cancelProfiles(target);
            target.results = [];
            target.searched = false;
            target.searchError = "";
            showMessage(target, "");
            render();
        });
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            void search(target);
        });
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter" && event.isComposing) event.preventDefault();
        });
        document.body.append(node);
        entry.button.setAttribute("aria-expanded", "true");
        render();
        positionPanel();
        window.addEventListener("resize", positionPanel);
        window.addEventListener("scroll", positionPanel, true);
        input.focus();
    }
    function removeEntry() {
        closePanel();
        entry?.node.remove();
        entry = null;
    }
    function sync() {
        frame = 0;
        if (!active) return;
        const control = findControl();
        if (!control) {
            removeEntry();
            return;
        }
        if (entry?.control !== control) {
            removeEntry();
            const node = el("span"),
                trigger = button("방송 알림");
            node.id = ID;
            trigger.setAttribute("aria-haspopup", "dialog");
            trigger.setAttribute("aria-expanded", "false");
            trigger.setAttribute("aria-controls", PANEL_ID);
            trigger.addEventListener("click", openPanel);
            node.append(trigger);
            entry = { node, button: trigger, control };
        }
        if (entry.node.parentElement !== control) {
            closePanel();
            control.prepend(entry.node);
        }
    }
    function schedule() {
        if (active && !frame) frame = requestAnimationFrame(sync);
    }
    function shouldSchedule(mutations) {
        return mutations.some((mutation) => {
            if (entry?.node.contains(mutation.target)) return false;
            if (mutation.type === "attributes") return mutation.target.matches(WATCH);
            return [...mutation.addedNodes, ...mutation.removedNodes].some(
                (node) =>
                    node instanceof Element &&
                    !(node === entry?.node && Array.from(mutation.addedNodes).includes(node)) &&
                    (node.matches(WATCH) || node.querySelector(WATCH))
            );
        });
    }
    function onRoute() {
        closePanel();
        schedule();
    }
    function dismiss(event) {
        if (!panel) return;
        if (event.type === "keydown") {
            if (event.key === "Escape") {
                event.preventDefault();
                closePanel(true);
            }
        } else if (!panel.node.contains(event.target) && !entry?.node.contains(event.target)) closePanel();
    }
    function onStorageChange(changes, area) {
        if (area !== "local" || !Object.hasOwn(changes, CHANNELS_KEY)) return;
        loadVersion++;
        channels = normalizeChannels(changes[CHANNELS_KEY].newValue);
        ready = true;
        loadError = "";
        render();
    }
    async function loadChannels() {
        const version = ++loadVersion;
        try {
            const data = await storageGet(chrome.storage.local, CHANNELS_KEY);
            if (!active || version !== loadVersion) return;
            channels = normalizeChannels(data[CHANNELS_KEY]);
            ready = true;
        } catch (_) {
            if (!active || version !== loadVersion) return;
            loadError = "채널 설정을 불러오지 못했어요. 페이지를 새로고침해 주세요.";
        }
        render();
    }
    function activate() {
        if (active) return;
        active = true;
        lifecycle++;
        ready = false;
        loadError = "";
        observer = createMutationObserverSync({
            target: () => document.getElementById("header"),
            options: { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] },
            shouldSchedule,
            schedule,
            onObserved: schedule,
            onBodyReady: schedule,
        });
        chrome.storage.onChanged.addListener(onStorageChange);
        document.addEventListener("pointerdown", dismiss);
        document.addEventListener("keydown", dismiss);
        document.addEventListener("focusin", dismiss);
        removeRoute = startPageChangeDetection(onRoute);
        void loadChannels();
        schedule();
    }
    function deactivate() {
        active = false;
        lifecycle++;
        loadVersion++;
        pending.clear();
        profileCache.clear();
        observer?.disconnectAll();
        observer = null;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        removeRoute?.();
        removeRoute = null;
        chrome.storage.onChanged.removeListener(onStorageChange);
        document.removeEventListener("pointerdown", dismiss);
        document.removeEventListener("keydown", dismiss);
        document.removeEventListener("focusin", dismiss);
        removeEntry();
    }
    function start() {
        if (running || !globalThis.chrome?.runtime?.sendMessage) return;
        running = true;
        injectStyleOnce(STYLE_ID, CSS);
        removeOptions = bindFeatureOptions((next) => {
            if (!running) return;
            options = next;
            if (next.liveStartButtonEnabled) activate();
            else deactivate();
            render();
        });
    }
    function stop() {
        running = false;
        removeOptions?.();
        removeOptions = null;
        deactivate();
        document.getElementById(STYLE_ID)?.remove();
    }
    const CSS = `
/* Pretendard 1.3.9, SIL OFL 1.1: vendor/fonts/Pretendard.LICENSE.txt */
@font-face{font-family:"BetterChzzk Pretendard";src:url("${chrome.runtime.getURL("vendor/fonts/PretendardVariable.woff2")}") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}
#${ID}{display:inline-flex;align-self:center;flex:none;margin-right:8px;font:14px/1.4 "BetterChzzk Pretendard",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#${ID}>button,#${PANEL_ID} button{box-sizing:border-box;min-height:34px;padding:6px 12px;border:1px solid var(--sem-color-border-neutral-base,var(--Border-Neutral-Weak,#cdd1d8));border-radius:8px;background:var(--sem-color-surface-neutral-weak,var(--Surface-Neutral-Strong,#f0f1f4));color:var(--sem-color-content-neutral-primary,var(--Content-Neutral-Primary,#16181c));font:inherit;font-size:14px;font-weight:600;line-height:1.4;white-space:nowrap;cursor:pointer}
#${ID}>button{border-radius:9999px;font-weight:650}
#${ID}>button:hover,#${PANEL_ID} button:hover{border-color:currentColor}
#${ID}>button:focus-visible,#${PANEL_ID} :is(button,input):focus-visible{outline:2px solid var(--sem-color-content-brand-strong,var(--Content-Brand-Strong,#00784f));outline-offset:2px}
#${ID}>button[aria-expanded="true"],#${PANEL_ID} button[aria-pressed="true"]{color:var(--sem-color-content-brand-strong,var(--Content-Brand-Strong,#00784f));border-color:currentColor}
#${PANEL_ID}{position:fixed;z-index:10020;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;padding:16px;border:1px solid var(--sem-color-border-neutral-base,var(--Border-Neutral-Weak,#cdd1d8));border-radius:12px;box-shadow:0 8px 32px #0003;background:var(--sem-color-surface-neutral-weaker,var(--Surface-Neutral-Base,#fff));color:var(--sem-color-content-neutral-primary,var(--Content-Neutral-Primary,#16181c));font:14px/1.5 "BetterChzzk Pretendard",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#${PANEL_ID} h2,#${PANEL_ID} h3,#${PANEL_ID} p{margin:0}
#${PANEL_ID} h2{font-size:17px;font-weight:700}
#${PANEL_ID} h3{font-size:13px;margin:16px 0 8px}
#${PANEL_ID} .bcls-top{display:flex;align-items:center;justify-content:space-between;gap:12px}
#${PANEL_ID} .bcls-hint,#${PANEL_ID} .bcls-message{font-size:12px;overflow-wrap:anywhere;margin-top:10px;color:var(--sem-color-content-neutral-warm-stronger,var(--Content-Neutral-Secondary,#555b66))}
#${PANEL_ID} .bcls-message:empty{display:none}
#${PANEL_ID} .bcls-search{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-top:16px}
#${PANEL_ID} .bcls-search label{grid-column:1/-1;font-size:13px;font-weight:600}
#${PANEL_ID} input{box-sizing:border-box;min-width:0;width:100%;padding:8px 10px;border:1px solid var(--sem-color-border-neutral-base,var(--Border-Neutral-Weak,#cdd1d8));border-radius:8px;background:transparent;color:inherit;font:inherit}
#${PANEL_ID} .bcls-list{box-sizing:content-box;list-style:none;margin:-4px;padding:4px;max-height:245px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
#${PANEL_ID} .bcls-row{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--sem-color-border-neutral-base,var(--Border-Neutral-Weak,#cdd1d8))}
#${PANEL_ID} .bcls-row:last-child{border-bottom:0}
#${PANEL_ID} .bcls-actions{display:flex;align-items:center;gap:4px}
#${PANEL_ID} .bcls-actions button{display:flex;align-items:center;justify-content:center;gap:4px;min-height:30px;padding:4px 6px;font-size:12px;white-space:nowrap;text-align:center}
#${PANEL_ID} .bcls-actions .bcls-remove{position:relative;flex:none;width:16px;height:24px;min-height:24px;padding:0;border:0;border-radius:0;background:transparent;font-size:18px;font-weight:500;line-height:1}
#${PANEL_ID} .bcls-actions .bcls-remove::before{content:"";position:absolute;inset:-4px}
#${PANEL_ID} .bcls-state{flex:none;font-size:11px;font-weight:600}
#${PANEL_ID} .bcls-avatar{width:32px;height:32px;flex:none;border-radius:50%;overflow:hidden;background:var(--sem-color-surface-neutral-weak,var(--Surface-Neutral-Strong,#f0f1f4))}
#${PANEL_ID} .bcls-avatar img{display:block;width:100%;height:100%;object-fit:cover}
#${PANEL_ID} .bcls-info{flex:1;min-width:0}
#${PANEL_ID} .bcls-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .bcls-detail{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--sem-color-content-neutral-warm-stronger,var(--Content-Neutral-Secondary,#555b66))}
#${PANEL_ID} button:disabled{opacity:.55;cursor:default}
#${PANEL_ID} [hidden]{display:none!important}
`;
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", start);
    onReady(start);
})();
