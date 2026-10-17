/**
 * features/followingTitleHistory.js — 팔로잉 본문의 라이브 카드에 이전 방제를 다시보기와 같은 버튼·패널로 보여 준다.
 *
 * 동작 위치: isolated world, https://chzzk.naver.com/following 본문의 라이브 카드.
 * 하는 일: 서비스 워커(shared/followingTitleCollector.js)가 1분마다 모은 방송별 제목 이력을 읽기만 한다.
 *   저장된 이전 방제가 있는 카드만 live-detail로 현재 라이브 ID를 확인하고(카드 제목·주소가 바뀌면 다시 확인),
 *   저장된 이력의 라이브 ID와 같을 때만 현재 제목을 뺀 이전 방제를 제목 오른쪽 버튼으로 시각과 함께 펼쳐 보여 준다.
 *   확인값은 2분 동안만 쓰고 1분 30초가 지나면 미리 다시 확인한다. 만료된 뒤 확인 중·실패 구간에는 보여 주지 않는다.
 *   다른 방송의 제목은 보이지 않는다.
 * 수명주기: 옵션을 끄거나 라우트가 바뀌면 observer·listener·요청·UI를 정리하고, SPA 이동 후 재설치한다.
 * 옵션 키: followingTitleHistoryEnabled.
 * DOM 마커: #betterchzzk-following-title-history-style/panel,
 *   [data-bcfth-host], [data-bcfth-title], [data-bcfth-toggle].
 */
