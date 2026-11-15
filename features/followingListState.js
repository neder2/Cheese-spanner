/**
 * 팔로잉 목록 상태 기억. isolated world에서 네이티브 구역 접기와 더보기를 복원한다.
 * 2026-09-11 /: #sidebar nav[aria-label="팔로우"]의 두 aria-expanded 버튼을 실측했다.
 * 마지막 사용자 선택은 chrome.storage.local에 저장하며 열린 다른 탭에는 즉시 전파하지 않는다.
 */
(() => {
    const STORAGE_KEY = "betterchzzk:following-list-state";
    // 같은 origin의 탭이 함께 쓰는 잠금이에요. 저장 직전 읽기와 쓰기 사이에 다른 탭의 저장이 끼지 않아요.
    const STORAGE_LOCK = "cheese-spanner:following-list-state";
    const SECTION_SELECTOR = '#sidebar nav[aria-label="팔로우"]';
    const CONTROL_LABELS = {
        section: new Set(["펼쳐짐, 접기", "접힘, 펼치기"]),
        list: new Set(["더보기", "접기"]),
    };
    // 원본 `더보기`는 누를 때마다 50개씩 늘고 모두 보일 때만 `접기`가 돼요(2026-10-13 공개 번들). 같은 버튼을
    // 다시 눌러야 하므로 행 수가 바뀔 때마다 한 번씩 누르되, 반응 없는 버튼을 계속 누르지 않게 횟수를 묶어요.
    const SUPPLEMENT_ROW_SELECTOR = "[data-bcsf-source-row]";
    const RESTORE_CLICK_LIMIT = 12;
    const RESTORE_CLICK_WINDOW_MS = 5000;
    const { bindFeatureOptions, createMutationObserverSync, startPageChangeDetection, storageGet, storageSet } =
        CheeseSpanner.utils;
    const storage = globalThis.chrome?.storage?.local;
    let enabled = false;
    let generation = 0;
    let loaded = false;
    let preference = {};
    let userChoices = {};
    let currentSection = null;
    let pendingClicks = {};
    let attempts = {};
    let restoreClicks = {};
    let restoreTimer = 0;
    let restoring = false;
    let frame = 0;
    let observer = null;
    let removeRouteListener = null;
    let writeQueue = Promise.resolve();

    function normalizeState(value) {
        const state = {};
        for (const kind of Object.keys(CONTROL_LABELS)) {
            if (typeof value?.[kind] === "boolean") state[kind] = value[kind];
        }
        return state;
    }

    function getSection() {
        return document.querySelector(SECTION_SELECTOR);
    }

    function getControls(section) {
        const controls = {};
        for (const button of section?.querySelectorAll("button[aria-expanded]") || []) {
            if (button.closest(SECTION_SELECTOR) !== section) continue;
            const label = button.getAttribute("aria-label");
            for (const [kind, labels] of Object.entries(CONTROL_LABELS)) {
                if (labels.has(label)) controls[kind] = button;
            }
        }
        return controls;
    }

    function expanded(button) {
        const value = button?.getAttribute("aria-expanded");
        return value === "true" ? true : value === "false" ? false : null;
    }

    function withStorageLock(work) {
        const locks = globalThis.navigator?.locks;
        if (typeof locks?.request === "function") return locks.request(STORAGE_LOCK, work);
        // Web Locks가 없으면 이 탭 안의 쓰기 큐만으로 순서를 지켜요.
        return Promise.resolve().then(work);
    }

    // 이번에 사용자가 바꾼 항목만 저장 직전의 최신 값에 합쳐 써요. 다른 탭이 그사이 저장한 다른 항목을
    // 이 탭이 시작할 때 읽은 값으로 되돌리지 않아요. 이 탭의 화면 복원 기준(preference)은 바꾸지 않아요.
    // 최신 값을 읽지 못하면 다른 항목을 알 수 없으므로 쓰지 않아요.
    function savePreference(changes) {
        if (!loaded) return;
        const own = { ...changes };
        writeQueue = writeQueue
            .then(() =>
                withStorageLock(() =>
                    storageGet(storage, STORAGE_KEY).then((data) =>
                        storageSet(storage, { [STORAGE_KEY]: { ...normalizeState(data?.[STORAGE_KEY]), ...own } })
                    )
                )
            )
            .catch((error) => console.warn("[Cheese Spanner] 팔로잉 목록 상태 저장 실패", error));
    }

    function countRows(button) {
        const section = button.closest(SECTION_SELECTOR);
        if (!section) return 0;
        let rows = 0;
        for (const link of section.querySelectorAll("a[href]")) if (!link.closest(SUPPLEMENT_ROW_SELECTOR)) rows += 1;
        return rows;
    }

    function clearRestoreTimer() {
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = 0;
    }

    // 횟수 제한에 걸린 복원은 제한이 풀리는 때에 다시 확인해요. 그사이 목록이 바뀌지 않아도 멈추지 않아요.
    function scheduleRestoreRetry(delay) {
        if (restoreTimer) return;
        restoreTimer = setTimeout(
            () => {
                restoreTimer = 0;
                scheduleSync();
            },
            Math.max(0, delay) + 1
        );
    }

    function scheduleSync() {
        if (!enabled || frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            syncState();
        });
    }

    function restoreControl(kind, button) {
        const desired = preference[kind];
        const actual = expanded(button);
        if (!button?.isConnected || actual === null || typeof desired !== "boolean" || pendingClicks[kind]) return;
        if (actual === desired) {
            delete attempts[kind];
            return;
        }
        if (button.disabled || button.getAttribute("aria-disabled") === "true") return;
        // 구역 버튼은 한 번이면 끝나므로 행 수로 다시 누르는 것은 목록 버튼만이에요.
        const rows = kind === "list" ? countRows(button) : 0;
        const attempt = attempts[kind];
        if (
            attempt?.button === button &&
            attempt.desired === desired &&
            attempt.before === actual &&
            attempt.rows === rows
        )
            return;
        const now = Date.now();
        const recent = (restoreClicks[kind] || []).filter((time) => now - time < RESTORE_CLICK_WINDOW_MS);
        restoreClicks[kind] = recent;
        if (recent.length >= RESTORE_CLICK_LIMIT) {
            scheduleRestoreRetry(recent[0] + RESTORE_CLICK_WINDOW_MS - now);
            return;
        }
        recent.push(now);
        attempts[kind] = { button, desired, before: actual, rows };
        restoring = true;
        try {
            button.click();
        } finally {
            restoring = false;
        }
    }

    function syncState() {
        if (!enabled) return;
        const section = getSection();
        if (section !== currentSection) {
            currentSection = section;
            pendingClicks = {};
            attempts = {};
            clearRestoreTimer();
        }
        if (!section) return;
        const controls = getControls(section);
        const changes = {};
        for (const [kind, pending] of Object.entries(pendingClicks)) {
            const actual = expanded(controls[kind]);
            if (actual === null || actual === pending.before) continue;
            preference[kind] = actual;
            userChoices[kind] = actual;
            changes[kind] = actual;
            delete pendingClicks[kind];
            delete attempts[kind];
        }
        if (Object.keys(changes).length) savePreference(changes);
        if (!loaded) return;
        restoreControl("section", controls.section);
        // Closing the section removes its list and button. Re-read after the native click.
        const current = getControls(getSection());
        if (expanded(current.section) === true) restoreControl("list", current.list);
    }

    function handleClick(event) {
        if (!enabled || restoring || event.defaultPrevented) return;
        const section = getSection();
        const button = event.target instanceof Element ? event.target.closest("button[aria-expanded]") : null;
        if (!button || !section?.contains(button) || button.disabled || button.getAttribute("aria-disabled") === "true")
            return;
        const controls = getControls(section);
        const kind = Object.keys(controls).find((name) => controls[name] === button);
        const before = expanded(button);
        if (!kind || before === null) return;
        if (section !== currentSection) {
            currentSection = section;
            pendingClicks = {};
            attempts = {};
        }
        pendingClicks[kind] = { before };
        delete attempts[kind];
        delete restoreClicks[kind];
        scheduleSync();
    }

    function resetPage() {
        currentSection = null;
        pendingClicks = {};
        attempts = {};
        clearRestoreTimer();
        scheduleSync();
    }

    function start() {
        const token = ++generation;
        loaded = false;
        preference = {};
        userChoices = {};
        restoreClicks = {};
        document.addEventListener("click", handleClick, true);
        removeRouteListener = startPageChangeDetection(resetPage);
        observer = createMutationObserverSync({
            target: () => document.getElementById("sidebar"),
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["aria-expanded", "aria-label", "disabled", "aria-disabled"],
            },
            schedule: scheduleSync,
            onObserved: scheduleSync,
            onBodyReady: scheduleSync,
        });
        storageGet(storage, STORAGE_KEY)
            .then((data) => {
                if (!enabled || token !== generation) return;
                preference = { ...normalizeState(data[STORAGE_KEY]), ...userChoices };
                loaded = true;
                if (Object.keys(userChoices).length) savePreference(userChoices);
                scheduleSync();
            })
            .catch((error) => {
                if (!enabled || token !== generation) return;
                loaded = true;
                console.warn("[Cheese Spanner] 팔로잉 목록 상태 읽기 실패", error);
                if (Object.keys(userChoices).length) savePreference(userChoices);
                scheduleSync();
            });
        scheduleSync();
    }

    function stop() {
        generation += 1;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        clearRestoreTimer();
        observer?.disconnectAll?.();
        observer = null;
        removeRouteListener?.();
        removeRouteListener = null;
        document.removeEventListener("click", handleClick, true);
        currentSection = null;
        pendingClicks = {};
        attempts = {};
    }

    bindFeatureOptions((options) => {
        const next = options.followingListStateEnabled === true;
        if (enabled === next) return;
        enabled = next;
        if (enabled) start();
        else stop();
    });
})();
