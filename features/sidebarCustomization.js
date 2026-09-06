/**
 * features/sidebarCustomization.js — 치지직 사이드바의 치즈팜 메뉴와 팔로잉 채널 고정을 관리한다.
 *
 * 동작 위치: isolated world, chzzk.naver.com 전역의 #sidebar.
 * 하는 일: 옵션에 따라 사이드바의 /cheezefarm 메뉴와 선택한 구역을 숨기고, 팔로잉 새로고침 버튼 왼쪽에 고정
 *   모드 토글을 붙인다. 고정된 채널명 옆에 상태 핀을 표시하고, 고정 모드에서 채널을 선택해 저장한다.
 *   CSS order로 고정 라이브는 최상단, 고정 오프라인은 오프라인 그룹 상단에 배치한다. 옵션을 켜면
 *   고정 오프라인도 최상단에 모은다. 접힌 목록의 네이티브 상위 5개 밖에 고정 채널이 있으면 치지직이
 *   사용하는 팔로잉 API 순서에서 확인한 채널만 확장 소유 행으로 보충한다. React가 소유한 행은 이동하지
 *   않으며, 목록 갱신·DOM 재마운트·노드 재사용 때 현재 href를 다시 검증한다.
 *   보충 행의 일반 클릭은 routeBridgePage.js에 DOM 이벤트로 전달해 치지직 라우터로 이동한다.
 *   팔로잉 링크 드래그는 고정 옵션과 독립적으로 URL 데이터를 전달하며, 드래그 종료 때 원래 속성을 복구한다.
 * 의존: BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, fetchJson, injectStyleOnce, normSpace, normalizeChzzkChannelId,
 *   normalizeChzzkImageUrl,
 *   startPageChangeDetection, startStorageChangeListener, storageGet, storageSet), BetterChzzk.selectors(CHZZK, queryChain).
 * 옵션 키: sidebarCheeseFarmHidden, followingPinEnabled, followingPinOfflineToTopEnabled.
 *   sidebarPopularCategoriesHidden, sidebarUpcomingScheduleHidden, sidebarPartnerStreamersHidden,
 *   sidebarServiceLinksHidden.
 * 저장 키: chrome.storage.sync.betterchzzkPinnedFollowingChannelIds (채널 ID 배열, 최대 64개).
 * DOM 마커: #betterchzzk-sidebar-customization-style, #betterchzzk-following-pin-mode, data-bcsf-* 속성.
 */
