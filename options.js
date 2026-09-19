/**
 * options.js — options.html(설정 페이지)의 스크립트로, 모든 기능 토글/수치를 폼으로 보여주고 저장한다.
 *
 * 실행 컨텍스트: manifest의 action.default_popup이자 options_page인 options.html에서 로드된다.
 * 확장 아이콘을 클릭하면 작은 팝업 창으로 여는 것이 1차 사용 환경이라, UI는 좁은 뷰포트를 기준으로
 * 짜여 있다(전체 탭으로 여는 것은 부차적 경로). options.html은 shared/settings.js를 같은 페이지에
 * script 태그로 먼저 로드하고 그다음 이 파일을 로드한다. content script가 아니다.
 * 하는 일: chrome.storage.sync에서 옵션을 불러와 폼에 채우고, 저장 버튼을 누르면 현재 값을 저장한다.
 * 옵션 간 의존 관계(data-depends-on)에 따라 하위 컨트롤을 비활성화하고, 탭 전환과
 * 설정 검색(검색어로 카드 항목 필터링), 기본값 복원 버튼을 처리한다.
 * 의존: BetterChzzkSettings(shared/settings.js가 노출하는 DEFAULT_OPTIONS, OPTION_KEYS,
 * normalizeOptions), globalThis.chrome.storage.sync, globalThis.chrome.permissions,
 * window.localStorage.
 * 통신: chrome.storage.sync에 각 data-option 키를 읽고 쓴다(다른 파일들이 같은 키를 구독해 기능을
 * 켜고 끔). followingPreviewTooltipEnabled를 켤 때만 optional_host_permissions로 선언된
 * PREVIEW_HOST_PERMISSION(https://*.pstatic.net/*)을 chrome.permissions.request로 요청한다.
 * 마지막으로 본 탭 인덱스는 window.localStorage 키 "betterChzzkOptionsLastTab"에 저장한다.
 * 옵션 묶음의 펼침/접힘 선택은 chrome.storage.local에 묶음 ID별로 자동 저장한다.
 */
const form = document.getElementById("optionsForm");
const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
const dependencyGroups = Array.from(document.querySelectorAll("[data-depends-on]"));
const resetButton = document.getElementById("reset");
const shortcutResetButton = document.getElementById("resetPlaybackSpeedShortcuts");
const playbackSpeedShortcutInputs = optionInputs.filter(isShortcutCodeInput);
const saveButton = document.getElementById("save");
const discardButton = document.getElementById("discardChanges");
const headerMenu = document.getElementById("headerMenu");
const noticeEl = document.getElementById("notice");
const messageEl = document.getElementById("message");

const {
    DEFAULT_OPTIONS,
    OPTION_KEYS,
    STORAGE_OPTION_KEYS,
    getPlaybackSpeedShortcutLabel,
    isPlaybackSpeedShortcutCode,
    normalizeOptions,
    migrateLegacyChatToolsOption,
} = BetterChzzkSettings;

const storage = globalThis.chrome?.storage?.sync;
const OPTIONS_LOAD_ERROR_MESSAGE = "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
const OPTIONS_LOAD_BLOCKED_SAVE_MESSAGE =
    "설정을 불러오지 못해 저장하지 않았습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
const OPTIONS_SAVE_ERROR_MESSAGE = "설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const NOTICE_STATE_LABELS = {
    loading: "불러오는 중",
    dirty: "변경됨",
    saving: "저장 중",
    saved: "저장됨",
    error: "저장 실패",
};

// 팔로잉 미리보기 영상(HLS)은 pstatic.net에서 내려오므로 선택 권한으로 두고,
// 기능을 켜는 순간에만 요청한다. 이미 허용된 상태의 request는 팝업 없이 승인된다.
const PREVIEW_HOST_PERMISSION = { origins: ["https://*.pstatic.net/*"] };
const PREVIEW_PERMISSION_DENIED_MESSAGE = "권한이 거부되어 팔로잉 미리보기를 켜지 않았습니다.";
const SHORTCUT_KEY_UNAVAILABLE_MESSAGE = "이 키는 기존 재생 조작과 겹쳐 지정할 수 없습니다.";
const SHORTCUT_KEY_DUPLICATE_MESSAGE = "배속 감소·증가·초기화는 서로 다른 키로 지정해 주세요.";

