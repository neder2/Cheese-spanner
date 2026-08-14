/**
 * features/followingTitleHistory.js — 팔로잉 본문의 현재 라이브 방송 제목 변경 이력을 저장하고 펼쳐 본다.
 *
 * 동작 위치: isolated world, https://chzzk.naver.com/following 본문의 라이브 카드.
 * 하는 일: 본문 목록에 현재 노출된 /live/{channelId} 제목을 live-detail API와 대조해
 *   실제 라이브 ID와 제목을 확정한 뒤 chrome.storage.local에 방송별로 최대 20개를 저장한다.
 *   이전 제목이 있으면 현재 제목 오른쪽에 버튼을 붙여 시각과 함께 펼쳐 보여 준다.
 * 수명주기: 옵션을 끄거나 라우트가 바뀌면 observer·listener·요청·UI를 정리하고, SPA 이동 후 재설치한다.
 * 옵션 키: followingTitleHistoryEnabled.
 * DOM 마커: #betterchzzk-following-title-history-style/panel,
 *   [data-bcfth-host], [data-bcfth-title], [data-bcfth-toggle].
 */
(() => {
    const {
        addTitleHistory,
        bindFeatureOptions,
        cleanEntryTitle,
        createMutationObserverSync,
        fetchJson,
        formatKstDateTime,
        formatKstTime,
        injectStyleOnce,
        isSameKstDate,
        normalizeChzzkChannelId,
        normalizeTitleHistory,
        pickString,
        startPageChangeDetection,
        startStorageChangeListener,
        storageGet,
        storageSet,
    } = BetterChzzk.utils;

    const STORAGE_KEY = "betterchzzkFollowingLiveTitleHistory";
    const STYLE_ID = "betterchzzk-following-title-history-style";
    const PANEL_ID = "betterchzzk-following-title-history-panel";
    const HOST_ATTR = "data-bcfth-host";
    const TITLE_ATTR = "data-bcfth-title";
    const BUTTON_ATTR = "data-bcfth-toggle";
    const CHANNEL_ATTR = "data-bcfth-channel-id";
    const LIVE_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v3/channels";
    const MAX_ENTRIES = 100;
    const MAX_TITLES_PER_LIVE = 20;
    const MAX_FETCH_CONCURRENCY = 3;
    const VERIFY_TTL_MS = 2 * 60 * 1000;
    const RETRY_COOLDOWN_MS = 15 * 1000;
    const FETCH_TIMEOUT_MS = 8000;

    const storage = globalThis.chrome?.storage?.local;
    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let runtimeInstalled = false;
    let domObserver = null;
    let removePageChangeDetection = null;
    let removeStorageChangeListener = null;
    let syncFrame = 0;
    let runtimeGeneration = 0;
    let storeLoaded = false;
    let storeLoadPromise = null;
    let storeEntries = new Map();
    let writeChain = Promise.resolve();
    let activeFetchCount = 0;
    let activeChannelId = "";
    const fetchQueue = new Map();
    const fetchControllers = new Map();
    const lastFetches = new Map();
    const verifiedLives = new Map();

    function isEnabled() {
        return Boolean(featureOptions.followingTitleHistoryEnabled && storage);
    }

    function isFollowingRoute() {
        return location.pathname.replace(/\/+$/, "") === "/following";
    }

    function normalizeId(value) {
        const id = pickString(value);
        return /^[A-Za-z0-9_-]{1,100}$/.test(id) ? id : "";
    }

    function normalizeTitleKey(value) {
        return pickString(value).normalize("NFC");
    }

    function extractChannelId(href) {
        try {
            const url = new URL(href, location.origin);
            const match = url.origin === location.origin ? url.pathname.match(/^\/live\/([^/?#]+)\/?$/) : null;
            return normalizeChzzkChannelId(match ? decodeURIComponent(match[1]) : "");
        } catch (_) {
            return "";
        }
    }

    function normalizeStore(raw) {
        const rows = Array.isArray(raw?.entries)
            ? raw.entries
            : raw?.entries && typeof raw.entries === "object"
              ? Object.values(raw.entries)
              : [];
        const next = new Map();

        for (const row of rows) {
            if (!row || typeof row !== "object") continue;
            const channelId = normalizeChzzkChannelId(row.channelId);
            const liveId = normalizeId(row.liveId);
            const channelName = pickString(row.channelName);
            const titleHistory = normalizeTitleHistory(row.titleHistory, channelName, MAX_TITLES_PER_LIVE);
            if (!channelId || !liveId || !titleHistory.length) continue;
            next.set(channelId, {
                channelId,
                liveId,
                channelName,
                titleHistory,
                updatedAt: Number(row.updatedAt) || 0,
            });
        }

        return new Map(
            Array.from(next.entries())
                .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
                .slice(-MAX_ENTRIES)
        );
    }

    function serializeStore() {
        return {
            version: 1,
            entries: Array.from(storeEntries.values())
                .sort((a, b) => a.updatedAt - b.updatedAt)
                .slice(-MAX_ENTRIES),
        };
    }

    function loadStore({ force = false } = {}) {
        if (!storage) return Promise.resolve(new Map());
        if (!force && storeLoaded) return Promise.resolve(storeEntries);
        if (!force && storeLoadPromise) return storeLoadPromise;

        const request = storageGet(storage, STORAGE_KEY)
            .then((data) => {
                storeEntries = normalizeStore(data?.[STORAGE_KEY]);
                storeLoaded = true;
                return storeEntries;
            })
            .finally(() => {
                if (storeLoadPromise === request) storeLoadPromise = null;
            });
        storeLoadPromise = request;
        return request;
    }

    function persistStore() {
        const snapshot = serializeStore();
        writeChain = writeChain.catch(() => {}).then(() => storageSet(storage, { [STORAGE_KEY]: snapshot }));
        return writeChain;
    }

    function recordVerifiedTitle(meta, now = Date.now()) {
        const existing = storeEntries.get(meta.channelId);
        const entry =
            existing?.liveId === meta.liveId
                ? {
                      ...existing,
                      channelName: meta.channelName || existing.channelName,
                      titleHistory: normalizeTitleHistory(
                          existing.titleHistory,
                          meta.channelName || existing.channelName,
                          MAX_TITLES_PER_LIVE
                      ),
                  }
                : {
                      channelId: meta.channelId,
                      liveId: meta.liveId,
                      channelName: meta.channelName,
                      titleHistory: [],
                      updatedAt: now,
                  };

        addTitleHistory(entry, meta.title, now, now, MAX_TITLES_PER_LIVE);
        entry.updatedAt = now;
        storeEntries.delete(meta.channelId);
        storeEntries.set(meta.channelId, entry);
        while (storeEntries.size > MAX_ENTRIES) {
            storeEntries.delete(storeEntries.keys().next().value);
        }
        return persistStore().then(() => entry);
    }

    function getMainRoot() {
        return document.querySelector("main, [role='main'], #layout-body");
    }

    function getTitleText(link) {
        if (!(link instanceof HTMLAnchorElement)) return "";
        const clone = link.cloneNode(true);
        clone.querySelectorAll(`.blind, [aria-hidden="true"], [${BUTTON_ATTR}]`).forEach((node) => node.remove());
        return cleanEntryTitle(clone.textContent || "");
    }

    function isTitleLink(link, card) {
        if (!(link instanceof HTMLAnchorElement) || !(card instanceof HTMLElement)) return false;
        if (/title/i.test(String(link.className || ""))) return true;
        if (link.querySelector("img, picture, video")) return false;
        const href = link.getAttribute("href") || "";
        const matchingLinks = Array.from(card.querySelectorAll("a[href]")).filter(
            (candidate) => candidate.getAttribute("href") === href
        );
        return matchingLinks.length > 1 && Boolean(getTitleText(link));
    }

    function collectCandidates() {
        if (!isFollowingRoute()) return [];
        const root = getMainRoot();
        if (!(root instanceof HTMLElement)) return [];

        const byChannel = new Map();
        for (const link of root.querySelectorAll("a[href*='/live/']")) {
            const channelId = extractChannelId(link.getAttribute("href") || "");
            const card = link.closest("li, [role='listitem']");
            if (!channelId || !(card instanceof HTMLElement) || !isTitleLink(link, card)) continue;
            const title = getTitleText(link);
            if (!title) continue;
            byChannel.set(channelId, { card, channelId, link, title, titleNorm: normalizeTitleKey(title) });
        }
        return Array.from(byChannel.values());
    }

    function getPreviousRows(entry, currentTitle) {
        const currentNorm = normalizeTitleKey(currentTitle);
        return normalizeTitleHistory(entry?.titleHistory, entry?.channelName, MAX_TITLES_PER_LIVE).filter(
            (row) => normalizeTitleKey(row.title) !== currentNorm
        );
    }

    function formatSeenRange(row) {
        const first = Number(row.firstSeenAt) || 0;
        const last = Number(row.lastSeenAt) || 0;
        if (first > 0 && last > 0 && first !== last) {
            return isSameKstDate(first, last)
                ? `${formatKstDateTime(first)}-${formatKstTime(last)}`
                : `${formatKstDateTime(first)} - ${formatKstDateTime(last)}`;
        }
        return first > 0 || last > 0 ? formatKstDateTime(first || last) : "기록 시각 없음";
    }

    function getPanel() {
        const panel = document.getElementById(PANEL_ID);
        return panel instanceof HTMLElement ? panel : null;
    }

    function closePanel() {
        activeChannelId = "";
        for (const button of document.querySelectorAll(`[${BUTTON_ATTR}]`)) {
            if (button.getAttribute("aria-expanded") !== "false") button.setAttribute("aria-expanded", "false");
        }
        const panel = getPanel();
        if (panel) panel.hidden = true;
    }

    function positionPanel(button, panel) {
        if (!(button instanceof HTMLElement) || !(panel instanceof HTMLElement) || panel.hidden) return;
        const buttonRect = button.getBoundingClientRect();
        const viewportWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);
        const viewportHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0);
        const margin = 12;
        const panelRect = panel.getBoundingClientRect();
        const width = Math.min(panelRect.width || 560, Math.max(220, viewportWidth - margin * 2));
        const height = Math.min(panelRect.height || 160, Math.max(120, viewportHeight - margin * 2));
        const left = Math.min(
            Math.max(margin, buttonRect.right - width),
            Math.max(margin, viewportWidth - margin - width)
        );
        const top = Math.min(
            Math.max(margin, buttonRect.bottom + 6),
            Math.max(margin, viewportHeight - margin - height)
        );
        panel.style.setProperty("--bcfth-left", `${Math.round(left)}px`);
        panel.style.setProperty("--bcfth-top", `${Math.round(top)}px`);
    }

    function renderPanel(button, entry, currentTitle) {
        const rows = getPreviousRows(entry, currentTitle);
        if (!rows.length) {
            closePanel();
            return;
        }

        let panel = getPanel();
        if (!panel) {
            panel = document.createElement("div");
            panel.id = PANEL_ID;
            panel.hidden = true;
            panel.setAttribute("role", "region");
            panel.setAttribute("aria-label", "이전 방송 제목");
            document.body.appendChild(panel);
        }

        const fragment = document.createDocumentFragment();
        for (const row of rows) {
            const item = document.createElement("div");
            item.className = "bcfth-row";
            const time = document.createElement("span");
            time.className = "bcfth-time";
            time.textContent = formatSeenRange(row);
            const title = document.createElement("strong");
            title.className = "bcfth-title";
            title.textContent = row.title;
            item.append(time, title);
            fragment.appendChild(item);
        }
        panel.replaceChildren(fragment);
        panel.hidden = false;
        positionPanel(button, panel);
    }

    function clearHostIfUnused(host) {
        if (!(host instanceof HTMLElement) || host.querySelector(`[${BUTTON_ATTR}]`)) return;
        host.removeAttribute(HOST_ATTR);
        host.querySelectorAll(`[${TITLE_ATTR}]`).forEach((title) => title.removeAttribute(TITLE_ATTR));
    }

    function findCandidateButton(host, channelId) {
        if (!(host instanceof HTMLElement)) return null;
        return (
            Array.from(host.querySelectorAll(`[${BUTTON_ATTR}]`)).find(
                (button) => button.getAttribute(CHANNEL_ATTR) === channelId
            ) || null
        );
    }

    function removeCandidateButton(candidate) {
        const host = candidate.link.parentElement;
        const button = findCandidateButton(host, candidate.channelId);
        if (button?.getAttribute("aria-expanded") === "true") closePanel();
        button?.remove();
        clearHostIfUnused(host);
    }

    function renderCandidate(candidate, entry) {
        const rows = getPreviousRows(entry, candidate.title);
        if (!rows.length) {
            removeCandidateButton(candidate);
            return;
        }

        const host = candidate.link.parentElement;
        if (!(host instanceof HTMLElement)) return;
        host.setAttribute(HOST_ATTR, "1");
        candidate.link.setAttribute(TITLE_ATTR, "1");

        let button = findCandidateButton(host, candidate.channelId);
        if (!(button instanceof HTMLButtonElement)) {
            button?.remove();
            button = document.createElement("button");
            button.type = "button";
            button.setAttribute(BUTTON_ATTR, "1");
            button.setAttribute(CHANNEL_ATTR, candidate.channelId);
            button.innerHTML = '<span class="bcfth-chevron" aria-hidden="true"></span>';
            button.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const shouldOpen =
                    activeChannelId !== candidate.channelId || button.getAttribute("aria-expanded") !== "true";
                closePanel();
                if (!shouldOpen) return;
                activeChannelId = candidate.channelId;
                button.setAttribute("aria-expanded", "true");
                renderPanel(button, storeEntries.get(candidate.channelId), getTitleText(candidate.link));
            });
            candidate.link.insertAdjacentElement("afterend", button);
        }

        const label = `이전 방송 제목 ${rows.length}개 보기`;
        button.setAttribute("aria-controls", PANEL_ID);
        button.setAttribute("aria-expanded", activeChannelId === candidate.channelId ? "true" : "false");
        button.setAttribute("aria-label", label);
        button.title = label;
        if (activeChannelId === candidate.channelId) renderPanel(button, entry, candidate.title);
    }

    function normalizeLiveMeta(json, channelId) {
        const content = json?.content ?? json ?? {};
        const channel = content.channel || content.channelInfo || content.channelModel || {};
        const channelName = pickString(channel.channelName, channel.name, content.channelName);
        return {
            channelId,
            channelName,
            liveId: normalizeId(content.liveId),
            title: cleanEntryTitle(pickString(content.liveTitle, content.title, content.broadcastTitle), channelName),
        };
    }

    function shouldVerify(candidate) {
        const verified = verifiedLives.get(candidate.channelId);
        if (!verified) return true;
        if (verified.titleNorm !== candidate.titleNorm) return true;
        return Date.now() - verified.verifiedAt > VERIFY_TTL_MS;
    }

    function queueVerification(candidate) {
        if (!shouldVerify(candidate)) return;
        const last = lastFetches.get(candidate.channelId);
        if (last?.titleNorm === candidate.titleNorm && Date.now() - last.requestedAt < RETRY_COOLDOWN_MS) return;
        fetchQueue.set(candidate.channelId, candidate);
        pumpFetchQueue();
    }

    function pumpFetchQueue() {
        if (!runtimeInstalled || !isEnabled() || !isFollowingRoute()) return;
        while (activeFetchCount < MAX_FETCH_CONCURRENCY && fetchQueue.size) {
            const [channelId, candidate] = fetchQueue.entries().next().value;
            fetchQueue.delete(channelId);
            verifyCandidate(candidate);
        }
    }

    function verifyCandidate(candidate) {
        const generation = runtimeGeneration;
        const controller = new AbortController();
        activeFetchCount += 1;
        fetchControllers.set(candidate.channelId, controller);
        lastFetches.set(candidate.channelId, { requestedAt: Date.now(), titleNorm: candidate.titleNorm });

        fetchJson(`${LIVE_DETAIL_API_BASE}/${encodeURIComponent(candidate.channelId)}/live-detail`, {
            signal: controller.signal,
            timeoutMs: FETCH_TIMEOUT_MS,
        })
            .then((json) => normalizeLiveMeta(json, candidate.channelId))
            .then(async (meta) => {
                if (generation !== runtimeGeneration || controller.signal.aborted) return;
                if (!meta.liveId || !meta.title || normalizeTitleKey(meta.title) !== candidate.titleNorm) return;
                await loadStore();
                if (generation !== runtimeGeneration || controller.signal.aborted) return;
                const entry = await recordVerifiedTitle(meta);
                verifiedLives.set(candidate.channelId, {
                    liveId: meta.liveId,
                    titleNorm: candidate.titleNorm,
                    verifiedAt: Date.now(),
                });
                if (candidate.link.isConnected && getTitleText(candidate.link) === candidate.title) {
                    renderCandidate(candidate, entry);
                }
            })
            .catch(() => {})
            .finally(() => {
                if (fetchControllers.get(candidate.channelId) === controller) {
                    fetchControllers.delete(candidate.channelId);
                }
                activeFetchCount = Math.max(0, activeFetchCount - 1);
                pumpFetchQueue();
            });
    }

    async function syncCandidates() {
        if (!runtimeInstalled || !isEnabled() || !isFollowingRoute()) {
            cleanupUi();
            return;
        }

        try {
            await loadStore();
        } catch (error) {
            console.warn("[Better Chzzk] 팔로잉 제목 이력 로드 실패", error);
            return;
        }

        const candidates = collectCandidates();
        const liveLinks = new Set(candidates.map((candidate) => candidate.link));
        for (const button of document.querySelectorAll(`[${BUTTON_ATTR}]`)) {
            const host = button.parentElement;
            const titleLink = host?.querySelector(`[${TITLE_ATTR}]`);
            if (!liveLinks.has(titleLink)) {
                button.remove();
                clearHostIfUnused(host);
            }
        }

        for (const candidate of candidates) {
            const verified = verifiedLives.get(candidate.channelId);
            const entry = storeEntries.get(candidate.channelId);
            if (verified?.liveId && verified.liveId === entry?.liveId && verified.titleNorm === candidate.titleNorm) {
                renderCandidate(candidate, entry);
            } else {
                removeCandidateButton(candidate);
            }
            queueVerification(candidate);
        }

        if (activeChannelId && !document.querySelector(`[${BUTTON_ATTR}][aria-expanded="true"]`)) closePanel();
    }

    function scheduleSync() {
        if (syncFrame) return;
        syncFrame = requestAnimationFrame(() => {
            syncFrame = 0;
            syncCandidates();
        });
    }

    function cleanupUi() {
        closePanel();
        document.querySelectorAll(`[${BUTTON_ATTR}]`).forEach((button) => button.remove());
        document.querySelectorAll(`[${HOST_ATTR}]`).forEach((host) => host.removeAttribute(HOST_ATTR));
        document.querySelectorAll(`[${TITLE_ATTR}]`).forEach((title) => title.removeAttribute(TITLE_ATTR));
        getPanel()?.remove();
    }

    function abortFetches() {
        fetchQueue.clear();
        for (const controller of fetchControllers.values()) controller.abort();
        fetchControllers.clear();
        activeFetchCount = 0;
    }

    function handlePageChange() {
        runtimeGeneration += 1;
        verifiedLives.clear();
        lastFetches.clear();
        abortFetches();
        cleanupUi();
        scheduleSync();
    }

    function handleViewportChange() {
        if (!activeChannelId) return;
        const button = document.querySelector(`[${BUTTON_ATTR}][aria-expanded="true"]`);
        const panel = getPanel();
        if (button instanceof HTMLElement && panel) positionPanel(button, panel);
    }

    function handleStorageChange(changes, areaName) {
        if (areaName !== "local" || !changes[STORAGE_KEY]) return;
        storeLoaded = false;
        storeLoadPromise = null;
        loadStore({ force: true })
            .then(scheduleSync)
            .catch((error) => console.warn("[Better Chzzk] 팔로잉 제목 이력 동기화 실패", error));
    }

    function injectStyles() {
        injectStyleOnce(
            STYLE_ID,
            `
[${HOST_ATTR}="1"]{position:relative!important}
[${TITLE_ATTR}="1"]{box-sizing:border-box!important;padding-right:28px!important}
[${BUTTON_ATTR}="1"]{
  position:absolute;top:0;right:0;z-index:2;display:inline-flex;align-items:center;justify-content:center;
  width:22px;height:22px;min-width:22px;margin:0;padding:0;border:1px solid var(--Border-Neutral-Alpha-Weak,rgba(0,0,0,.12));
  border-radius:999px;color:var(--Content-Neutral-Primary,#141517);background:var(--Surface-Neutral-Weaker,#eef1f5);
  font:inherit;font-size:0;line-height:1;cursor:pointer
}
[${BUTTON_ATTR}="1"]:hover{background:var(--Surface-Interaction-Lighten-Hovered,#e3e7ed)}
[${BUTTON_ATTR}="1"]:focus-visible{outline:2px solid var(--Border-Brand-Alpha-Base,rgba(0,168,107,.45));outline-offset:2px}
[${BUTTON_ATTR}="1"][aria-expanded="true"]{color:var(--Content-Brand-Strong,#00875a);background:var(--Surface-Brand-Alpha-Weak,rgba(0,168,107,.12));border-color:var(--Border-Brand-Alpha-Base,rgba(0,168,107,.28))}
[${BUTTON_ATTR}="1"] .bcfth-chevron{display:block;width:7px;height:7px;margin-top:-3px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);transition:transform 120ms ease,margin-top 120ms ease}
[${BUTTON_ATTR}="1"][aria-expanded="true"] .bcfth-chevron{margin-top:3px;transform:rotate(225deg)}
#${PANEL_ID}{position:fixed;left:var(--bcfth-left,12px);top:var(--bcfth-top,12px);z-index:2147483646;display:grid;width:max-content;max-width:min(560px,calc(100vw - 24px));max-height:min(360px,calc(100vh - 24px));overflow:auto;margin:0;padding:6px 8px;border:1px solid var(--Border-Neutral-Alpha-Weak,rgba(0,0,0,.1));border-radius:8px;color:var(--Content-Neutral-Primary,#141517);background:var(--Surface-Neutral-Base,rgba(255,255,255,.98));box-shadow:0 8px 24px rgba(0,0,0,.12);font-family:inherit;box-sizing:border-box}
#${PANEL_ID}[hidden]{display:none!important}
#${PANEL_ID} .bcfth-row{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:12px;align-items:center;min-width:0;padding:5px 0;border-top:1px solid var(--Border-Neutral-Alpha-Weak,rgba(0,0,0,.08))}
#${PANEL_ID} .bcfth-row:first-child{border-top:0}
#${PANEL_ID} .bcfth-time,#${PANEL_ID} .bcfth-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .bcfth-time{color:var(--Content-Neutral-Cool-Weak,#7b8493);font-size:12px;font-weight:700}
#${PANEL_ID} .bcfth-title{display:block;max-width:min(380px,calc(100vw - 190px));color:var(--Content-Neutral-Primary,#141517);font-size:13px;font-weight:700}
@media(prefers-color-scheme:dark){
  [${BUTTON_ATTR}="1"]{border-color:rgba(255,255,255,.16);color:#f2f4f7;background:rgba(255,255,255,.12)}
  #${PANEL_ID}{border-color:rgba(255,255,255,.14);color:#f2f4f7;background:rgba(24,26,29,.98);box-shadow:0 8px 24px rgba(0,0,0,.28)}
  #${PANEL_ID} .bcfth-time{color:#a6adba} #${PANEL_ID} .bcfth-title{color:#f2f4f7}
}
@media(max-width:720px){#${PANEL_ID} .bcfth-row{gap:8px}#${PANEL_ID} .bcfth-title{max-width:calc(100vw - 150px)}}
`
        );
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        runtimeGeneration += 1;
        injectStyles();
        removePageChangeDetection = startPageChangeDetection(handlePageChange);
        domObserver = createMutationObserverSync({
            onMutations(mutations) {
                if (!isFollowingRoute()) return;
                if (mutations.some((mutation) => mutation.type === "childList" || mutation.type === "characterData")) {
                    scheduleSync();
                }
            },
            onBodyReady: scheduleSync,
            options: { childList: true, subtree: true, characterData: true },
        });
        removeStorageChangeListener = startStorageChangeListener(handleStorageChange);
        window.addEventListener("resize", handleViewportChange, true);
        window.addEventListener("scroll", handleViewportChange, true);
        scheduleSync();
    }

    function teardownRuntime() {
        if (!runtimeInstalled) return;
        runtimeInstalled = false;
        runtimeGeneration += 1;
        if (syncFrame) cancelAnimationFrame(syncFrame);
        syncFrame = 0;
        abortFetches();
        domObserver?.disconnectAll?.();
        domObserver?.disconnect();
        domObserver = null;
        removePageChangeDetection?.();
        removePageChangeDetection = null;
        removeStorageChangeListener?.();
        removeStorageChangeListener = null;
        window.removeEventListener("resize", handleViewportChange, true);
        window.removeEventListener("scroll", handleViewportChange, true);
        verifiedLives.clear();
        lastFetches.clear();
        cleanupUi();
        document.getElementById(STYLE_ID)?.remove();
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isEnabled()) installRuntime();
        else teardownRuntime();
    }

    bindFeatureOptions(applyOptions);
})();