(() => {
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        fetchJson,
        formatKstDateTime,
        formatKstTime,
        injectStyleOnce,
        isSameKstDate,
        normalizeChzzkChannelId,
        startPageChangeDetection,
        startStorageChangeListener,
        storageGet,
    } = BetterChzzk.utils;
    const { STORAGE_KEY, getPreviousRows, normalizeId, normalizeStore, normalizeTitle } =
        globalThis.BetterChzzkFollowingTitleHistory;

    const STYLE_ID = "betterchzzk-following-title-history-style";
    const PANEL_ID = "betterchzzk-following-title-history-panel";
    const HOST_ATTR = "data-bcfth-host";
    const TITLE_ATTR = "data-bcfth-title";
    const BUTTON_ATTR = "data-bcfth-toggle";
    const CHANNEL_ATTR = "data-bcfth-channel-id";
    const COUNT_ATTR = "data-bcfth-count";
    const LIVE_DETAIL_API_BASE = "https://api.chzzk.naver.com/service/v3/channels";
    const MAX_FETCH_CONCURRENCY = 3;
    const VERIFY_TTL_MS = 2 * 60 * 1000;
    // 같은 방송이면 유효기간 안에 새 확인이 끝나도록 미리 다시 확인해요. 만료로 버튼·열린 패널이 끊기지 않아요.
    const VERIFY_REFRESH_MS = 90 * 1000;
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
    let storeRevision = 0;
    let storeEntries = new Map();
    let activeFetchCount = 0;
    let activeChannelId = "";
    const fetchQueue = new Map();
    const fetchControllers = new Map();
    const lastFetches = new Map();
    const verifiedLives = new Map();
    const panelRenderKeys = new WeakMap();

    function isEnabled() {
        return Boolean(featureOptions.followingTitleHistoryEnabled && storage);
    }

    function isFollowingRoute() {
        return location.pathname.replace(/\/+$/, "") === "/following";
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

    function setStore(raw) {
        storeEntries = new Map(normalizeStore(raw).entries.map((entry) => [entry.channelId, entry]));
        storeLoaded = true;
        return storeEntries;
    }

    function loadStore() {
        if (!storage) return Promise.resolve(new Map());
        if (storeLoaded) return Promise.resolve(storeEntries);
        if (storeLoadPromise) return storeLoadPromise;

        const revision = storeRevision;
        // 읽는 사이 변경 알림으로 더 새 값이 들어왔으면 늦게 도착한 읽기 결과로 되돌리지 않아요.
        const request = storageGet(storage, STORAGE_KEY)
            .then((data) => (revision === storeRevision ? setStore(data?.[STORAGE_KEY]) : storeEntries))
            .finally(() => {
                if (storeLoadPromise === request) storeLoadPromise = null;
            });
        storeLoadPromise = request;
        return request;
    }

    function getMainRoot() {
        return document.querySelector("main, [role='main'], #layout-body");
    }

    function getTitleText(link) {
        if (!(link instanceof HTMLAnchorElement)) return "";
        const clone = link.cloneNode(true);
        clone.querySelectorAll(`.blind, [aria-hidden="true"], [${BUTTON_ATTR}]`).forEach((node) => node.remove());
        return normalizeTitle(clone.textContent || "");
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
            byChannel.set(channelId, { card, channelId, link, title });
        }
        return Array.from(byChannel.values());
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

    function setButtonExpanded(button, expanded) {
        const count = Number(button.getAttribute(COUNT_ATTR)) || 0;
        const label = expanded ? "이전 방제 접기" : `이전 방제 ${count}개 보기`;
        if (button.getAttribute("aria-expanded") !== String(expanded)) {
            button.setAttribute("aria-expanded", String(expanded));
        }
        if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
        if (button.title !== label) button.title = label;
    }

    function closePanel() {
        activeChannelId = "";
        for (const button of document.querySelectorAll(`[${BUTTON_ATTR}]`)) setButtonExpanded(button, false);
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
            panel.setAttribute("aria-label", "이전 방제");
            document.body.appendChild(panel);
        }

        // 열린 패널은 화면 동기화마다 다시 불려요. 같은 내용이면 다시 그리지 않아야 자기 변경이 본문 관찰을 깨워
        // 매 프레임 다시 그리는 반복이 생기지 않고, 펼친 제목을 선택할 수도 있어요(다시보기 이전 방제와 같은 방식).
        const renderKey = JSON.stringify(rows.map((row) => [row.title, row.firstSeenAt, row.lastSeenAt]));
        if (panelRenderKeys.get(panel) !== renderKey) {
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
            panelRenderKeys.set(panel, renderKey);
        }
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
                // 치지직이 같은 제목 링크의 주소만 다른 채널로 바꿨을 수 있어요. 만든 때의 채널을 쓰기 전에 다시 읽어요.
                if (!isCandidateCurrent(candidate, button)) {
                    closePanel();
                    scheduleSync();
                    return;
                }
                const shouldOpen =
                    activeChannelId !== candidate.channelId || button.getAttribute("aria-expanded") !== "true";
                closePanel();
                if (!shouldOpen) return;
                const title = getTitleText(candidate.link);
                const verifiedEntry = getVerifiedEntry(candidate.channelId, title);
                if (!verifiedEntry) {
                    scheduleSync();
                    return;
                }
                activeChannelId = candidate.channelId;
                setButtonExpanded(button, true);
                renderPanel(button, verifiedEntry, title);
            });
            candidate.link.insertAdjacentElement("afterend", button);
        }

        button.setAttribute("aria-controls", PANEL_ID);
        button.setAttribute(COUNT_ATTR, String(rows.length));
        setButtonExpanded(button, activeChannelId === candidate.channelId);
        if (activeChannelId === candidate.channelId) renderPanel(button, entry, candidate.title);
    }

    function isCandidateCurrent(candidate, button) {
        return (
            candidate.link.isConnected &&
            button.parentElement === candidate.link.parentElement &&
            extractChannelId(candidate.link.getAttribute("href") || "") === candidate.channelId
        );
    }

    // 시계가 뒤로 간 확인값도 지금 방송의 근거로 쓰지 않아요.
    function verificationAge(verified, now = Date.now()) {
        const age = now - verified.verifiedAt;
        return age >= 0 ? age : Infinity;
    }

    // 지금 카드 제목으로 2분 안에 확인한 live-detail 라이브 ID가 저장된 이력의 라이브 ID와 같을 때만 그 이력을 써요.
    // 만료된 확인값은 다시 확인하는 중이거나 확인이 실패해도 지금 방송의 근거가 아니에요.
    function getVerifiedEntry(channelId, title) {
        const verified = verifiedLives.get(channelId);
        const entry = storeEntries.get(channelId);
        if (!verified || !entry || verificationAge(verified) > VERIFY_TTL_MS) return null;
        return verified.title === title && verified.liveId === entry.liveId ? entry : null;
    }

    // 카드의 채널이 지금 어떤 방송인지만 확인해요. 제목은 서비스 워커가 모은 이력을 쓰고 여기서 저장하지 않아요.
    // 같은 채널이 방송을 다시 켜면 카드 제목이 먼저 바뀔 수 있고, 같은 제목으로 다시 켜도 2분 안에 다시 확인해요.
    function shouldVerify(candidate) {
        const verified = verifiedLives.get(candidate.channelId);
        if (!verified || verified.title !== candidate.title) return true;
        if (verificationAge(verified) > VERIFY_REFRESH_MS) return true;
        const entryLiveId = storeEntries.get(candidate.channelId)?.liveId || "";
        return Boolean(entryLiveId) && entryLiveId !== verified.liveId && entryLiveId !== verified.entryLiveId;
    }

    function queueVerification(candidate) {
        if (!shouldVerify(candidate) || fetchControllers.has(candidate.channelId)) return;
        // 실패한 확인만 잠시 쉬어요. 성공한 뒤 저장된 라이브 ID가 바뀐 경우는 바로 한 번 다시 확인해요.
        const last = lastFetches.get(candidate.channelId);
        const verifiedAt = verifiedLives.get(candidate.channelId)?.verifiedAt || 0;
        if (last && last.requestedAt > verifiedAt && Date.now() - last.requestedAt < RETRY_COOLDOWN_MS) return;
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
        const entryLiveId = storeEntries.get(candidate.channelId)?.liveId || "";
        activeFetchCount += 1;
        fetchControllers.set(candidate.channelId, controller);
        lastFetches.set(candidate.channelId, { requestedAt: Date.now() });

        fetchJson(`${LIVE_DETAIL_API_BASE}/${encodeURIComponent(candidate.channelId)}/live-detail`, {
            signal: controller.signal,
            timeoutMs: FETCH_TIMEOUT_MS,
        })
            .then((json) => {
                if (generation !== runtimeGeneration || controller.signal.aborted) return;
                const liveId = normalizeId(json?.content?.liveId);
                if (!liveId) return;
                verifiedLives.set(candidate.channelId, {
                    liveId,
                    entryLiveId,
                    title: candidate.title,
                    verifiedAt: Date.now(),
                });
                scheduleSync();
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
            console.warn("[Cheese Spanner] 팔로잉 방제 이력 로드 실패", error);
            return;
        }
        if (!runtimeInstalled || !isEnabled() || !isFollowingRoute()) return;

        const candidates = collectCandidates();
        const candidateByLink = new Map(candidates.map((candidate) => [candidate.link, candidate]));
        // 치지직이 같은 제목 링크를 다른 채널 카드로 재사용하면 이전 채널의 버튼을 남기지 않아요.
        for (const button of document.querySelectorAll(`[${BUTTON_ATTR}]`)) {
            const host = button.parentElement;
            const candidate = candidateByLink.get(host?.querySelector(`[${TITLE_ATTR}]`));
            if (!candidate || candidate.channelId !== button.getAttribute(CHANNEL_ATTR)) {
                if (button.getAttribute("aria-expanded") === "true") closePanel();
                button.remove();
                clearHostIfUnused(host);
            }
        }

        for (const candidate of candidates) {
            // 저장된 이전 방제가 없으면 버튼을 만들 수 없으니 방송 확인 요청도 보내지 않아요.
            if (!getPreviousRows(storeEntries.get(candidate.channelId), candidate.title).length) {
                removeCandidateButton(candidate);
                continue;
            }
            const entry = getVerifiedEntry(candidate.channelId, candidate.title);
            if (entry) renderCandidate(candidate, entry);
            else removeCandidateButton(candidate);
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
        // 확인한 방송은 2분 동안 유효해 팔로잉을 잠시 떠났다 돌아와도 다시 묻지 않아요. 지난 확인만 버려요.
        const now = Date.now();
        for (const [channelId, verified] of verifiedLives) {
            if (verificationAge(verified, now) > VERIFY_TTL_MS) verifiedLives.delete(channelId);
        }
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
        storeRevision += 1;
        storeLoadPromise = null;
        setStore(changes[STORAGE_KEY].newValue);
        scheduleSync();
    }

    function injectStyles() {
        // Colors, radii, shadow and Pretendard come from shared/uiTheme.js (--bct-*), which follows CHZZK's root theme.
        BetterChzzk.utils.ensureUiTheme?.();
        injectStyleOnce(
            STYLE_ID,
            `
[${HOST_ATTR}="1"]{position:relative!important}
[${TITLE_ATTR}="1"]{box-sizing:border-box!important;padding-right:30px!important}
[${BUTTON_ATTR}="1"]{
  position:absolute;top:0;right:0;z-index:2;display:inline-flex;align-items:center;justify-content:center;
  width:24px;height:24px;min-width:24px;margin:0;padding:0;border:1px solid var(--bct-border-alpha);
  border-radius:var(--bct-radius-full);color:var(--bct-text);background:var(--bct-surface-weak);
  font:inherit;font-size:0;line-height:1;cursor:pointer
}
[${BUTTON_ATTR}="1"]:hover{background-image:linear-gradient(var(--bct-hover),var(--bct-hover))}
[${BUTTON_ATTR}="1"]:focus-visible{outline:2px solid var(--bct-focus-ring);outline-offset:2px}
[${BUTTON_ATTR}="1"][aria-expanded="true"]{color:var(--bct-brand-text);background-color:var(--bct-brand-weak);border-color:color-mix(in srgb,var(--bct-brand-text) 40%,transparent)}
[${BUTTON_ATTR}="1"] .bcfth-chevron{display:block;width:7px;height:7px;margin-top:-3px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(45deg);transition:transform 120ms ease,margin-top 120ms ease}
[${BUTTON_ATTR}="1"][aria-expanded="true"] .bcfth-chevron{margin-top:3px;transform:rotate(225deg)}
#${PANEL_ID}{position:fixed;left:var(--bcfth-left,12px);top:var(--bcfth-top,12px);z-index:2147483646;display:grid;width:max-content;max-width:min(760px,calc(100vw - 24px));max-height:min(360px,calc(100vh - 24px));overflow:auto;margin:0;padding:6px 8px;border:1px solid var(--bct-border);border-radius:var(--bct-radius-lg);color:var(--bct-text);background:var(--bct-surface);box-shadow:var(--bct-shadow);font-family:var(--bct-font);box-sizing:border-box}
#${PANEL_ID}[hidden]{display:none!important}
#${PANEL_ID} .bcfth-row{display:grid;grid-template-columns:max-content max-content;gap:12px;align-items:center;min-width:0;padding:5px 0;border-top:1px solid var(--bct-border-weaker)}
#${PANEL_ID} .bcfth-row:first-child{border-top:0;padding-top:0}
#${PANEL_ID} .bcfth-time,#${PANEL_ID} .bcfth-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .bcfth-time{color:var(--bct-text-muted);font-size:12px;font-weight:600}
#${PANEL_ID} .bcfth-title{display:block;max-width:min(560px,calc(100vw - 190px));color:var(--bct-text);font-size:13px;font-weight:700}
@media(max-width:720px){#${PANEL_ID} .bcfth-row{grid-template-columns:max-content minmax(0,1fr);gap:8px}#${PANEL_ID} .bcfth-title{max-width:calc(100vw - 150px)}}
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
                // 제목은 그대로 두고 링크 주소만 다른 채널로 바뀌어도 이전 채널의 버튼·패널을 정리해야 해요.
                if (
                    mutations.some(
                        (mutation) =>
                            mutation.type === "childList" ||
                            mutation.type === "characterData" ||
                            (mutation.type === "attributes" && mutation.target instanceof HTMLAnchorElement)
                    )
                ) {
                    scheduleSync();
                }
            },
            onBodyReady: scheduleSync,
            options: {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["href"],
            },
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
        // 꺼져 있는 동안은 변경 알림을 받지 않으니 다시 켤 때 저장값을 새로 읽어요.
        storeRevision += 1;
        storeLoaded = false;
        storeLoadPromise = null;
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