let hideMessageTimer = 0;
let savedOptions = null;
let saveInFlight = false;
let optionsLoadState = storage ? "loading" : "ready";

function isShortcutCodeInput(input) {
    return input?.hasAttribute?.("data-shortcut-code") === true;
}

function setInputValue(input, value) {
    if (input.type === "checkbox") {
        input.checked = Boolean(value);
        return;
    }
    if (isShortcutCodeInput(input)) {
        input.dataset.shortcutCode = String(value);
        input.value = getPlaybackSpeedShortcutLabel(value);
        return;
    }
    input.value = String(value);
}

function getInputValue(input) {
    if (input.type === "checkbox") return input.checked;
    if (isShortcutCodeInput(input)) return input.dataset.shortcutCode || "";
    return input.value;
}

function readOptionsFromForm() {
    const raw = {};

    for (const input of optionInputs) {
        const key = input.dataset.option;
        // 입력 중 잠깐 비워진 숫자 칸은 기본값 대신 마지막 저장값을 유지한다.
        if (input.type !== "checkbox" && String(input.value).trim() === "" && savedOptions) {
            raw[key] = savedOptions[key];
            continue;
        }
        raw[key] = getInputValue(input);
    }

    return normalizeOptions(raw);
}

function areOptionsEqual(a, b) {
    if (!a || !b) return false;
    return OPTION_KEYS.every((key) => a[key] === b[key]);
}

function countChangedOptions(options) {
    return savedOptions ? OPTION_KEYS.filter((key) => options[key] !== savedOptions[key]).length : 0;
}

function dependenciesMet(group, options) {
    const keys = String(group.dataset.dependsOn || "")
        .split(/\s+/)
        .filter(Boolean);
    return keys.every((key) => Boolean(options[key]));
}

function setGroupDisabled(group, disabled) {
    group.classList.toggle("is-disabled", disabled);
    group.setAttribute("aria-disabled", disabled ? "true" : "false");
}

function applyDependencies(options) {
    for (const group of dependencyGroups) {
        setGroupDisabled(group, !dependenciesMet(group, options));
    }
}

function isDisabledByDependency(control, options) {
    return dependencyGroups.some((group) => group.contains(control) && !dependenciesMet(group, options));
}

function applyControlStates(options) {
    const optionsUnavailable = optionsLoadState !== "ready";
    for (const control of optionInputs) {
        control.disabled = optionsUnavailable || isDisabledByDependency(control, options);
    }
    resetButton.disabled = optionsUnavailable || saveInFlight;
    shortcutResetButton.disabled =
        optionsUnavailable || saveInFlight || isDisabledByDependency(shortcutResetButton, options);
    saveButton.disabled = optionsUnavailable || saveInFlight || !savedOptions || areOptionsEqual(options, savedOptions);
    discardButton.disabled = optionsUnavailable || saveInFlight || countChangedOptions(options) === 0;
}

function renderNotice(state, changedCount = 0) {
    const label = NOTICE_STATE_LABELS[state] || NOTICE_STATE_LABELS.saved;
    noticeEl.dataset.state = state;
    noticeEl.textContent = state === "dirty" ? `변경 ${changedCount}개` : label;
}

