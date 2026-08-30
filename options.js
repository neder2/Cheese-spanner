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
 */
const form = document.getElementById("optionsForm");
const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
const dependencyGroups = Array.from(document.querySelectorAll("[data-depends-on]"));
const resetButton = document.getElementById("reset");
const saveButton = document.getElementById("save");
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
const SHORTCUT_KEY_DUPLICATE_MESSAGE = "0.5배속과 2배속은 서로 다른 키로 지정해 주세요.";

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
    saveButton.disabled = optionsUnavailable || saveInFlight || !savedOptions || areOptionsEqual(options, savedOptions);
}

function renderNotice(state) {
    const label = NOTICE_STATE_LABELS[state] || NOTICE_STATE_LABELS.saved;
    noticeEl.dataset.state = state;
    noticeEl.textContent = label;
}

function renderPageState(options, state = "saved") {
    applyDependencies(options);
    applyControlStates(options);
    renderNotice(state);
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

function showMessage(text, type = "success") {
    clearTimeout(hideMessageTimer);
    messageEl.textContent = text;
    messageEl.dataset.type = type;
    messageEl.classList.remove("hidden");
    messageEl.classList.add("is-visible");

    hideMessageTimer = setTimeout(() => {
        messageEl.classList.remove("is-visible");
        messageEl.classList.add("hidden");
    }, 1800);
}

function finishSave(normalized, message, error) {
    saveInFlight = false;
    if (error) {
        renderPageState(readOptionsFromForm(), "error");
        showMessage(OPTIONS_SAVE_ERROR_MESSAGE, "error");
        return;
    }

    savedOptions = normalized;
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
        finishSave(normalized, message, globalThis.chrome?.runtime?.lastError);
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

function requestPreviewPermission(callback) {
    const permissions = globalThis.chrome?.permissions;
    // 권한 API가 없는 환경(테스트, 구형 브라우저)에서는 기존처럼 그대로 저장한다.
    if (typeof permissions?.request !== "function") {
        callback(true);
        return;
    }
    permissions.request(PREVIEW_HOST_PERMISSION, (granted) => {
        // 사용자가 팝업에서 거부해도 lastError가 남을 수 있어 읽어서 경고를 지운다.
        void globalThis.chrome?.runtime?.lastError;
        callback(Boolean(granted));
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
    if (normalized.followingPreviewTooltipEnabled && !savedOptions?.followingPreviewTooltipEnabled) {
        requestPreviewPermission((granted) => {
            if (!granted) {
                const previewToggle = optionInputs.find(
                    (input) => input.dataset.option === "followingPreviewTooltipEnabled"
                );
                if (previewToggle) previewToggle.checked = false;
                renderFormChanges();
                showMessage(PREVIEW_PERMISSION_DENIED_MESSAGE, "error");
                return;
            }
            commitSave("옵션을 저장했습니다.");
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

    const otherShortcutInput = optionInputs.find((candidate) => isShortcutCodeInput(candidate) && candidate !== input);
    if (otherShortcutInput && getInputValue(otherShortcutInput) === event.code) {
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

resetButton.addEventListener("click", () => {
    if (optionsLoadState !== "ready") return;
    if (!window.confirm("모든 설정을 기본값으로 되돌릴까요? 직접 바꾼 키와 수치도 함께 초기화됩니다.")) return;
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
    window.scrollTo({ top: Math.max(0, sectionTop - toolbarHeight - 8), behavior: "auto" });
}

function activateTab(index, { focus = false, align = false } = {}) {
    tabButtons.forEach((btn, i) => {
        const active = i === index;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.tabIndex = active ? 0 : -1;
        if (active && focus) btn.focus();
    });
    tabSections.forEach((sec, i) => sec.classList.toggle("is-active", i === index));
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

if (tabButtons.length) activateTab(readStoredTabIndex());

const searchInput = document.getElementById("settingsSearch");
const searchEmptyEl = document.getElementById("searchEmpty");
const searchStatusEl = document.getElementById("searchStatus");
const optionGroups = Array.from(form.querySelectorAll(".option-group"));
let searchOpenSnapshot = null;

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
        if (!unit.element.matches(".setting-note")) continue;
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
    const normalized = normalizeSearchText(query);
    const searching = normalized.length > 0;
    form.classList.toggle("is-searching", searching);

    if (!searching) {
        for (const unit of searchUnits) unit.element.classList.remove("search-miss");
        for (const group of optionGroups) group.classList.remove("search-miss");
        for (const section of tabSections) section.classList.remove("search-miss");
        if (searchOpenSnapshot) {
            for (const group of optionGroups) group.open = searchOpenSnapshot.has(group);
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
            unit.group.open = true;
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
