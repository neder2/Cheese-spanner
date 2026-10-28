/**
 * shared/followingTitleHistory.js — 팔로우한 라이브 채널의 방송별 제목 이력 저장값과 목록 조회 병합을 계산한다.
 *
 * 동작 위치: DOM·chrome 비의존 IIFE. 서비스 워커(수집·저장)와 isolated 콘텐츠(팔로잉 화면 표시)에서 각각 로드한다.
 * 하는 일: chrome.storage.local `betterchzzkFollowingLiveTitleHistory`를 상한과 함께 정규화하고,
 *   `/service/v1/channels/following-lives` 응답을 채널·라이브 ID·제목 목록으로 바꾼 뒤 조회 시각의 목록을
 *   방송별 제목 이력에 병합한다. 제목은 공백만 정리한 원문으로 비교해 한 글자·기호 변경도 새 제목으로 남긴다.
 *   같은 채널의 다른 라이브 ID는 새 방송으로 보고 이전 방송의 제목을 이어 붙이지 않는다.
 * 노출: globalThis.CheeseSpannerFollowingTitleHistory.
 */
(() => {
    "use strict";

    const STORAGE_KEY = "betterchzzkFollowingLiveTitleHistory";
    const VERSION = 1;
    const MAX_ENTRIES = 100;
    const MAX_TITLES_PER_LIVE = 50;
    const MAX_TITLE_LENGTH = 300;
    const MAX_CHANNEL_NAME_LENGTH = 100;
    const MAX_LIST_ITEMS = 500;
    const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

    function normalizeId(value) {
        const id = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
        return typeof id === "string" && ID_PATTERN.test(id.trim()) ? id.trim() : "";
    }

    // 공백만 정리해요. 치지직 접미사·채널명 접두사를 자르는 시청 기록용 정리는 실제 제목 변경을 지울 수 있어 쓰지 않아요.
    function normalizeTitle(value) {
        if (typeof value !== "string") return "";
        return value.normalize("NFC").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_LENGTH);
    }

    function normalizeChannelName(value) {
        return normalizeTitle(value).slice(0, MAX_CHANNEL_NAME_LENGTH);
    }

    function toTime(value) {
        const time = Number(value);
        return Number.isFinite(time) && time > 0 ? Math.floor(time) : 0;
    }

    function normalizeRows(value) {
        const rows = [];
        for (const row of Array.isArray(value) ? value.slice(-MAX_TITLES_PER_LIVE * 2) : []) {
            if (!row || typeof row !== "object") continue;
            const title = normalizeTitle(row.title);
            const firstSeenAt = toTime(row.firstSeenAt) || toTime(row.lastSeenAt);
            const lastSeenAt = Math.max(toTime(row.lastSeenAt), firstSeenAt);
            if (!title || !firstSeenAt) continue;
            rows.push({ title, firstSeenAt, lastSeenAt });
        }
        return rows.sort((a, b) => a.firstSeenAt - b.firstSeenAt).slice(-MAX_TITLES_PER_LIVE);
    }

    function normalizeEntry(raw) {
        if (!raw || typeof raw !== "object") return null;
        const channelId = normalizeId(raw.channelId);
        const liveId = normalizeId(raw.liveId);
        const titleHistory = normalizeRows(raw.titleHistory);
        if (!channelId || !liveId || !titleHistory.length) return null;
        return {
            channelId,
            liveId,
            channelName: normalizeChannelName(raw.channelName),
            titleHistory,
            updatedAt: toTime(raw.updatedAt) || titleHistory[titleHistory.length - 1].lastSeenAt,
        };
    }

    function normalizeStore(raw) {
        const source = raw && typeof raw === "object" ? raw : {};
        const rows = Array.isArray(source.entries)
            ? source.entries
            : source.entries && typeof source.entries === "object"
              ? Object.values(source.entries)
              : [];
        const byChannel = new Map();
        for (const row of rows.slice(-MAX_ENTRIES * 2)) {
            const entry = normalizeEntry(row);
            if (!entry) continue;
            const existing = byChannel.get(entry.channelId);
            if (!existing || existing.updatedAt <= entry.updatedAt) byChannel.set(entry.channelId, entry);
        }
        return {
            version: VERSION,
            polledAt: toTime(source.polledAt),
            retryAt: toTime(source.retryAt),
            tabRetryAt: toTime(source.tabRetryAt),
            entries: Array.from(byChannel.values())
                .sort((a, b) => a.updatedAt - b.updatedAt)
                .slice(-MAX_ENTRIES),
        };
    }

    // 응답 형식이 다르면 null을 돌려 실패로 다뤄요. 라이브 ID나 제목이 없는 항목은 만들어 내지 않고 건너뛰어요.
    function parseFollowingLives(json) {
        if (!json || typeof json !== "object" || json.code !== 200) return null;
        const list = json.content?.followingList;
        if (!Array.isArray(list)) return null;
        const byChannel = new Map();
        for (const item of list.slice(0, MAX_LIST_ITEMS)) {
            const channelId = normalizeId(item?.channel?.channelId ?? item?.channelId);
            const liveId = normalizeId(item?.liveInfo?.liveId);
            const title = normalizeTitle(item?.liveInfo?.liveTitle);
            if (!channelId || !liveId || !title) continue;
            byChannel.set(channelId, {
                channelId,
                liveId,
                title,
                channelName: normalizeChannelName(item?.channel?.channelName),
            });
        }
        return Array.from(byChannel.values());
    }

    function cloneEntry(entry) {
        return { ...entry, titleHistory: entry.titleHistory.map((row) => ({ ...row })) };
    }

    // 1.4.3까지 팔로잉 화면은 채널명 접두사·치지직 접미사를 자른 제목을 저장했어요. 수집기가 아직 한 번도 쓰지 않은
    // 저장값에서 같은 방송의 줄이 지금 원문 제목을 그렇게 자른 값이면 같은 제목이므로 원문으로 바꿔 가짜 이전 방제를 막아요.
    function adoptLegacyTitle(entry, item, legacyTitle) {
        const cleaned = normalizeTitle(legacyTitle(item.title, item.channelName || entry.channelName));
        if (!cleaned || cleaned === item.title) return;
        for (const row of entry.titleHistory) {
            if (row.title === cleaned) row.title = item.title;
        }
    }

    // 같은 방송에서 제목이 A→B→A로 돌아오면 마지막 A를 새 줄로 남겨 바뀐 순서를 보존해요.
    // legacyTitle은 1.4.3 저장값을 읽을 때만 쓰는 제목 정리 함수예요(워커가 CheeseSpanner.utils.cleanEntryTitle을 넘겨요).
    function applyPoll(rawStore, items, now, { legacyTitle } = {}) {
        const at = toTime(now);
        const store = normalizeStore(rawStore);
        const entries = new Map(store.entries.map((entry) => [entry.channelId, cloneEntry(entry)]));
        const added = [];
        const fromLegacyStore = !store.polledAt && typeof legacyTitle === "function";
        let titlesChanged = false;

        for (const item of Array.isArray(items) ? items : []) {
            const previous = entries.get(item.channelId);
            if (!previous || previous.liveId !== item.liveId) {
                entries.delete(item.channelId);
                added.push({
                    channelId: item.channelId,
                    liveId: item.liveId,
                    channelName: item.channelName,
                    titleHistory: [{ title: item.title, firstSeenAt: at, lastSeenAt: at }],
                    updatedAt: at,
                });
                titlesChanged = true;
                continue;
            }
            if (fromLegacyStore) adoptLegacyTitle(previous, item, legacyTitle);
            const last = previous.titleHistory[previous.titleHistory.length - 1];
            if (last.title === item.title) {
                last.lastSeenAt = Math.max(last.lastSeenAt, at);
            } else {
                previous.titleHistory.push({ title: item.title, firstSeenAt: at, lastSeenAt: at });
                previous.titleHistory = previous.titleHistory.slice(-MAX_TITLES_PER_LIVE);
                titlesChanged = true;
            }
            if (item.channelName) previous.channelName = item.channelName;
            previous.updatedAt = at;
        }

        // 상한을 넘으면 가장 오래 확인되지 않은 방송부터 밀어내요. 같은 조회에서 처음 본 방송은 이미 모으던 방송보다
        // 먼저 밀려나 목록 순서가 바뀌어도 모으던 이력이 끊기지 않고, 처음 본 방송끼리는 목록 위쪽부터 남겨요.
        const kept = [...entries.values(), ...added]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_ENTRIES)
            .sort((a, b) => a.updatedAt - b.updatedAt);

        return {
            titlesChanged,
            store: {
                version: VERSION,
                polledAt: at,
                retryAt: 0,
                tabRetryAt: 0,
                entries: kept,
            },
        };
    }

    // 현재 카드 제목과 같은 줄을 뺀 나머지가 이전 방제예요. 다시보기의 이전 방제 목록과 같은 기준이에요.
    function getPreviousRows(entry, currentTitle) {
        const current = normalizeTitle(currentTitle);
        return (entry?.titleHistory || []).filter((row) => row.title !== current);
    }

    globalThis.CheeseSpannerFollowingTitleHistory = Object.freeze({
        STORAGE_KEY,
        VERSION,
        MAX_ENTRIES,
        MAX_TITLES_PER_LIVE,
        normalizeId,
        normalizeTitle,
        normalizeStore,
        parseFollowingLives,
        applyPoll,
        getPreviousRows,
    });
})();