function renderPageState(options, state = "saved") {
    if (options.optionsTheme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = options.optionsTheme;
    const themes = {
        system: { label: "시스템 설정", next: "화이트", icon: "M4 4h16v12H4z M8 20h8 M12 16v4" },
        light: {
            label: "화이트",
            next: "다크",
            icon: "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5",
        },
        dark: { label: "다크", next: "시스템 설정", icon: "M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" },
    };
    const theme = themes[options.optionsTheme];
    const themeButton = document.getElementById("optionsTheme");
    const themeLabel = `화면 테마: ${theme.label}. 누르면 ${theme.next}`;
    themeButton.setAttribute("aria-label", themeLabel);
    themeButton.title = themeLabel;
    document.getElementById("optionsThemeIcon").setAttribute("d", theme.icon);
    applyDependencies(options);
    applyControlStates(options);
    renderNotice(state, countChangedOptions(options));
}

function renderOptions(options, { state = "saved" } = {}) {
    const normalized = normalizeOptions(options);
    for (const input of optionInputs) {
        setInputValue(input, normalized[input.dataset.option]);
    }
    renderPageState(normalized, state);
    return normalized;
}

function syncNumberInputs(options) {
    for (const input of optionInputs) {
        if (input.type === "checkbox") continue;
        setInputValue(input, options[input.dataset.option]);
    }
}

function hideMessage() {
    clearTimeout(hideMessageTimer);
    hideMessageTimer = 0;
    const hadFocus = messageEl.contains(document.activeElement);
    messageEl.classList.remove("is-visible");
    messageEl.classList.add("hidden");
    if (hadFocus) (saveButton.disabled ? document.getElementById("settingsSearch") : saveButton)?.focus();
}

function showMessage(text, type = "success") {
    clearTimeout(hideMessageTimer);
    hideMessageTimer = 0;
    const hadFocus = messageEl.contains(document.activeElement);
    const copy = document.createElement("span");
    copy.className = "message-text";
    copy.textContent = text;
    messageEl.replaceChildren(copy);
    if (type === "error") {
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "message-close";
        dismiss.setAttribute("aria-label", "오류 안내 닫기");
        dismiss.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>';
        dismiss.addEventListener("click", hideMessage);
        messageEl.append(dismiss);
    }
    messageEl.dataset.type = type;
    messageEl.classList.remove("hidden");
    messageEl.classList.add("is-visible");
    if (hadFocus) {
        const fallback = saveButton.disabled ? document.getElementById("settingsSearch") : saveButton;
        (messageEl.querySelector(".message-close") || fallback)?.focus({ preventScroll: true });
    }

    if (type !== "error") hideMessageTimer = setTimeout(hideMessage, 1800);
}

function finishSave(normalized, message, error) {
    saveInFlight = false;
    if (error) {
        renderPageState(readOptionsFromForm(), "error");
        showMessage(OPTIONS_SAVE_ERROR_MESSAGE, "error");
        return;
    }

    savedOptions = normalized;
    hideMessage();
    const current = readOptionsFromForm();
    if (!areOptionsEqual(current, normalized)) {
        renderPageState(current, "dirty");
        return;
    }
    syncNumberInputs(normalized);
    renderPageState(normalized, "saved");
    if (message) showMessage(message);
}

function startSave(normalized, message) {
    if (optionsLoadState !== "ready") return;
    saveInFlight = true;
    renderPageState(normalized, "saving");
    if (!storage) {
        finishSave(normalized, message);
        return;
    }
    storage.set(normalized, () => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (error || savedOptions?.adVideoEnabled === normalized.adVideoEnabled) {
            finishSave(normalized, message, error);
            return;
        }
        const status = document.getElementById("adVideoStatus");
        function finishAdVideoSave(result) {
            if (status) {
                status.hidden = false;
                status.textContent =
                    result?.ok && result.enabled !== normalized.adVideoEnabled
                        ? "다른 곳에서 광고 설정이 변경됐습니다. 설정을 다시 열어 현재 값을 확인해 주세요."
                        : result?.ok
                          ? normalized.adVideoEnabled
                              ? "적용 준비가 끝났습니다. 치지직 탭을 새로고침해 주세요."
                              : "동영상 광고 차단을 껐습니다. 이미 반영된 상태는 새로고침하면 복원됩니다."
                          : "설정은 저장됐지만 적용 준비에 실패했습니다. 확장을 다시 로드한 뒤 설정을 확인해 주세요.";
            }
            finishSave(normalized, message);
        }
        if (!globalThis.chrome?.runtime?.sendMessage) {
            finishAdVideoSave({ ok: false });
            return;
        }
        try {
            chrome.runtime.sendMessage({ type: "betterchzzk:ad-video:sync" }, (result) => {
                const messageError = chrome.runtime.lastError;
                finishAdVideoSave(messageError ? null : result);
            });
        } catch (_) {
            finishAdVideoSave(null);
        }
    });
}

function commitSave(message) {
    if (optionsLoadState !== "ready") {
        if (optionsLoadState === "failed") {
            renderPageState(readOptionsFromForm(), "error");
            showMessage(OPTIONS_LOAD_BLOCKED_SAVE_MESSAGE, "error");
        }
        return;
    }

    const normalized = readOptionsFromForm();
    if (saveInFlight) return;

    if (savedOptions && areOptionsEqual(normalized, savedOptions)) {
        syncNumberInputs(normalized);
        renderPageState(normalized, "saved");
        if (message) showMessage(message);
        return;
    }

    startSave(normalized, message);
}

