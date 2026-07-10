/**
 * options.js — options.html(설정 페이지)의 스크립트로, 모든 기능 토글/수치를 폼으로 보여주고 자동 저장한다.
 *
 * 실행 컨텍스트: manifest의 action.default_popup이자 options_page인 options.html에서 로드된다.
 * 확장 아이콘을 클릭하면 작은 팝업 창으로 여는 것이 1차 사용 환경이라, UI는 좁은 뷰포트를 기준으로
 * 짜여 있다(전체 탭으로 여는 것은 부차적 경로). options.html은 shared/settings.js를 같은 페이지에
 * script 태그로 먼저 로드하고 그다음 이 파일을 로드한다. content script가 아니다.
 * 하는 일: chrome.storage.sync에서 옵션을 불러와 폼에 채우고, 입력/체크박스 변경 시 디바운스 후
 * 자동 저장한다. 옵션 간 의존 관계(data-depends-on)에 따라 하위 컨트롤을 비활성화하고, 탭 전환과
 * 설정 검색(검색어로 카드 항목 필터링), 기본값 복원 버튼을 처리한다.
 * 의존: BetterChzzkSettings(shared/settings.js가 노출하는 DEFAULT_OPTIONS, FEATURE_KEYS,
 * OPTION_KEYS, normalizeOptions), globalThis.chrome.storage.sync, globalThis.chrome.permissions,
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
const noticeEl = document.getElementById("notice");
const messageEl = document.getElementById("message");

const { DEFAULT_OPTIONS, FEATURE_KEYS, OPTION_KEYS, normalizeOptions } = BetterChzzkSettings;

const storage = globalThis.chrome?.storage?.sync;
const AUTOSAVE_DEBOUNCE_MS = 400;
const OPTIONS_LOAD_ERROR_MESSAGE = "설정을 불러오지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
const OPTIONS_LOAD_BLOCKED_SAVE_MESSAGE =
    "설정을 불러오지 못해 저장하지 않았습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.";
const OPTIONS_SAVE_ERROR_MESSAGE = "설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.";
const NOTICE_STATE_LABELS = {
    loading: "불러오는 중",
    saving: "저장 중",
    saved: "저장됨",
    error: "저장 실패",
};

// 팔로잉 미리보기 영상(HLS)은 pstatic.net에서 내려오므로 선택 권한으로 두고,
// 기능을 켜는 순간에만 요청한다. 이미 허용된 상태의 request는 팝업 없이 승인된다.
const PREVIEW_HOST_PERMISSION = { origins: ["https://*.pstatic.net/*"] };
const PREVIEW_PERMISSION_DENIED_MESSAGE = "권한이 거부되어 팔로잉 미리보기를 켜지 않았습니다.";

let hideMessageTimer = 0;
let savedOptions = null;
let autosaveTimer = 0;
let saveInFlight = false;
let pendingSave = null;
let optionsLoadFailed = false;

function setInputValue(input, value) {
    if (input.type === "checkbox") {
        input.checked = Boolean(value);
        return;
    }
    input.value = String(value);
}

function getInputValue(input) {
    return input.type === "checkbox" ? input.checked : input.value;
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

function getEnabledFeatureCount(options) {
    return FEATURE_KEYS.filter((key) => Boolean(options[key])).length;
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
    for (const control of optionInputs) {
        control.disabled = isDisabledByDependency(control, options);
    }
}

function renderNotice(options, state) {
    const label = NOTICE_STATE_LABELS[state] || NOTICE_STATE_LABELS.saved;
    noticeEl.dataset.state = state;
    noticeEl.textContent = options ? `${label} · 기능 ${getEnabledFeatureCount(options)}개` : label;
}

function renderPageState(options, state = "saved") {
    applyDependencies(options);
    applyControlStates(options);
    renderNotice(options, state);
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
        const normalizedValue = String(options[input.dataset.option]);
        if (input.value !== normalizedValue) input.value = normalizedValue;
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
    if (!error) savedOptions = normalized;

    const queued = pendingSave;
    pendingSave = null;
    if (queued) {
        if (!error && areOptionsEqual(queued.options, normalized)) {
            const current = readOptionsFromForm();
            if (!areOptionsEqual(current, normalized)) {
                startSave(current);
                return;
            }
            syncNumberInputs(queued.options);
            renderPageState(queued.options, "saved");
            if (queued.message) showMessage(queued.message);
            return;
        }
        startSave(queued.options, queued.message);
        return;
    }

    if (error) {
        renderPageState(readOptionsFromForm(), "error");
        showMessage(OPTIONS_SAVE_ERROR_MESSAGE, "error");
        return;
    }

    const current = readOptionsFromForm();
    if (!areOptionsEqual(current, normalized)) {
        startSave(current);
        return;
    }
    syncNumberInputs(normalized);
    renderPageState(normalized, "saved");
    if (message) showMessage(message);
}

function startSave(normalized, message) {
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
    const normalized = readOptionsFromForm();
    if (optionsLoadFailed && !savedOptions) {
        renderPageState(normalized, "error");
        showMessage(OPTIONS_LOAD_BLOCKED_SAVE_MESSAGE, "error");
        return;
    }

    if (saveInFlight) {
        pendingSave = { options: normalized, message };
        renderPageState(normalized, "saving");
        return;
    }

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

function cancelAutosave() {
    if (!autosaveTimer) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = 0;
}

function scheduleAutosave() {
    cancelAutosave();
    autosaveTimer = setTimeout(() => {
        autosaveTimer = 0;
        commitSave();
    }, AUTOSAVE_DEBOUNCE_MS);
}

function flushPendingAutosave() {
    if (!autosaveTimer) return;
    cancelAutosave();
    commitSave();
}

function flushLatestOptionsOnPageHide() {
    const hadPendingAutosave = Boolean(autosaveTimer);
    cancelAutosave();

    if (!saveInFlight) {
        if (hadPendingAutosave) commitSave();
        return;
    }
    if (!hadPendingAutosave && !pendingSave) return;

    const normalized = readOptionsFromForm();
    const message = pendingSave?.message;
    pendingSave = { options: normalized, message };
    renderPageState(normalized, "saving");

    // 팝업이 닫히면 진행 중인 요청의 콜백이 실행되지 않을 수 있어, 최신값을 그 요청 뒤에 미리 발행한다.
    // 페이지가 계속 살아 있으면 pendingSave를 유지한 기존 직렬 큐가 같은 최신값을 다시 확정한다.
    storage?.set(normalized, () => {
        void globalThis.chrome?.runtime?.lastError;
    });
}

function getOptionInput(target) {
    const input = target instanceof Element ? target.closest("[data-option]") : null;
    return input && optionInputs.includes(input) ? input : null;
}

// 검색창이나 숫자 입력에서 Enter를 눌러도 페이지가 다시 로드되지 않게 한다.
form.addEventListener("submit", (event) => {
    event.preventDefault();
});

form.addEventListener("input", (event) => {
    const input = getOptionInput(event.target);
    // 체크박스는 change에서 한 번만 저장하고, 숫자 입력은 타이핑이 멎은 뒤 저장한다.
    if (!input || input.type === "checkbox") return;
    renderPageState(readOptionsFromForm(), "saving");
    scheduleAutosave();
});

form.addEventListener("change", (event) => {
    const input = getOptionInput(event.target);
    if (!input) return;
    cancelAutosave();
    if (input.type !== "checkbox") {
        // 범위를 벗어난 값은 입력을 마친 시점에 보정값을 되돌려 보여준다.
        const normalized = readOptionsFromForm();
        setInputValue(input, normalized[input.dataset.option]);
    }
    if (input.dataset.option === "followingPreviewTooltipEnabled" && input.checked) {
        requestPreviewPermission((granted) => {
            if (!granted) {
                input.checked = false;
                showMessage(PREVIEW_PERMISSION_DENIED_MESSAGE, "error");
            }
            commitSave();
        });
        return;
    }
    commitSave();
});

resetButton.addEventListener("click", () => {
    if (!window.confirm("모든 설정을 기본값으로 되돌릴까요? 직접 입력한 수치도 함께 초기화됩니다.")) return;
    cancelAutosave();
    renderOptions(DEFAULT_OPTIONS);
    commitSave("기본값으로 복원했습니다.");
});

window.addEventListener("pagehide", flushLatestOptionsOnPageHide);
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingAutosave();
});

if (storage) {
    renderNotice(null, "loading");
    storage.get(OPTION_KEYS, (data) => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (error) {
            optionsLoadFailed = true;
            renderOptions(DEFAULT_OPTIONS, { state: "error" });
            showMessage(OPTIONS_LOAD_ERROR_MESSAGE, "error");
            return;
        }
        optionsLoadFailed = false;
        savedOptions = renderOptions(data);
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

function activateTab(index, { focus = false } = {}) {
    tabButtons.forEach((btn, i) => {
        const active = i === index;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
        btn.tabIndex = active ? 0 : -1;
        if (active && focus) btn.focus();
    });
    tabSections.forEach((sec, i) => sec.classList.toggle("is-active", i === index));
    storeTabIndex(index);
}

tabButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => {
        clearSearch();
        activateTab(i);
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
    activateTab(nextIndex, { focus: true });
});

if (tabButtons.length) activateTab(readStoredTabIndex());

const searchInput = document.getElementById("settingsSearch");
const searchEmptyEl = document.getElementById("searchEmpty");
const searchStatusEl = document.getElementById("searchStatus");
let searchOpenSnapshot = null;

function normalizeSearchText(text) {
    return String(text).toLowerCase().replace(/\s+/g, "");
}

// 카드 안에서 제목을 제외한 직계 요소(토글 행, 세부 설정, 버튼 행, 안내문)를 검색 단위로 삼는다.
const searchUnits = tabSections.flatMap((section) => {
    const heading = section.querySelector(".section-heading");
    const headingText = normalizeSearchText(heading?.textContent || "");
    return Array.from(section.children)
        .filter((child) => child !== heading)
        .map((element) => {
            const optionKeys = Array.from(element.querySelectorAll("[data-option]"), (input) => input.dataset.option);
            return {
                element,
                headingText,
                section,
                text: normalizeSearchText(`${element.textContent} ${optionKeys.join(" ")}`),
            };
        });
});

function applySearch(query) {
    if (!searchInput) return;
    const normalized = normalizeSearchText(query);
    const searching = normalized.length > 0;
    form.classList.toggle("is-searching", searching);

    if (!searching) {
        for (const unit of searchUnits) unit.element.classList.remove("search-miss");
        for (const section of tabSections) section.classList.remove("search-miss");
        if (searchOpenSnapshot) {
            for (const details of form.querySelectorAll(".advanced-settings")) {
                details.open = searchOpenSnapshot.has(details);
            }
            searchOpenSnapshot = null;
        }
        searchEmptyEl?.classList.add("hidden");
        if (searchStatusEl) searchStatusEl.hidden = true;
        return;
    }

    if (!searchOpenSnapshot) {
        searchOpenSnapshot = new Set(
            Array.from(form.querySelectorAll(".advanced-settings")).filter((details) => details.open)
        );
    }

    let matchCount = 0;
    const matchedSections = new Set();
    for (const unit of searchUnits) {
        const matched = unit.headingText.includes(normalized) || unit.text.includes(normalized);
        unit.element.classList.toggle("search-miss", !matched);
        if (!matched) continue;
        matchCount += 1;
        matchedSections.add(unit.section);
        // 세부 설정 안쪽 항목이 걸리면 펼쳐서 바로 보여준다.
        if (unit.element.matches(".advanced-settings")) unit.element.open = true;
    }
    for (const section of tabSections) {
        section.classList.toggle("search-miss", !matchedSections.has(section));
    }

    if (searchEmptyEl) {
        searchEmptyEl.textContent = `‘${query.trim()}’에 해당하는 설정이 없습니다.`;
        searchEmptyEl.classList.toggle("hidden", matchCount > 0);
    }
    if (searchStatusEl) {
        searchStatusEl.hidden = false;
        searchStatusEl.textContent = `${matchCount}개 항목`;
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