(() => {
    const { normalizeOptions } = BetterChzzkSettings;
    const { CHZZK, queryChain } = BetterChzzk.selectors;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        fetchJson,
        injectStyleOnce,
        normSpace,
        normalizeChzzkChannelId,
        normalizeChzzkImageUrl,
        startStorageChangeListener,
        storageGet,
        storageSet,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    const STORAGE_KEY = "betterchzzkPinnedFollowingChannelIds";
    const MAX_PINNED_CHANNELS = 64;
    const STYLE_ID = "betterchzzk-sidebar-customization-style";
    const MODE_BUTTON_ID = "betterchzzk-following-pin-mode";
    const CHEESE_HIDDEN_ATTR = "data-bcsf-cheese-hidden";
    const SECTION_HIDDEN_ATTR = "data-bcsf-section-hidden";
    const SECTION_OPTIONS = new Map([
        ["인기 카테고리", "sidebarPopularCategoriesHidden"],
        ["다가오는 방송 일정", "sidebarUpcomingScheduleHidden"],
        ["파트너 스트리머", "sidebarPartnerStreamersHidden"],
        ["서비스 바로가기", "sidebarServiceLinksHidden"],
    ]);
    const LIST_ATTR = "data-bcsf-list";
    const ROW_ATTR = "data-bcsf-row";
    const ORDER_GROUP_ATTR = "data-bcsf-order-group";
    const PINNED_ATTR = "data-bcsf-pinned";
    const PIN_INDICATOR_ATTR = "data-bcsf-pin-indicator";
    const PIN_MODE_ATTR = "data-bcsf-pin-mode";
    const PIN_TARGET_ATTR = "data-bcsf-pin-target";
    const MODE_BUTTON_ATTR = "data-bcsf-pin-mode-button";
    const CHANNEL_ATTR = "data-bcsf-channel-id";
    const SOURCE_ROW_ATTR = "data-bcsf-source-row";
    const SOURCE_HIDDEN_ATTR = "data-bcsf-source-hidden";
    const SOURCE_FINGERPRINT_ATTR = "data-bcsf-source-fingerprint";
    const SOURCE_BADGE_ATTR = "data-bcsf-channel-badge";
    const COLLAPSED_ROW_COUNT = 5;
    const FOLLOWING_FETCH_SIZE = 505;
    const SOURCE_CACHE_TTL_MS = 60000;
    const SOURCE_RETRY_DELAY_MS = 30000;
    const FOLLOWING_API_BASE = "https://api.chzzk.naver.com/service/v1/channels";
    const BADGE_ASSET_API_URL =
        "https://api.chzzk.naver.com/service/v1/badges/assets?badgeType=CHANNEL_ACHIEVEMENT&size=100&page=0";
    const VERIFIED_MARK_IMAGE_URL = "https://ssl.pstatic.net/static/nng/glive/image/icon_official_mark.png";
    const REFRESH_BUTTON_SELECTOR = 'button[aria-label], [role="button"][aria-label]';
    const REFRESH_LABEL_RE = /새로고침|refresh/i;
    const FOLLOWING_HREF_RE = /^\/following\/?$/i;
    const FOLLOWING_TEXT_RE = /팔로(잉|우)|following|follow/i;
    const PIN_ICON_SVG =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 4.5 19 9l-2 2-1.1-1.1-3.2 3.2.3 3.4-1.4 1.4-2.8-2.8-3.3 3.3-.9-.9 3.3-3.3-2.8-2.8L6.5 10l3.4.3 3.2-3.2L12 6l2.5-1.5Z"/></svg>';
    let followingDrag = null;
    const RESERVED_ROOT_PATHS = new Set([
        "category",
        "cheezefarm",
        "clips",
        "following",
        "lives",
        "partner",
        "schedule",
        "search",
        "studio",
        "video",
    ]);
    const STYLE_TEXT = `
#sidebar [${SECTION_HIDDEN_ATTR}="1"]{
  display:none!important;
}
html[${CHEESE_HIDDEN_ATTR}="1"] #sidebar li:has(a[href="/cheezefarm"]),
html[${CHEESE_HIDDEN_ATTR}="1"] #sidebar a[href="/cheezefarm"]{
  display:none!important;
}
#sidebar [${LIST_ATTR}="1"]{
  display:flex!important;
  flex-direction:column!important;
  align-items:stretch!important;
}
#sidebar [${ORDER_GROUP_ATTR}="pinned"]{
  order:-3!important;
}
#sidebar [${ORDER_GROUP_ATTR}="live"]{
  order:-2!important;
}
#sidebar [${ORDER_GROUP_ATTR}="offline-pinned"]{
  order:-1!important;
}
#sidebar [${ORDER_GROUP_ATTR}="offline"]{
  order:0!important;
}
#sidebar [${SOURCE_HIDDEN_ATTR}="1"]{
  display:none!important;
}
#sidebar [${SOURCE_BADGE_ATTR}]{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 1em;
  width:1em;
  height:1em;
  margin-inline-start:4px;
  vertical-align:top;
}
#sidebar [${SOURCE_BADGE_ATTR}] img{
  display:block;
  width:100%;
  height:100%;
  object-fit:contain;
}
#sidebar [${PIN_INDICATOR_ATTR}="1"]{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 12px;
  width:12px;
  height:12px;
  margin-inline-start:4px;
  vertical-align:middle;
  color:var(--Content-Accent-Strong,#087a4b);
}
#sidebar [${PIN_INDICATOR_ATTR}="1"] svg{
  width:100%;
  height:100%;
  fill:currentColor;
  pointer-events:none;
}
#sidebar [${LIST_ATTR}="1"][${PIN_MODE_ATTR}="1"] [${ROW_ATTR}="1"]{
  cursor:pointer;
}
#sidebar [${LIST_ATTR}="1"][${PIN_MODE_ATTR}="1"] [${ROW_ATTR}="1"][${PINNED_ATTR}="1"]{
  border-radius:8px;
  box-shadow:inset 0 0 0 1px var(--Border-Accent-Strong,#087a4b)!important;
}
#${MODE_BUTTON_ID}{
  align-items:center;
  justify-content:center;
}
#${MODE_BUTTON_ID}[aria-pressed="true"]{
  color:var(--Content-Accent-Strong,#087a4b)!important;
  box-shadow:inset 0 0 0 1px var(--Border-Accent-Strong,#087a4b)!important;
}
#${MODE_BUTTON_ID} svg{
  width:16px;
  height:16px;
  fill:currentColor;
  pointer-events:none;
}
`;

    const storage = globalThis.chrome?.storage?.sync;
    let featureOptions = normalizeOptions();
    let pinnedChannelIds = new Set();
    let persistedChannelIds = [];
    let runtimeInstalled = false;
    let domObserver = null;
    let sectionObserver = null;
    let sectionFrame = 0;
    const hiddenSections = new Set();
    let removeStorageChangeListener = null;
    let syncFrame = 0;
    let runtimeGeneration = 0;
    let writeChain = Promise.resolve();
    let pinModeEnabled = false;
    let sourceSnapshot = [];
    let sourceFetchedAt = 0;
    let sourceNextRetryAt = 0;
    let sourceFetchPromise = null;
    let sourceFetchController = null;
    let sourceBadgeAssets = new Map();
    const originalLinkStates = new WeakMap();

    function getOrderGroup(channelId, isLive) {
        if (pinnedChannelIds.has(channelId))
            return isLive || featureOptions.followingPinOfflineToTopEnabled ? "pinned" : "offline-pinned";
        return isLive ? "live" : "offline";
    }

    function normalizePinnedIds(value) {
        const rows = Array.isArray(value) ? value : [];
        const seen = new Set();
        const normalized = [];
        for (const row of rows) {
            const channelId = normalizeChzzkChannelId(row);
            if (!channelId || seen.has(channelId)) continue;
            seen.add(channelId);
            normalized.push(channelId);
            if (normalized.length >= MAX_PINNED_CHANNELS) break;
        }
        return normalized;
    }

    function sameIds(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function pickSourceText(...values) {
        for (const value of values) {
            const text = normSpace(value);
            if (text) return text;
        }
        return "";
    }

    function getSourceFollowingList(json) {
        const list = json?.content?.followingList;
        return Array.isArray(list) ? list : [];
    }

    function normalizeSourceBadgeIds(value) {
        if (!Array.isArray(value)) return [];
        return value
            .map((badgeId) => normSpace(badgeId))
            .filter((badgeId, index, values) => badgeId && badgeId.length <= 128 && values.indexOf(badgeId) === index);
    }

    function normalizeSourceBadgeAssets(json) {
        const rows = json?.content?.data;
        if (!Array.isArray(rows)) return new Map();
        const assets = new Map();
        for (const row of rows) {
            const badgeId = normSpace(row?.badgeId);
            const imageUrl = normalizeChzzkImageUrl(row?.imageUrl);
            if (!badgeId || badgeId.length > 128 || !imageUrl || assets.has(badgeId)) continue;
            assets.set(badgeId, {
                badgeId,
                imageUrl,
                title: pickSourceText(row?.title, row?.badgeName, "채널 배지"),
            });
        }
        return assets;
    }

    function normalizeSourceEntry(value, isLive) {
        const channel = value?.channel || {};
        const liveInfo = value?.liveInfo || {};
        const channelId = normalizeChzzkChannelId(value?.channelId || channel.channelId);
        if (!channelId) return null;

        const concurrentUserCount = Number(liveInfo.concurrentUserCount);
        return {
            channelId,
            isLive: Boolean(isLive),
            channelName: pickSourceText(channel.channelName, value?.channelName, channelId),
            channelImageUrl: normalizeChzzkImageUrl(channel.channelImageUrl || value?.channelImageUrl),
            verifiedMark: channel.verifiedMark === true || value?.verifiedMark === true,
            activatedChannelBadgeIds: normalizeSourceBadgeIds(
                channel.activatedChannelBadgeIds || value?.activatedChannelBadgeIds
            ),
            liveCategoryValue: pickSourceText(liveInfo.liveCategoryValue, value?.liveCategoryValue),
            concurrentUserCount: Number.isFinite(concurrentUserCount)
                ? Math.max(0, Math.floor(concurrentUserCount))
                : null,
            cvExposure: liveInfo.cvExposure !== false,
        };
    }

    function mergeSourceFollowingEntries(liveJson, followingJson) {
        const seen = new Set();
        const merged = [];
        const append = (values, isLive) => {
            for (const value of values) {
                const entry = normalizeSourceEntry(value, isLive);
                if (!entry || seen.has(entry.channelId)) continue;
                seen.add(entry.channelId);
                merged.push(entry);
                if (merged.length >= FOLLOWING_FETCH_SIZE) return;
            }
        };
        append(getSourceFollowingList(liveJson), true);
        if (merged.length < FOLLOWING_FETCH_SIZE) append(getSourceFollowingList(followingJson), false);
        return merged;
    }

    function getMainSourceBadgeAsset(entry) {
        const badgeId = entry.activatedChannelBadgeIds.find((value) => value !== "none");
        return badgeId ? sourceBadgeAssets.get(badgeId) || null : null;
    }

    function getSourceOrderRank(entry) {
        const pinned = pinnedChannelIds.has(entry.channelId);
        if (pinned && (entry.isLive || featureOptions.followingPinOfflineToTopEnabled)) return 0;
        if (entry.isLive) return 1;
        if (pinned) return 2;
        return 3;
    }

    function getDesiredCollapsedEntries() {
        return sourceSnapshot
            .map((entry, index) => ({ entry, index, rank: getSourceOrderRank(entry) }))
            .sort((left, right) => left.rank - right.rank || left.index - right.index)
            .slice(0, COLLAPSED_ROW_COUNT)
            .map(({ entry }) => entry);
    }

    function getSourceFingerprint(entry) {
        const mainBadge = getMainSourceBadgeAsset(entry);
        return [
            entry.channelId,
            entry.isLive ? "1" : "0",
            entry.channelName,
            entry.channelImageUrl,
            entry.verifiedMark ? "1" : "0",
            entry.activatedChannelBadgeIds[0] || "",
            mainBadge?.imageUrl || "",
            mainBadge?.title || "",
            entry.liveCategoryValue,
            entry.concurrentUserCount ?? "",
            entry.cvExposure ? "1" : "0",
        ].join("\u001f");
    }

    function getDirectSourceRows(list) {
        if (!(list instanceof HTMLElement)) return [];
        return Array.from(list.children).filter(
            (row) => row instanceof HTMLElement && row.hasAttribute(SOURCE_ROW_ATTR)
        );
    }

    function clearSourcePresentation(list = null) {
        const scope = list instanceof HTMLElement ? list : document;
        scope.querySelectorAll(`[${SOURCE_HIDDEN_ATTR}]`).forEach((row) => row.removeAttribute(SOURCE_HIDDEN_ATTR));
        scope.querySelectorAll(`[${SOURCE_ROW_ATTR}]`).forEach((row) => {
            cleanupRow(row);
            row.remove();
        });
    }

    function findSourceNameTextNode(nameNode) {
        const candidates = [nameNode, ...nameNode.querySelectorAll("span, strong")];
        const element = candidates.find(
            (node) =>
                node instanceof HTMLElement &&
                !node.matches(".blind, [class*='badge'], [class*='verified']") &&
                !node.hasAttribute(PIN_INDICATOR_ATTR) &&
                !node.hasAttribute(SOURCE_BADGE_ATTR) &&
                !node.children.length &&
                normSpace(node.textContent)
        );
        if (element) return element;

        const text = Array.from(nameNode.childNodes).find(
            (node) => node.nodeType === Node.TEXT_NODE && normSpace(node.textContent)
        );
        if (!text) return null;
        const wrapper = document.createElement("span");
        text.replaceWith(wrapper);
        return wrapper;
    }

    function createSourceChannelBadge(type, imageUrl, label) {
        const badge = document.createElement("span");
        badge.setAttribute(SOURCE_BADGE_ATTR, type);
        badge.setAttribute("role", "img");
        badge.setAttribute("aria-label", label);
        badge.title = label;
        const image = document.createElement("img");
        image.src = imageUrl;
        image.alt = "";
        image.setAttribute("aria-hidden", "true");
        badge.append(image);
        return badge;
    }

    function syncSourceChannelName(nameNode, entry) {
        const textNode = findSourceNameTextNode(nameNode);
        if (!(textNode instanceof HTMLElement)) return false;

        nameNode
            .querySelectorAll(
                `i, img, [class*='badge'], [class*='verified'], [${PIN_INDICATOR_ATTR}], [${SOURCE_BADGE_ATTR}]`
            )
            .forEach((node) => node.remove());
        textNode.textContent = entry.channelName;

        let insertionPoint = textNode;
        if (entry.verifiedMark) {
            const verified = createSourceChannelBadge("verified", VERIFIED_MARK_IMAGE_URL, "인증 마크");
            insertionPoint.after(verified);
            insertionPoint = verified;
        }
        const mainBadge = getMainSourceBadgeAsset(entry);
        if (mainBadge) {
            const achievement = createSourceChannelBadge("achievement", mainBadge.imageUrl, mainBadge.title);
            insertionPoint.after(achievement);
        }
        return true;
    }

    function createSourceRow(entry, templateMeta) {
        if (!(templateMeta?.row instanceof HTMLElement)) return null;
        const row = templateMeta.row.cloneNode(true);
        if (!(row instanceof HTMLElement)) return null;

        cleanupRow(row);
        row.removeAttribute("id");
        row.removeAttribute(SOURCE_HIDDEN_ATTR);
        row.setAttribute(SOURCE_ROW_ATTR, "1");
        row.setAttribute(SOURCE_FINGERPRINT_ATTR, getSourceFingerprint(entry));
        row.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
        row.querySelectorAll("button, [class*='tooltip']").forEach((node) => node.remove());
        row.querySelectorAll(".blind").forEach((node) => node.remove());

        const href = entry.isLive
            ? `/live/${encodeURIComponent(entry.channelId)}`
            : `/${encodeURIComponent(entry.channelId)}`;
        const channelLinks = Array.from(row.querySelectorAll("a[href]")).filter((link) =>
            parseChannelHref(link.getAttribute("href") || "")
        );
        if (!channelLinks.length) return null;
        for (const link of channelLinks) {
            link.setAttribute("href", href);
            link.setAttribute("aria-label", `${entry.channelName} ${entry.isLive ? "LIVE" : "오프라인"}`);
            link.removeAttribute("aria-current");
        }

        const nameNode = queryChain(row, CHZZK.channelName);
        if (!(nameNode instanceof HTMLElement)) return null;
        if (!syncSourceChannelName(nameNode, entry)) return null;

        const image = Array.from(row.querySelectorAll("img")).find(
            (candidate) => !candidate.closest(`[${SOURCE_BADGE_ATTR}]`)
        );
        if (image instanceof HTMLImageElement) {
            image.alt = "";
            image.removeAttribute("srcset");
            if (entry.channelImageUrl) image.src = entry.channelImageUrl;
            else image.removeAttribute("src");
        }

        const description = row.querySelector("[class*='description'], [class*='category']");
        if (description instanceof HTMLElement) description.textContent = entry.isLive ? entry.liveCategoryValue : "";
        const count = row.querySelector("em[class*='count'], [class*='viewer_count'], [class*='viewerCount']");
        if (count instanceof HTMLElement) {
            if (entry.isLive && entry.cvExposure && entry.concurrentUserCount !== null) {
                count.textContent = entry.concurrentUserCount.toLocaleString("ko-KR");
            } else if (entry.isLive) {
                count.textContent = "LIVE";
            } else {
                count.remove();
            }
        }
        return row;
    }

    function hasMissingPinnedChannel(rows) {
        if (rows.length !== COLLAPSED_ROW_COUNT || !pinnedChannelIds.size) return false;
        const renderedIds = new Set(rows.map((meta) => meta.channelId));
        return Array.from(pinnedChannelIds).some((channelId) => !renderedIds.has(channelId));
    }

    function maybeLoadSourceSnapshot(rows) {
        if (!hasMissingPinnedChannel(rows) || sourceFetchPromise) return;
        const now = Date.now();
        if (sourceFetchedAt && now - sourceFetchedAt < SOURCE_CACHE_TTL_MS) return;
        if (sourceNextRetryAt > now) return;

        const generation = runtimeGeneration;
        const controller = new AbortController();
        sourceFetchController = controller;
        const headers = { Accept: "application/json" };
        const badgeAssetsPromise = fetchJson(BADGE_ASSET_API_URL, { headers, signal: controller.signal }).catch(
            (error) => {
                if (!controller.signal.aborted) console.warn("[Better Chzzk] 팔로잉 채널 배지 자산 조회 실패", error);
                return null;
            }
        );
        sourceFetchPromise = Promise.all([
            fetchJson(`${FOLLOWING_API_BASE}/followings/live`, { headers, signal: controller.signal }),
            fetchJson(`${FOLLOWING_API_BASE}/followings?page=0&size=${FOLLOWING_FETCH_SIZE}&sortType=FOLLOW`, {
                headers,
                signal: controller.signal,
            }),
            badgeAssetsPromise,
        ])
            .then(([liveJson, followingJson, badgeAssetsJson]) => {
                if (!runtimeInstalled || generation !== runtimeGeneration || controller.signal.aborted) return;
                sourceSnapshot = mergeSourceFollowingEntries(liveJson, followingJson);
                if (badgeAssetsJson) sourceBadgeAssets = normalizeSourceBadgeAssets(badgeAssetsJson);
                sourceFetchedAt = Date.now();
                sourceNextRetryAt = 0;
            })
            .catch((error) => {
                if (!runtimeInstalled || generation !== runtimeGeneration || controller.signal.aborted) return;
                sourceNextRetryAt = Date.now() + SOURCE_RETRY_DELAY_MS;
                console.warn("[Better Chzzk] 팔로잉 고정용 전체 목록 조회 실패", error);
            })
            .finally(() => {
                if (sourceFetchController === controller) sourceFetchController = null;
                sourceFetchPromise = null;
                if (runtimeInstalled && generation === runtimeGeneration) scheduleSync();
            });
    }

    function syncCollapsedSourceRows(following) {
        const { list, rows } = following;
        maybeLoadSourceSnapshot(rows);
        if (rows.length !== COLLAPSED_ROW_COUNT || !sourceSnapshot.length || !hasMissingPinnedChannel(rows)) {
            clearSourcePresentation(list);
            return rows;
        }

        const desiredEntries = getDesiredCollapsedEntries();
        const desiredIds = new Set(desiredEntries.map((entry) => entry.channelId));
        const nativeById = new Map(rows.map((meta) => [meta.channelId, meta]));
        const missingEntries = desiredEntries.filter((entry) => !nativeById.has(entry.channelId));
        if (!missingEntries.some((entry) => pinnedChannelIds.has(entry.channelId))) {
            clearSourcePresentation(list);
            return rows;
        }

        for (const meta of rows) {
            if (desiredIds.has(meta.channelId)) meta.row.removeAttribute(SOURCE_HIDDEN_ATTR);
            else meta.row.setAttribute(SOURCE_HIDDEN_ATTR, "1");
        }

        const existingRows = new Map(
            getDirectSourceRows(list).map((row) => [normalizeChzzkChannelId(row.getAttribute(CHANNEL_ATTR)), row])
        );
        const activeSourceRows = [];
        for (const entry of missingEntries) {
            const fingerprint = getSourceFingerprint(entry);
            let row = existingRows.get(entry.channelId) || null;
            if (!row || row.getAttribute(SOURCE_FINGERPRINT_ATTR) !== fingerprint) {
                const sameStateTemplate = rows.find((meta) => meta.isLive === entry.isLive) || rows[0];
                const replacement = createSourceRow(entry, sameStateTemplate);
                if (!replacement) continue;
                if (row) row.replaceWith(replacement);
                else list.append(replacement);
                row = replacement;
            }
            row.setAttribute(CHANNEL_ATTR, entry.channelId);
            activeSourceRows.push(row);
            existingRows.delete(entry.channelId);
        }
        for (const row of existingRows.values()) {
            cleanupRow(row);
            row.remove();
        }

        const sourceMetas = activeSourceRows.map((row) => getRowMeta(row)).filter(Boolean);
        if (sourceMetas.length !== missingEntries.length) {
            clearSourcePresentation(list);
            return rows;
        }
        return [...rows, ...sourceMetas];
    }

    function invalidateSourceSnapshot() {
        sourceFetchedAt = 0;
        sourceNextRetryAt = 0;
    }

    function resetSourceSnapshot() {
        sourceFetchController?.abort();
        sourceFetchController = null;
        sourceFetchPromise = null;
        sourceSnapshot = [];
        sourceBadgeAssets = new Map();
        sourceFetchedAt = 0;
        sourceNextRetryAt = 0;
    }

    function ensureStyle() {
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
    }

    function syncStyle() {
        if (featureOptions.sidebarCheeseFarmHidden || runtimeInstalled || sectionObserver) ensureStyle();
        else document.getElementById(STYLE_ID)?.remove();
    }

    function syncSections() {
        sectionFrame = 0;
        const next = new Set();
        // 2026-09-06 https://chzzk.naver.com/: 각 구역은 nav > div > strong 제목을 사용한다.
        // 파트너 제목은 a 안에 있고, 새 창 안내 span은 제목의 정체성에 포함하지 않는다.
        for (const section of getSidebar()?.querySelectorAll("nav") || []) {
            const title = section.querySelector(":scope > div > strong");
            const label = title?.querySelector("a") || title;
            const text = normSpace(
                Array.from(label?.childNodes || [])
                    .filter((node) => node.nodeType === Node.TEXT_NODE)
                    .map((node) => node.textContent)
                    .join("")
            );
            const key = SECTION_OPTIONS.get(text);
            if (key && featureOptions[key]) next.add(section);
        }
        for (const section of hiddenSections) {
            if (!next.has(section)) section.removeAttribute(SECTION_HIDDEN_ATTR);
        }
        hiddenSections.clear();
        for (const section of next) {
            if (section.getAttribute(SECTION_HIDDEN_ATTR) !== "1") section.setAttribute(SECTION_HIDDEN_ATTR, "1");
            hiddenSections.add(section);
        }
    }

    function scheduleSections() {
        if (!sectionFrame) sectionFrame = window.requestAnimationFrame(syncSections);
    }

    function applySectionOptions() {
        if (Array.from(SECTION_OPTIONS.values()).some((key) => featureOptions[key])) {
            sectionObserver ||= createMutationObserverSync({
                target: getSidebar,
                options: { childList: true, subtree: true, characterData: true },
                schedule: scheduleSections,
                onObserved: scheduleSections,
                onBodyReady: scheduleSections,
            });
            scheduleSections();
            return;
        }
        sectionObserver?.disconnectAll?.();
        sectionObserver = null;
        if (sectionFrame) window.cancelAnimationFrame(sectionFrame);
        sectionFrame = 0;
        for (const section of hiddenSections) section.removeAttribute(SECTION_HIDDEN_ATTR);
        hiddenSections.clear();
    }

    function applyCheeseFarmOption() {
        if (featureOptions.sidebarCheeseFarmHidden) {
            document.documentElement.setAttribute(CHEESE_HIDDEN_ATTR, "1");
        } else {
            document.documentElement.removeAttribute(CHEESE_HIDDEN_ATTR);
        }
    }

    function parseChannelHref(href) {
        try {
            const url = new URL(href, location.origin);
            if (url.origin !== location.origin) return null;
            const segments = url.pathname
                .split("/")
                .filter(Boolean)
                .map((segment) => decodeURIComponent(segment));
            if (segments.length === 2 && segments[0].toLowerCase() === "live") {
                const channelId = normalizeChzzkChannelId(segments[1]);
                return channelId ? { channelId, isLive: true } : null;
            }
            if (segments.length !== 1 || RESERVED_ROOT_PATHS.has(segments[0].toLowerCase())) return null;
            const channelId = normalizeChzzkChannelId(segments[0]);
            return channelId ? { channelId, isLive: false } : null;
        } catch (_) {
            return null;
        }
    }

    function getRowMeta(row) {
        if (!(row instanceof HTMLElement)) return null;
        const entries = Array.from(row.querySelectorAll("a[href]"), (link) => ({
            link,
            meta: parseChannelHref(link.getAttribute("href") || ""),
        })).filter((entry) => entry.meta);
        const entry = entries.find((candidate) => candidate.meta.isLive) || entries[0];
        if (!entry) return null;

        const nameNode = queryChain(row, CHZZK.channelName);
        const channelName = normSpace(
            nameNode?.textContent ||
                entry.link.getAttribute("aria-label") ||
                entry.link.querySelector("img[alt]")?.getAttribute("alt") ||
                entry.link.textContent ||
                ""
        );
        return { ...entry.meta, channelName, nameNode, link: entry.link, row };
    }

    function getDirectRows(list) {
        if (!(list instanceof HTMLElement)) return [];
        return Array.from(list.children)
            .filter((row) => row instanceof HTMLElement && !row.hasAttribute(SOURCE_ROW_ATTR))
            .map((row) => getRowMeta(row))
            .filter(Boolean);
    }

    function hasFollowingLink(root) {
        return Array.from(root.querySelectorAll("a[href]"), (anchor) => {
            try {
                const url = new URL(anchor.getAttribute("href") || "", location.origin);
                return url.origin === location.origin && FOLLOWING_HREF_RE.test(url.pathname);
            } catch (_) {
                return false;
            }
        }).some(Boolean);
    }

    function findFollowingList(sidebar) {
        if (!(sidebar instanceof HTMLElement)) return null;
        const sections = sidebar.querySelectorAll("nav, section");
        for (const section of sections) {
            if (!hasFollowingLink(section) && !FOLLOWING_TEXT_RE.test(normSpace(section.textContent))) continue;
            for (const list of section.querySelectorAll("ul, [role='list']")) {
                const rows = getDirectRows(list);
                if (rows.length) return { section, list, rows };
            }
        }
        return null;
    }

    function findFollowingRefreshButton(section) {
        if (!(section instanceof HTMLElement)) return null;
        const headerButtons = section.querySelectorAll('header button[aria-label], header [role="button"][aria-label]');
        const candidates = headerButtons.length ? headerButtons : section.querySelectorAll(REFRESH_BUTTON_SELECTOR);
        return (
            Array.from(candidates).find(
                (button) =>
                    button.id !== MODE_BUTTON_ID &&
                    !button.hasAttribute(MODE_BUTTON_ATTR) &&
                    REFRESH_LABEL_RE.test(normSpace(button.getAttribute("aria-label")))
            ) || null
        );
    }

    function getSidebar() {
        const sidebar = document.getElementById("sidebar");
        return sidebar instanceof HTMLElement ? sidebar : null;
    }

    function restoreOriginalAttribute(node, name, value) {
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
    }

    function restorePinTarget(link) {
        if (!(link instanceof HTMLAnchorElement)) return;
        const original = originalLinkStates.get(link);
        if (original) {
            restoreOriginalAttribute(link, "role", original.role);
            restoreOriginalAttribute(link, "aria-pressed", original.ariaPressed);
            originalLinkStates.delete(link);
        }
        link.removeAttribute(PIN_TARGET_ATTR);
        link.removeAttribute(CHANNEL_ATTR);
    }

    function applyPinTarget(link, channelId, isPinned) {
        if (!(link instanceof HTMLAnchorElement)) return;
        if (!originalLinkStates.has(link)) {
            originalLinkStates.set(link, {
                role: link.getAttribute("role"),
                ariaPressed: link.getAttribute("aria-pressed"),
            });
        }
        link.setAttribute(PIN_TARGET_ATTR, "1");
        link.setAttribute(CHANNEL_ATTR, channelId);
        link.setAttribute("role", "button");
        link.setAttribute("aria-pressed", String(isPinned));
    }

    function cleanupRow(row) {
        if (!(row instanceof HTMLElement)) return;
        row.querySelectorAll("a[href]").forEach((link) => {
            if (originalLinkStates.has(link)) restorePinTarget(link);
        });
        row.querySelectorAll(`[${PIN_TARGET_ATTR}]`).forEach(restorePinTarget);
        row.querySelectorAll(`[${PIN_INDICATOR_ATTR}]`).forEach((indicator) => indicator.remove());
        row.removeAttribute(ROW_ATTR);
        row.removeAttribute(ORDER_GROUP_ATTR);
        row.removeAttribute(PINNED_ATTR);
        row.removeAttribute(CHANNEL_ATTR);
    }

    function cleanupModeButtons(keep = null) {
        document.querySelectorAll(`[${MODE_BUTTON_ATTR}]`).forEach((button) => {
            if (button !== keep) button.remove();
        });
    }

    function cleanupUi({ resetMode = false } = {}) {
        if (resetMode) pinModeEnabled = false;
        cleanupModeButtons();
        clearSourcePresentation();
        document.querySelectorAll(`[${LIST_ATTR}]`).forEach((list) => {
            list.removeAttribute(LIST_ATTR);
            list.removeAttribute(PIN_MODE_ATTR);
        });
        document.querySelectorAll(`[${ROW_ATTR}]`).forEach(cleanupRow);
        document.querySelectorAll(`[${PIN_TARGET_ATTR}]`).forEach(restorePinTarget);
    }

    function createModeButton() {
        const button = document.createElement("button");
        button.id = MODE_BUTTON_ID;
        button.type = "button";
        button.setAttribute(MODE_BUTTON_ATTR, "1");
        button.innerHTML = PIN_ICON_SVG;
        return button;
    }

    function syncModeButton(refreshButton) {
        if (!(refreshButton instanceof HTMLElement) || !refreshButton.parentElement) {
            cleanupModeButtons();
            return;
        }

        let button = document.getElementById(MODE_BUTTON_ID);
        if (!(button instanceof HTMLButtonElement)) {
            button?.remove();
            button = createModeButton();
        }
        cleanupModeButtons(button);
        button.id = MODE_BUTTON_ID;
        button.type = "button";
        button.setAttribute(MODE_BUTTON_ATTR, "1");
        if (button.className !== refreshButton.className) button.className = refreshButton.className;
        if (button.style.cssText !== refreshButton.style.cssText) button.style.cssText = refreshButton.style.cssText;
        const action = pinModeEnabled ? "끄기" : "켜기";
        const label = `팔로잉 채널 고정 모드 ${action}`;
        button.setAttribute("aria-pressed", String(pinModeEnabled));
        button.setAttribute("aria-label", label);
        button.title = label;
        if (button.nextSibling !== refreshButton) refreshButton.before(button);
    }

    function syncPinIndicator({ row, nameNode }, isPinned) {
        const show = isPinned && nameNode instanceof HTMLElement;
        let indicator = show ? nameNode.lastChild : null;
        if (!(indicator instanceof HTMLElement) || !indicator.hasAttribute(PIN_INDICATOR_ATTR)) indicator = null;
        row.querySelectorAll(`[${PIN_INDICATOR_ATTR}]`).forEach((node) => {
            if (node !== indicator) node.remove();
        });
        if (!show || indicator) return;

        indicator = document.createElement("span");
        indicator.setAttribute(PIN_INDICATOR_ATTR, "1");
        indicator.setAttribute("role", "img");
        indicator.setAttribute("aria-label", "고정됨");
        indicator.title = "고정됨";
        indicator.innerHTML = PIN_ICON_SVG;
        nameNode.append(indicator);
    }

    function syncRow(meta) {
        const { channelId, isLive, link, row } = meta;
        if (row.getAttribute(CHANNEL_ATTR) !== channelId) cleanupRow(row);
        row.setAttribute(ROW_ATTR, "1");
        row.setAttribute(CHANNEL_ATTR, channelId);

        const isPinned = pinnedChannelIds.has(channelId);
        row.querySelectorAll(`[${PIN_TARGET_ATTR}]`).forEach((target) => {
            if (target !== link) restorePinTarget(target);
        });
        if (pinModeEnabled) applyPinTarget(link, channelId, isPinned);
        else restorePinTarget(link);
        if (isPinned) row.setAttribute(PINNED_ATTR, "1");
        else row.removeAttribute(PINNED_ATTR);
        const orderGroup = getOrderGroup(channelId, isLive);
        row.setAttribute(ORDER_GROUP_ATTR, orderGroup);
        syncPinIndicator(meta, isPinned);
    }

    function syncUi() {
        syncFrame = 0;
        if (!runtimeInstalled || !featureOptions.followingPinEnabled) {
            cleanupUi();
            return;
        }

        const sidebar = getSidebar();
        const following = findFollowingList(sidebar);
        const rows = following ? syncCollapsedSourceRows(following) : [];
        const activeRows = new Set(rows.map((meta) => meta.row));

        document.querySelectorAll(`[${LIST_ATTR}]`).forEach((list) => {
            if (list !== following?.list) {
                list.removeAttribute(LIST_ATTR);
                list.removeAttribute(PIN_MODE_ATTR);
            }
        });
        document.querySelectorAll(`[${ROW_ATTR}]`).forEach((row) => {
            if (!activeRows.has(row)) cleanupRow(row);
        });

        if (!following) {
            clearSourcePresentation();
            cleanupModeButtons();
            return;
        }
        following.list.setAttribute(LIST_ATTR, "1");
        if (pinModeEnabled) following.list.setAttribute(PIN_MODE_ATTR, "1");
        else following.list.removeAttribute(PIN_MODE_ATTR);
        for (const meta of rows) syncRow(meta);
        syncModeButton(findFollowingRefreshButton(following.section));
    }

    function scheduleSync() {
        if (syncFrame || !runtimeInstalled) return;
        syncFrame = window.requestAnimationFrame(syncUi);
    }

    function setPinnedIds(value, { persisted = false } = {}) {
        const normalized = normalizePinnedIds(value);
        pinnedChannelIds = new Set(normalized);
        if (persisted) persistedChannelIds = normalized;
        scheduleSync();
        return normalized;
    }

    function persistPinnedIds(snapshot) {
        writeChain = writeChain
            .catch(() => {})
            .then(() => storageSet(storage, { [STORAGE_KEY]: snapshot }))
            .then(() => {
                persistedChannelIds = snapshot;
            })
            .catch((error) => {
                const current = Array.from(pinnedChannelIds);
                if (sameIds(current, snapshot)) setPinnedIds(persistedChannelIds);
                console.warn("[Better Chzzk] 팔로잉 채널 고정 저장 실패", error);
            });
        return writeChain;
    }

    function togglePinned(channelId) {
        const normalizedId = normalizeChzzkChannelId(channelId);
        if (!normalizedId) return;
        const next = new Set(pinnedChannelIds);
        if (next.has(normalizedId)) next.delete(normalizedId);
        else if (next.size >= MAX_PINNED_CHANNELS) {
            console.warn(`[Better Chzzk] 팔로잉 채널은 최대 ${MAX_PINNED_CHANNELS}개까지 고정할 수 있습니다.`);
            return;
        } else next.add(normalizedId);

        const snapshot = setPinnedIds(Array.from(next));
        void persistPinnedIds(snapshot);
    }

    function setPinMode(enabled) {
        pinModeEnabled = Boolean(enabled);
        scheduleSync();
    }

    function getPinTargetMeta(target) {
        if (!(target instanceof Element)) return null;
        const nativeControl = target.closest("button, input, select, textarea, [contenteditable='true']");
        if (nativeControl && !nativeControl.hasAttribute(PIN_TARGET_ATTR)) return null;
        const row = target.closest(`[${ROW_ATTR}]`);
        if (!(row instanceof HTMLElement)) return null;
        const meta = getRowMeta(row);
        if (!meta || row.getAttribute(CHANNEL_ATTR) !== meta.channelId) return null;
        return meta;
    }

    function hasNavigationModifier(event) {
        return event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
    }

    function followingDragLink(target) {
        const link = target instanceof Element && target.closest("a[href]");
        if (!(link instanceof HTMLAnchorElement) || !getSidebar()?.contains(link)) return null;
        if (target.closest("button, input, textarea, select, [contenteditable='true']")) return null;
        const following = findFollowingList(getSidebar());
        if (!following?.list.contains(link) || !parseChannelHref(link.getAttribute("href"))) return null;
        const url = new URL(link.href);
        return url.username || url.password ? null : link;
    }

    function restoreFollowingDrag() {
        const active = followingDrag;
        followingDrag = null;
        if (!active) return;
        if (active.link.getAttribute("draggable") === "true")
            restoreOriginalAttribute(active.link, "draggable", active.draggable);
        if (active.link.style.getPropertyValue("-webkit-user-drag") === "element") {
            if (active.style) active.link.style.setProperty("-webkit-user-drag", active.style, active.priority);
            else active.link.style.removeProperty("-webkit-user-drag");
        }
        if (!active.hadStyle && !active.link.style.length) active.link.removeAttribute("style");
    }

    function prepareFollowingDrag(event) {
        if (event.button !== 0 || event.isPrimary === false || event.altKey) return;
        restoreFollowingDrag();
        const link = followingDragLink(event.target);
        if (!link) return;
        // Native channel anchors currently set draggable=false (2026-09-06).
        // Prepare before the browser's mousedown default action; keep ordinary link navigation.
        followingDrag = {
            link,
            href: link.href,
            pointerId: event.pointerId,
            hadStyle: link.hasAttribute("style"),
            draggable: link.getAttribute("draggable"),
            style: link.style.getPropertyValue("-webkit-user-drag"),
            priority: link.style.getPropertyPriority("-webkit-user-drag"),
            started: false,
        };
        link.draggable = true;
        link.style.setProperty("-webkit-user-drag", "element", "important");
    }

    function startFollowingDrag(event) {
        const link = followingDragLink(event.target);
        if (!link || !event.dataTransfer || event.defaultPrevented) return;
        if (followingDrag && (followingDrag.link !== link || followingDrag.href !== link.href)) {
            event.preventDefault();
            restoreFollowingDrag();
            return;
        }
        if (followingDrag) followingDrag.started = true;
        event.dataTransfer.setData("text/uri-list", link.href);
        event.dataTransfer.setData("text/plain", link.href);
        event.dataTransfer.effectAllowed = "copyLink";
    }

    function endFollowingPointer(event) {
        if (followingDrag && event.pointerId === followingDrag.pointerId && !followingDrag.started)
            restoreFollowingDrag();
    }

    function navigateSourceLink(event, meta) {
        const link = event.target.closest("a[href]");
        if (
            !meta.row.hasAttribute(SOURCE_ROW_ATTR) ||
            !(link instanceof HTMLAnchorElement) ||
            !meta.row.contains(link) ||
            (link.target && link.target !== "_self") ||
            link.hasAttribute("download")
        ) {
            return;
        }
        const handled = !link.dispatchEvent(
            new CustomEvent("betterchzzk:following-navigate", { bubbles: true, cancelable: true })
        );
        if (!handled) return;
        event.preventDefault();
        event.stopPropagation();
    }

    function handleClick(event) {
        const button = event.target instanceof Element ? event.target.closest(`[${MODE_BUTTON_ATTR}]`) : null;
        if (button instanceof HTMLButtonElement) {
            event.preventDefault();
            event.stopPropagation();
            setPinMode(!pinModeEnabled);
            return;
        }
        const refreshButton = event.target instanceof Element ? event.target.closest(REFRESH_BUTTON_SELECTOR) : null;
        if (
            refreshButton instanceof HTMLElement &&
            refreshButton.id !== MODE_BUTTON_ID &&
            REFRESH_LABEL_RE.test(normSpace(refreshButton.getAttribute("aria-label")))
        ) {
            const following = findFollowingList(getSidebar());
            if (following?.section.contains(refreshButton)) invalidateSourceSnapshot();
        }
        if (event.defaultPrevented || event.button !== 0 || hasNavigationModifier(event)) return;
        const meta = getPinTargetMeta(event.target);
        if (!meta) return;
        if (!pinModeEnabled) {
            navigateSourceLink(event, meta);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        togglePinned(meta.channelId);
    }

    function handleKeyDown(event) {
        if (
            !pinModeEnabled ||
            event.repeat ||
            hasNavigationModifier(event) ||
            (event.key !== " " && event.key !== "Spacebar")
        ) {
            return;
        }
        const meta = getPinTargetMeta(event.target);
        if (!meta) return;
        event.preventDefault();
        event.stopPropagation();
        togglePinned(meta.channelId);
    }

    function handlePinnedStorageChange(changes, areaName) {
        if (areaName !== "sync" || !Object.hasOwn(changes || {}, STORAGE_KEY)) return;
        setPinnedIds(changes[STORAGE_KEY]?.newValue, { persisted: true });
    }

    function installRuntime() {
        if (runtimeInstalled) {
            scheduleSync();
            return;
        }
        runtimeInstalled = true;
        const generation = ++runtimeGeneration;
        ensureStyle();
        document.addEventListener("click", handleClick, true);
        document.addEventListener("keydown", handleKeyDown, true);
        removeStorageChangeListener = startStorageChangeListener(handlePinnedStorageChange);
        domObserver = createMutationObserverSync({
            target: getSidebar,
            options: {
                childList: true,
                subtree: true,
                characterData: true,
                attributes: true,
                attributeFilter: ["href", "class", "aria-expanded"],
            },
            schedule: scheduleSync,
            onObserved: scheduleSync,
            onBodyReady: scheduleSync,
        });
        storageGet(storage, STORAGE_KEY)
            .then((data) => {
                if (!runtimeInstalled || generation !== runtimeGeneration) return;
                setPinnedIds(data?.[STORAGE_KEY], { persisted: true });
            })
            .catch((error) => {
                if (!runtimeInstalled || generation !== runtimeGeneration) return;
                console.warn("[Better Chzzk] 팔로잉 채널 고정 목록 로드 실패", error);
                scheduleSync();
            });
        scheduleSync();
    }

    function uninstallRuntime() {
        if (!runtimeInstalled) return;
        runtimeInstalled = false;
        runtimeGeneration += 1;
        if (syncFrame) window.cancelAnimationFrame(syncFrame);
        syncFrame = 0;
        domObserver?.disconnectAll?.();
        domObserver = null;
        removeStorageChangeListener?.();
        removeStorageChangeListener = null;
        document.removeEventListener("click", handleClick, true);
        document.removeEventListener("keydown", handleKeyDown, true);
        cleanupUi({ resetMode: true });
        resetSourceSnapshot();
    }

    function applyOptions(options) {
        featureOptions = options;
        applyCheeseFarmOption();
        applySectionOptions();
        if (featureOptions.followingPinEnabled) installRuntime();
        else uninstallRuntime();
        syncStyle();
    }

    // Link dragging is independent of pinning. Capture before document-level drag blockers.
    window.addEventListener("pointerdown", prepareFollowingDrag, true);
    window.addEventListener("pointerup", endFollowingPointer, true);
    window.addEventListener("pointercancel", endFollowingPointer, true);
    window.addEventListener("dragstart", startFollowingDrag, true);
    window.addEventListener("dragend", restoreFollowingDrag, true);
    window.addEventListener("pagehide", restoreFollowingDrag);
    window.addEventListener("blur", restoreFollowingDrag);
    startPageChangeDetection(restoreFollowingDrag);
    bindFeatureOptions(applyOptions);
})();