function requestOptionalPermissions(spec, callback) {
    const permissions = globalThis.chrome?.permissions;
    // 권한 API가 없는 환경(테스트, 구형 브라우저)에서는 기존처럼 그대로 저장한다.
    if (typeof permissions?.request !== "function") {
        callback(!spec.permissions?.includes("notifications"));
        return;
    }
    permissions.request(spec, (granted) => {
        // 사용자가 팝업에서 거부해도 lastError가 남을 수 있어 읽어서 경고를 지운다.
        const error = globalThis.chrome?.runtime?.lastError;
        callback(!error && Boolean(granted));
    });
}

function getOptionInput(target) {
    const input = target instanceof Element ? target.closest("[data-option]") : null;
    return input && optionInputs.includes(input) ? input : null;
}

function renderFormChanges() {
    const normalized = readOptionsFromForm();
    renderPageState(normalized, areOptionsEqual(normalized, savedOptions) ? "saved" : "dirty");
}

function saveCurrentOptions() {
    if (optionsLoadState !== "ready" || saveInFlight) return;

    const normalized = readOptionsFromForm();
    const newlyEnabledMedia = ["followingPreviewTooltipEnabled", "liveMultiviewEnabled"].filter(
        (key) => normalized[key] && !savedOptions?.[key]
    );
    const needsNotifications = normalized.liveStartNotificationsEnabled;
    if (newlyEnabledMedia.length || needsNotifications) {
        const permissionSpec = {
            ...(newlyEnabledMedia.length ? PREVIEW_HOST_PERMISSION : {}),
            ...(needsNotifications ? { permissions: ["notifications"] } : {}),
        };
        saveInFlight = true;
        renderPageState(normalized, "saving");
        requestOptionalPermissions(permissionSpec, (granted) => {
            if (!granted) {
                saveInFlight = false;
                for (const key of [
                    ...newlyEnabledMedia,
                    ...(needsNotifications ? ["liveStartNotificationsEnabled"] : []),
                ]) {
                    const toggle = optionInputs.find((input) => input.dataset.option === key);
                    if (toggle) toggle.checked = false;
                }
                renderFormChanges();
                showMessage(
                    needsNotifications
                        ? "권한이 거부되어 저장하지 않았어요. 데스크톱 알림을 끈 상태로 다른 옵션을 저장할 수 있어요."
                        : newlyEnabledMedia.includes("liveMultiviewEnabled")
                          ? "영상 호스트 권한이 거부되어 멀티뷰를 켜지 않았습니다."
                          : PREVIEW_PERMISSION_DENIED_MESSAGE,
                    "error"
                );
                return;
            }
            startSave(normalized, "옵션을 저장했습니다.");
        });
        return;
    }

    commitSave("옵션을 저장했습니다.");
}

// 검색창이나 숫자 입력에서 Enter를 눌러도 페이지가 다시 로드되지 않게 한다.
form.addEventListener("submit", (event) => {
    event.preventDefault();
});

