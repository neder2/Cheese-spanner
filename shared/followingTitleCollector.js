/**
 * shared/followingTitleCollector.js — 팔로우한 라이브 채널의 방송 제목을 1분마다 한 번의 목록 조회로 수집한다.
 *
 * 동작 위치: MV3 서비스 워커 전용(background.js importScripts). chrome.alarms가 없으면 아무것도 하지 않는다.
 * 하는 일: `followingTitleHistoryEnabled`가 켜져 있으면 알람 하나로 치지직 팔로잉 화면과 같은
 *   `/service/v1/channels/following-lives` 목록을 조회해 방송별 제목 이력에 병합한다. 채널이 몇 개든 요청은 한 번이다.
 *   열린 일반(비시크릿) 치지직 탭이 있으면 그 탭의 isolated world에서 기존 로그인 세션으로 읽고,
 *   탭이 없거나 탭에서 목록을 받지 못하면 같은 알람에서 워커가 직접 읽는다. 로그인이 필요하다는 응답이면 그 경로를 10분 동안 쉰다.
 *   워커는 알람 사이에 종료될 수 있어 쉬는 시각도 저장값(retryAt: 워커 경로, tabRetryAt: 탭 경로)에 둔다.
 * 저장: chrome.storage.local `betterchzzkFollowingLiveTitleHistory`의 유일한 writer다. 콘텐츠는 읽기만 한다.
 */
