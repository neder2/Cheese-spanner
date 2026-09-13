/**
 * 팔로잉 목록 상태 기억. isolated world에서 네이티브 구역 접기와 더보기를 복원한다.
 * 2026-09-11 /: #sidebar nav[aria-label="팔로우"]의 두 aria-expanded 버튼을 실측했다.
 * 마지막 사용자 선택은 chrome.storage.local에 저장하며 열린 다른 탭에는 즉시 전파하지 않는다.
 */
(() => {
    const STORAGE_KEY = "betterchzzk:following-list-state";
    const SECTION_SELECTOR = '#sidebar nav[aria-label="팔로우"]';
    const CONTROL_LABELS = {
        section: new Set(["펼쳐짐, 접기", "접힘, 펼치기"]),
        list: new Set(["더보기", "접기"]),
    };
    const { bindFeatureOptions, createMutationObserverSync, startPageChangeDetection, storageGet, storageSet } =
        BetterChzzk.utils;
    const storage = globalThis.chrome?.storage?.local;
    let enabled = false;
    let generation = 0;
    let loaded = false;
    let preference = {};
    let userChoices = {};
    let currentSection = null;
    let pendingClicks = {};
    let attempts = {};
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

    function savePreference() {
        if (!loaded) return;
        const state = { ...preference };
        writeQueue = writeQueue
            .then(() => storageSet(storage, { [STORAGE_KEY]: state }))
            .catch((error) => console.warn("[Better Chzzk] 팔로잉 목록 상태 저장 실패", error));
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
        const attempt = attempts[kind];
        if (attempt?.button === button && attempt.desired === desired && attempt.before === actual) return;
        attempts[kind] = { button, desired, before: actual };
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
        }
        if (!section) return;
        const controls = getControls(section);
        let changed = false;
        for (const [kind, pending] of Object.entries(pendingClicks)) {
            const actual = expanded(controls[kind]);
            if (actual === null || actual === pending.before) continue;
            preference[kind] = actual;
            userChoices[kind] = actual;
            delete pendingClicks[kind];
            delete attempts[kind];
            changed = true;
        }
        if (changed) savePreference();
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
        scheduleSync();
    }

    function resetPage() {
        currentSection = null;
        pendingClicks = {};
        attempts = {};
        scheduleSync();
    }

    function start() {
        const token = ++generation;
        loaded = false;
        preference = {};
        userChoices = {};
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
                if (Object.keys(userChoices).length) savePreference();
                scheduleSync();
            })
            .catch((error) => {
                if (!enabled || token !== generation) return;
                loaded = true;
                console.warn("[Better Chzzk] 팔로잉 목록 상태 읽기 실패", error);
                if (Object.keys(userChoices).length) savePreference();
                scheduleSync();
            });
        scheduleSync();
    }

    function stop() {
        generation += 1;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
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