form.addEventListener("keydown", (event) => {
    const input = getOptionInput(event.target);
    if (!isShortcutCodeInput(input) || event.code === "Tab") return;

    if (optionsLoadState !== "ready" || input.disabled || event.repeat || event.isComposing) return;
    if (event.code === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        input.blur();
        return;
    }
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
    if (!isPlaybackSpeedShortcutCode(event.code)) {
        showMessage(SHORTCUT_KEY_UNAVAILABLE_MESSAGE, "error");
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const duplicateShortcut = optionInputs.some(
        (candidate) => isShortcutCodeInput(candidate) && candidate !== input && getInputValue(candidate) === event.code
    );
    if (duplicateShortcut) {
        showMessage(SHORTCUT_KEY_DUPLICATE_MESSAGE, "error");
        return;
    }

    setInputValue(input, event.code);
    renderFormChanges();
});

form.addEventListener("input", (event) => {
    if (optionsLoadState !== "ready") return;
    const input = getOptionInput(event.target);
    // 체크박스는 change에서 한 번만 처리한다.
    if (!input || input.type === "checkbox") return;
    renderFormChanges();
});

form.addEventListener("change", (event) => {
    if (optionsLoadState !== "ready") return;
    const input = getOptionInput(event.target);
    if (!input) return;
    if (input.type !== "checkbox") {
        // 범위를 벗어난 값은 입력을 마친 시점에 보정값을 되돌려 보여준다.
        const normalized = readOptionsFromForm();
        setInputValue(input, normalized[input.dataset.option]);
    }
    renderFormChanges();
});

saveButton.addEventListener("click", saveCurrentOptions);
// The appearance control lives in the header, outside the form's event subtree.
document.getElementById("optionsTheme").addEventListener("click", (event) => {
    if (optionsLoadState !== "ready") return;
    const themes = ["system", "light", "dark"];
    const button = event.currentTarget;
    button.value = themes[(themes.indexOf(button.value) + 1) % themes.length];
    renderFormChanges();
});

shortcutResetButton.addEventListener("click", () => {
    if (optionsLoadState !== "ready" || saveInFlight || shortcutResetButton.disabled) return;
    for (const input of playbackSpeedShortcutInputs) {
        setInputValue(input, DEFAULT_OPTIONS[input.dataset.option]);
    }
    hideMessage();
    renderFormChanges();
});

discardButton.addEventListener("click", () => {
    if (optionsLoadState !== "ready" || saveInFlight || !savedOptions) return;
    const hadFocus = document.activeElement === discardButton;
    renderOptions(savedOptions);
    hideMessage();
    if (hadFocus) document.querySelector('.tab[aria-selected="true"]')?.focus({ preventScroll: true });
});

headerMenu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !headerMenu.open) return;
    event.preventDefault();
    headerMenu.open = false;
    headerMenu.querySelector("summary").focus();
});
headerMenu.addEventListener("focusout", (event) => {
    if (headerMenu.open && event.relatedTarget && !headerMenu.contains(event.relatedTarget)) headerMenu.open = false;
});
document.addEventListener("click", (event) => {
    if (headerMenu.open && !headerMenu.contains(event.target)) headerMenu.open = false;
});

resetButton.addEventListener("click", () => {
    if (optionsLoadState !== "ready" || saveInFlight) return;
    if (!window.confirm("모든 설정을 기본값으로 되돌릴까요? 직접 바꾼 키와 수치도 함께 초기화됩니다.")) return;
    headerMenu.open = false;
    headerMenu.querySelector("summary").focus();
    renderOptions(DEFAULT_OPTIONS);
    commitSave("기본값으로 복원했습니다.");
});

if (storage) {
    renderNotice("loading");
    applyControlStates(readOptionsFromForm());
    storage.get(STORAGE_OPTION_KEYS, (data) => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (error) {
            optionsLoadState = "failed";
            renderOptions(DEFAULT_OPTIONS, { state: "error" });
            showMessage(OPTIONS_LOAD_ERROR_MESSAGE, "error");
            return;
        }
        optionsLoadState = "ready";
        savedOptions = renderOptions(data);
        migrateLegacyChatToolsOption(data, savedOptions);
    });
} else {
    savedOptions = renderOptions(DEFAULT_OPTIONS);
}

const versionBadge = document.getElementById("versionBadge");
const manifestVersion = globalThis.chrome?.runtime?.getManifest?.()?.version;
if (versionBadge && manifestVersion) {
    versionBadge.textContent = `v${manifestVersion}`;
    versionBadge.hidden = false;
}

const tabButtons = Array.from(document.querySelectorAll(".tab"));
const tabSections = Array.from(form.querySelectorAll(".settings-card"));
const tabBar = document.querySelector(".tab-bar");
const LAST_TAB_STORAGE_KEY = "betterChzzkOptionsLastTab";
const reducedTabMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
let tabScrollTarget = null;

function tabScrollBehavior(animate = true) {
    return animate && !reducedTabMotion?.matches ? "smooth" : "instant";
}

function tabScrollBounds() {
    const max = Math.max(0, tabBar.scrollWidth - tabBar.clientWidth);
    return getComputedStyle(tabBar).direction === "rtl" ? { min: -max, max: 0 } : { min: 0, max };
}

