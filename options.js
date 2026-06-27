const form = document.getElementById("optionsForm");
const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
const dependencyGroups = Array.from(document.querySelectorAll("[data-depends-on]"));
const resetButton = document.getElementById("reset");
const noticeEl = document.getElementById("notice");
const messageEl = document.getElementById("message");

const {
    DEFAULT_OPTIONS,
    FEATURE_KEYS,
    OPTION_KEYS,
    normalizeOptions,
} = BetterChzzkSettings;

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

let hideMessageTimer = 0;
let savedOptions = null;
let autosaveTimer = 0;
let saveToken = 0;
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
    const keys = String(group.dataset.dependsOn || "").split(/\s+/).filter(Boolean);
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

function commitSave(message) {
    const normalized = readOptionsFromForm();
    if (optionsLoadFailed && !savedOptions) {
        renderPageState(normalized, "error");
        showMessage(OPTIONS_LOAD_BLOCKED_SAVE_MESSAGE, "error");
        return;
    }

    if (savedOptions && areOptionsEqual(normalized, savedOptions)) {
        syncNumberInputs(normalized);
        renderPageState(normalized, "saved");
        if (message) showMessage(message);
        return;
    }

    renderPageState(normalized, "saving");
    const token = ++saveToken;

    const finish = (error) => {
        if (token !== saveToken) return;
        if (error) {
            renderPageState(normalized, "error");
            showMessage(OPTIONS_SAVE_ERROR_MESSAGE, "error");
            return;
        }
        savedOptions = normalized;
        syncNumberInputs(normalized);
        renderPageState(normalized, "saved");
        if (message) showMessage(message);
    };

    if (!storage) {
        finish();
        return;
    }

    storage.set(normalized, () => {
        finish(globalThis.chrome?.runtime?.lastError);
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

function getOptionInput(target) {
    const input = target instanceof Element ? target.closest("[data-option]") : null;
    return input && optionInputs.includes(input) ? input : null;
}

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
    commitSave();
});

resetButton.addEventListener("click", () => {
    if (!window.confirm("모든 설정을 기본값으로 되돌릴까요? 직접 입력한 수치도 함께 초기화됩니다.")) return;
    cancelAutosave();
    renderOptions(DEFAULT_OPTIONS);
    commitSave("기본값으로 복원했습니다.");
});

window.addEventListener("pagehide", flushPendingAutosave);
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

const tabButtons = Array.from(document.querySelectorAll(".tab"));
const tabSections = Array.from(form.querySelectorAll(".settings-card"));

function activateTab(index) {
    tabButtons.forEach((btn, i) => {
        const active = i === index;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    tabSections.forEach((sec, i) => sec.classList.toggle("is-active", i === index));
}

tabButtons.forEach((btn, i) => {
    btn.addEventListener("click", () => activateTab(i));
});

if (tabButtons.length) activateTab(0);