(() => {
    if (!globalThis.chrome?.alarms?.onAlarm) return;
    const model = globalThis.BetterChzzkFollowingTitleHistory;
    const { cleanEntryTitle, storageGet, storageSet, fetchJson } = BetterChzzk.utils;
    const { normalizeOptions } = BetterChzzkSettings;
    const OPTION_KEY = "followingTitleHistoryEnabled";
    const ALARM = "betterchzzk:following-title-history";
    const PERIOD_MINUTES = 1;
    const MIN_POLL_GAP_MS = 45 * 1000;
    const AUTH_RETRY_MS = 10 * 60 * 1000;
    const REQUEST_TIMEOUT_MS = 8000;
    const MAX_TAB_ATTEMPTS = 3;
    const LIST_URL = "https://api.chzzk.naver.com/service/v1/channels/following-lives?sortType=RECOMMEND";
    let queue = Promise.resolve();
    let generation = 0;
    let pollPending = false;

    function enqueue(task) {
        const pending = queue.then(task);
        queue = pending.catch((error) => console.warn("[Cheese Spanner] 팔로잉 방송 제목 수집 실패", error));
        return pending;
    }

    async function isEnabled() {
        const raw = await storageGet(chrome.storage.sync, [OPTION_KEY]);
        return normalizeOptions(raw)[OPTION_KEY] === true;
    }

    async function syncAlarm(enabled) {
        if (!enabled) {
            await chrome.alarms.clear(ALARM);
            return;
        }
        const alarm = await chrome.alarms.get(ALARM);
        if (!alarm || alarm.periodInMinutes !== PERIOD_MINUTES) {
            await chrome.alarms.create(ALARM, { delayInMinutes: PERIOD_MINUTES, periodInMinutes: PERIOD_MINUTES });
        }
    }

    // executeScript로 탭에 넣는 함수라 바깥 변수를 쓰지 않아요. 결과는 상태 코드와 JSON만 돌려줘요.
    async function readFollowingLivesInPage(url, timeoutMs) {
        if (location.origin !== "https://chzzk.naver.com") return { status: 0 };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(url, { credentials: "include", cache: "no-store", signal: controller.signal });
            if (!response.ok) return { status: response.status };
            return { status: response.status, json: await response.json() };
        } catch (_) {
            return { status: 0 };
        } finally {
            clearTimeout(timer);
        }
    }

    async function findChzzkTabs() {
        if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return [];
        const tabs = await chrome.tabs.query({ url: "https://chzzk.naver.com/*" });
        const usable = tabs.filter(
            (tab) => Number.isInteger(tab.id) && !tab.incognito && !tab.discarded && tab.status === "complete"
        );
        usable.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
        return usable.slice(0, MAX_TAB_ATTEMPTS);
    }

    function isAuthStatus(status) {
        return status === 401 || status === 403;
    }

    // 페이지 함수가 실행되지 않았으면(오류 화면·접근 불가 등) null이에요. 이때는 아직 요청을 보내지 않았어요.
    async function readViaTab(tab) {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            world: "ISOLATED",
            func: readFollowingLivesInPage,
            args: [LIST_URL, REQUEST_TIMEOUT_MS],
        });
        const result = results?.[0]?.result;
        if (!result || typeof result !== "object") return null;
        return { status: Number(result.status) || 0, json: result.json };
    }

    // 스크립트를 넣지 못한 탭은 다음 탭(최대 3개)으로 넘어가요. 페이지가 요청까지 보냈으면 그 결과로 끝내요.
    async function readViaTabs() {
        const tabs = await findChzzkTabs().catch(() => []);
        for (const tab of tabs) {
            const response = await readViaTab(tab).catch(() => null);
            if (response) return response;
        }
        return null;
    }

    async function readViaWorker() {
        try {
            return {
                status: 200,
                json: await fetchJson(LIST_URL, { timeoutMs: REQUEST_TIMEOUT_MS, cache: "no-store" }),
            };
        } catch (error) {
            const status = Number(String(error?.message || "").match(/^HTTP (\d{3})$/)?.[1]) || 0;
            return { status };
        }
    }

    async function poll(token, { force = false } = {}) {
        if (!(await isEnabled()) || token !== generation) return;
        const data = await storageGet(chrome.storage.local, model.STORAGE_KEY);
        if (token !== generation) return;
        const saved = model.normalizeStore(data[model.STORAGE_KEY]);
        const now = Date.now();
        // 시계가 앞서 있던 때 저장한 대기 시각이 며칠씩 막지 않게 지금부터 10분까지로 줄여 읽고, 줄였으면 저장해요.
        const store = {
            ...saved,
            retryAt: Math.min(saved.retryAt, now + AUTH_RETRY_MS),
            tabRetryAt: Math.min(saved.tabRetryAt, now + AUTH_RETRY_MS),
        };
        if (!force && store.polledAt && now >= store.polledAt && now - store.polledAt < MIN_POLL_GAP_MS) return;

        // 이번 실행에서 로그인이 필요하다고 확인한 경로의 대기 시각이에요.
        const paused = {};
        let response = store.tabRetryAt > now ? null : await readViaTabs();
        if (token !== generation) return;
        if (response && isAuthStatus(response.status)) paused.tabRetryAt = now + AUTH_RETRY_MS;
        // 탭에서 목록을 받지 못하면(탭 없음·스크립트 실패·네트워크 오류·5xx·로그인 필요) 같은 실행에서 워커 경로를 써요.
        if (response?.status !== 200 && (force || store.retryAt <= now)) {
            response = await readViaWorker();
            if (token !== generation) return;
            if (isAuthStatus(response.status)) paused.retryAt = now + AUTH_RETRY_MS;
        }
        const pausedNow = Object.keys(paused).length > 0;

        const items = response?.status === 200 ? model.parseFollowingLives(response.json) : null;
        if (!items) {
            const clamped = store.retryAt !== saved.retryAt || store.tabRetryAt !== saved.tabRetryAt;
            if (clamped || pausedNow) {
                await storageSet(chrome.storage.local, { [model.STORAGE_KEY]: { ...store, ...paused } });
            }
            return;
        }
        const { store: next } = model.applyPoll(store, items, Date.now(), { legacyTitle: cleanEntryTitle });
        if (token !== generation) return;
        // 라이브가 하나도 없고 지우거나 새로 둘 대기 시각도 없으면 쓰지 않아요. 라이브 중이면 마지막 확인 시각을 갱신해요.
        if (!items.length && !saved.retryAt && !saved.tabRetryAt && !pausedNow) return;
        await storageSet(chrome.storage.local, { [model.STORAGE_KEY]: { ...next, ...paused } });
    }

    function refresh({ pollNow = false } = {}) {
        generation += 1;
        const token = generation;
        void enqueue(async () => {
            const enabled = await isEnabled();
            if (token !== generation) return;
            await syncAlarm(enabled);
            if (enabled && pollNow && token === generation) await poll(token, { force: true });
        }).catch(() => {});
    }

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== ALARM || pollPending) return;
        pollPending = true;
        const token = generation;
        void enqueue(() => poll(token))
            .finally(() => {
                pollPending = false;
            })
            .catch(() => {});
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
        if (area !== "sync" || !Object.hasOwn(changes, OPTION_KEY)) return;
        refresh({ pollNow: changes[OPTION_KEY].newValue === true });
    });
    chrome.runtime.onStartup?.addListener(() => refresh({ pollNow: true }));
    chrome.runtime.onInstalled?.addListener(() => refresh({ pollNow: true }));
    refresh();
})();