function scrollTabBar(left, animate = true) {
    const bounds = tabScrollBounds();
    const target = Math.max(bounds.min, Math.min(bounds.max, left));
    if (typeof tabBar.scrollTo !== "function") {
        tabScrollTarget = null;
        tabBar.scrollLeft = target;
        return;
    }
    const behavior = tabScrollBehavior(animate);
    tabScrollTarget = behavior === "smooth" && Math.abs(target - tabBar.scrollLeft) > 0.5 ? target : null;
    tabBar.scrollTo({ left: target, behavior });
}

function stopTabScroll() {
    if (tabScrollTarget === null) return;
    tabScrollTarget = null;
    tabBar.scrollTo?.({ left: tabBar.scrollLeft, behavior: "instant" });
}

tabBar?.addEventListener("scrollend", () => {
    tabScrollTarget = null;
});
tabBar?.addEventListener("pointerdown", stopTabScroll);
window.addEventListener("pagehide", stopTabScroll);
reducedTabMotion?.addEventListener("change", () => {
    if (reducedTabMotion.matches && tabScrollTarget !== null) scrollTabBar(tabScrollTarget, false);
});

function readStoredTabIndex() {
    try {
        const stored = Number.parseInt(window.localStorage.getItem(LAST_TAB_STORAGE_KEY) ?? "", 10);
        return Number.isInteger(stored) && stored >= 0 && stored < tabButtons.length ? stored : 0;
    } catch {
        return 0;
    }
}

function storeTabIndex(index) {
    try {
        window.localStorage.setItem(LAST_TAB_STORAGE_KEY, String(index));
    } catch {
        // 저장소를 쓸 수 없으면 마지막 탭 기억만 건너뛴다.
    }
}

function alignCompactTabPanel(index) {
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const section = tabSections[index];
    if (!section || viewportWidth > 860 || window.scrollY <= 0 || typeof window.scrollTo !== "function") return;

    const toolbar = document.querySelector(".settings-toolbar");
    const toolbarIsSticky = viewportWidth <= 480 || (toolbar && getComputedStyle(toolbar).position === "sticky");
    const toolbarHeight = toolbar && toolbarIsSticky ? toolbar.getBoundingClientRect().height : 0;
    const sectionTop = section.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, sectionTop - toolbarHeight - 8), behavior: tabScrollBehavior() });
}

function revealTab(button, animate) {
    if (!tabBar || !button || tabBar.scrollWidth <= tabBar.clientWidth) return;
    const barRect = tabBar.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    // Scroll only the category strip so restoring a tab does not move the page.
    if (buttonRect.left < barRect.left + 4)
        scrollTabBar(tabBar.scrollLeft + buttonRect.left - barRect.left - 4, animate);
    else if (buttonRect.right > barRect.right - 4)
        scrollTabBar(tabBar.scrollLeft + buttonRect.right - barRect.right + 4, animate);
    else stopTabScroll();
}

function activateTab(index, { focus = false, align = false } = {}) {
    tabButtons.forEach((btn, i) => {
        const active = i === index;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.tabIndex = active ? 0 : -1;
        if (active && focus) btn.focus({ preventScroll: true });
    });
    tabSections.forEach((sec, i) => sec.classList.toggle("is-active", i === index));
    revealTab(tabButtons[index], focus || align);
    storeTabIndex(index);
    if (align) alignCompactTabPanel(index);
}

tabButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => {
        clearSearch();
        activateTab(i, { align: true });
    });
});

tabBar?.addEventListener("keydown", (event) => {
    const currentIndex = tabButtons.indexOf(document.activeElement);
    if (currentIndex < 0) return;

    let nextIndex = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabButtons.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabButtons.length) % tabButtons.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabButtons.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    clearSearch();
    activateTab(nextIndex, { focus: true, align: true });
});

tabBar?.addEventListener(
    "wheel",
    (event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
            stopTabScroll();
            return;
        }
        const maxScroll = tabBar.scrollWidth - tabBar.clientWidth;
        if (maxScroll <= 0 || !event.deltaY) return;
        const step =
            event.deltaMode === 1
                ? parseFloat(getComputedStyle(tabBar).lineHeight) || 16
                : event.deltaMode === 2
                  ? tabBar.clientWidth
                  : 1;
        const bounds = tabScrollBounds();
        const direction = bounds.min < 0 ? -1 : 1;
        const next = Math.max(
            bounds.min,
            Math.min(bounds.max, (tabScrollTarget ?? tabBar.scrollLeft) + event.deltaY * step * direction)
        );
        if (Math.abs(next - tabBar.scrollLeft) < 0.5 && tabScrollTarget === null) return;
        event.preventDefault();
        if (next === tabScrollTarget) return;
        scrollTabBar(next);
    },
    { passive: false }
);

if (tabButtons.length) activateTab(readStoredTabIndex());

const searchInput = document.getElementById("settingsSearch");
const searchEmptyEl = document.getElementById("searchEmpty");
const searchStatusEl = document.getElementById("searchStatus");
const optionGroups = Array.from(form.querySelectorAll(".option-group"));
let searchOpenSnapshot = null;
const groupStateStorage = globalThis.chrome?.storage?.local;
const groupStates = new Map(
    optionGroups.map((group) => [
        group,
        { key: `betterChzzkOptionsGroupOpen:${group.dataset.optionGroup}`, open: group.open, changed: false },
    ])
);

function setGroupOpen(group, open) {
    // details의 toggle은 비동기로 전달되므로 검색·복원으로 바꾼 상태를 먼저 기록한다.
    groupStates.get(group).open = open;
    group.open = open;
}

function rememberGroupOpen(group) {
    const state = groupStates.get(group);
    if (state.open === group.open) return;
    state.open = group.open;
    state.changed = true;
    if (searchOpenSnapshot) {
        if (group.open) searchOpenSnapshot.add(group);
        else searchOpenSnapshot.delete(group);
    }
    try {
        groupStateStorage?.set({ [state.key]: group.open }, () => {
            const error = globalThis.chrome?.runtime?.lastError;
            if (error) console.warn("[BetterChzzk] 옵션 묶음 상태 저장 실패:", error.message);
        });
    } catch (error) {
        console.warn("[BetterChzzk] 옵션 묶음 상태 저장 실패:", error);
    }
}

for (const group of optionGroups) {
    group.addEventListener("toggle", () => rememberGroupOpen(group));
}
// 팝업을 바로 닫거나 검색을 시작해도 아직 전달되지 않은 사용자 toggle을 보존한다.
window.addEventListener("pagehide", () => optionGroups.forEach(rememberGroupOpen));
try {
    groupStateStorage?.get(
        Array.from(groupStates.values(), (state) => state.key),
        (stored) => {
            const error = globalThis.chrome?.runtime?.lastError;
            if (error) {
                console.warn("[BetterChzzk] 옵션 묶음 상태 불러오기 실패:", error.message);
                return;
            }
            for (const [group, state] of groupStates) {
                rememberGroupOpen(group);
                const open = stored?.[state.key];
                if (state.changed || typeof open !== "boolean") continue;
                if (searchOpenSnapshot) {
                    if (open) searchOpenSnapshot.add(group);
                    else searchOpenSnapshot.delete(group);
                } else {
                    setGroupOpen(group, open);
                }
            }
        }
    );
} catch (error) {
    console.warn("[BetterChzzk] 옵션 묶음 상태 불러오기 실패:", error);
}

function normalizeSearchText(text) {
    return String(text).toLowerCase().replace(/\s+/g, "");
}

// 접이식 그룹 안에서는 각 행·수치 묶음을 개별 검색 단위로 유지한다.
const searchUnits = tabSections.flatMap((section) => {
    const heading = section.querySelector(".section-heading");
    const headingText = normalizeSearchText(heading?.textContent || "");
    return Array.from(section.children)
        .filter((child) => child !== heading)
        .flatMap((element) => {
            if (!element.matches(".option-group")) return [element];
            const body = Array.from(element.children).find((child) => child.classList.contains("option-group-body"));
            return body ? Array.from(body.children) : [];
        })
        .map((element) => {
            const optionKeys = Array.from(element.querySelectorAll("[data-option]"), (input) => input.dataset.option);
            const dependencyNodes = element.matches("[data-depends-on]")
                ? [element, ...element.querySelectorAll("[data-depends-on]")]
                : Array.from(element.querySelectorAll("[data-depends-on]"));
            const dependencyKeys = [
                ...new Set(
                    dependencyNodes.flatMap((node) =>
                        String(node.dataset.dependsOn || "")
                            .split(/\s+/)
                            .filter(Boolean)
                    )
                ),
            ];
            const group = element.closest(".option-group");
            const groupText = normalizeSearchText(group?.firstElementChild?.textContent || "");
            return {
                dependencyKeys,
                element,
                group,
                groupText,
                headingText,
                optionKeys,
                section,
                text: normalizeSearchText(`${element.textContent} ${optionKeys.join(" ")}`),
            };
        });
});

const searchUnitByOptionKey = new Map();
for (const unit of searchUnits) {
    for (const optionKey of unit.optionKeys) searchUnitByOptionKey.set(optionKey, unit);
}

function includeSearchContext(directMatches) {
    const visibleUnits = new Set(directMatches);

    // 안내문만 검색된 경우에도 관련 설정을 함께 보여 줘 문맥과 조작 경로를 남긴다.
    for (const unit of directMatches) {
        if (!unit.element.matches(".setting-note") && !unit.group?.hasAttribute("data-search-together")) continue;
        for (const candidate of searchUnits) {
            const sameContext = unit.group ? candidate.group === unit.group : candidate.section === unit.section;
            if (sameContext) visibleUnits.add(candidate);
        }
    }

    // 비활성화된 세부 설정을 검색해도 상위 토글을 켤 수 있도록 의존 관계를 끝까지 따라간다.
    const pending = [...visibleUnits];
    for (let index = 0; index < pending.length; index += 1) {
        for (const optionKey of pending[index].dependencyKeys) {
            const masterUnit = searchUnitByOptionKey.get(optionKey);
            if (!masterUnit || visibleUnits.has(masterUnit)) continue;
            visibleUnits.add(masterUnit);
            pending.push(masterUnit);
        }
    }

    return visibleUnits;
}

function applySearch(query) {
    if (!searchInput) return;
    optionGroups.forEach(rememberGroupOpen);
    const normalized = normalizeSearchText(query);
    const searching = normalized.length > 0;
    form.classList.toggle("is-searching", searching);

    if (!searching) {
        for (const unit of searchUnits) unit.element.classList.remove("search-miss");
        for (const group of optionGroups) group.classList.remove("search-miss");
        for (const section of tabSections) section.classList.remove("search-miss");
        if (searchOpenSnapshot) {
            for (const group of optionGroups) setGroupOpen(group, searchOpenSnapshot.has(group));
            searchOpenSnapshot = null;
        }
        searchEmptyEl?.classList.add("hidden");
        if (searchStatusEl) searchStatusEl.hidden = true;
        return;
    }

    if (!searchOpenSnapshot) {
        searchOpenSnapshot = new Set(optionGroups.filter((group) => group.open));
    }

    const directMatches = searchUnits.filter(
        (unit) =>
            unit.headingText.includes(normalized) ||
            unit.groupText.includes(normalized) ||
            unit.text.includes(normalized)
    );
    const visibleUnits = includeSearchContext(directMatches);
    const matchedGroups = new Set();
    const matchedSections = new Set();
    for (const unit of searchUnits) {
        const visible = visibleUnits.has(unit);
        unit.element.classList.toggle("search-miss", !visible);
        if (!visible) continue;
        matchedSections.add(unit.section);
        if (unit.group) {
            matchedGroups.add(unit.group);
            setGroupOpen(unit.group, true);
        }
    }
    for (const group of optionGroups) group.classList.toggle("search-miss", !matchedGroups.has(group));
    for (const section of tabSections) {
        section.classList.toggle("search-miss", !matchedSections.has(section));
    }

    if (searchEmptyEl) {
        searchEmptyEl.textContent = `‘${query.trim()}’에 해당하는 설정이 없습니다.`;
        searchEmptyEl.classList.toggle("hidden", directMatches.length > 0);
    }
    if (searchStatusEl) {
        searchStatusEl.hidden = false;
        searchStatusEl.textContent = `${directMatches.length}개 항목`;
    }
}

function clearSearch() {
    if (!searchInput || searchInput.value === "") return;
    searchInput.value = "";
    applySearch("");
}

searchInput?.addEventListener("input", () => applySearch(searchInput.value));
searchInput?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    clearSearch();
});
