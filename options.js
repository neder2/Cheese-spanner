const form = document.getElementById("optionsForm");
const optionInputs = Array.from(document.querySelectorAll("[data-option]"));
const dependencyGroups = Array.from(document.querySelectorAll("[data-depends-on]"));
const saveButton = document.getElementById("save");
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

let hideMessageTimer = 0;
let savedOptions = null;
let saving = false;

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
        raw[input.dataset.option] = getInputValue(input);
    }

    return normalizeOptions(raw);
}

function areOptionsEqual(a, b) {
    if (!a || !b) return false;
    return OPTION_KEYS.every((key) => a[key] === b[key]);
}

function isDirty(options) {
    return Boolean(savedOptions) && !areOptionsEqual(options, savedOptions);
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
        control.disabled = saving || isDisabledByDependency(control, options);
    }
}

function renderNotice(options) {
    const dirty = isDirty(options);
    const state = !savedOptions ? "loading" : dirty ? "dirty" : "saved";
    const stateText = !savedOptions ? "불러오는 중" : dirty ? "저장 필요" : "저장됨";
    const enabledCount = getEnabledFeatureCount(options);

    noticeEl.dataset.state = state;
    noticeEl.textContent = `${stateText} · 1080p · 기능 ${enabledCount}개`;
}

function updateButtons(options) {
    const dirty = isDirty(options);
    saveButton.disabled = saving || !dirty;
    resetButton.disabled = saving;
    saveButton.textContent = saving ? "저장 중" : dirty ? "설정 저장" : "저장됨";
}

function renderPageState(options) {
    applyDependencies(options);
    applyControlStates(options);
    renderNotice(options);
    updateButtons(options);
}

function renderOptions(options, { markSaved = false } = {}) {
    const normalized = normalizeOptions(options);
    for (const input of optionInputs) {
        setInputValue(input, normalized[input.dataset.option]);
    }
    if (markSaved) savedOptions = normalized;
    renderPageState(normalized);
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

function setSaving(isSaving) {
    saving = isSaving;
    renderPageState(readOptionsFromForm());
}

function saveOptions(options, message = "설정이 저장되었습니다.") {
    const normalized = normalizeOptions(options);
    setSaving(true);

    const finish = (error) => {
        setSaving(false);
        if (error) {
            showMessage("설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
            return;
        }
        renderOptions(normalized, { markSaved: true });
        showMessage(message);
    };

    if (!storage) {
        finish();
        return;
    }

    storage.set(normalized, () => {
        finish(globalThis.chrome?.runtime?.lastError);
    });
}

function handleFormChange() {
    renderPageState(readOptionsFromForm());
}

saveButton.addEventListener("click", () => {
    if (saveButton.disabled) return;
    saveOptions(readOptionsFromForm());
});

resetButton.addEventListener("click", () => {
    saveOptions(DEFAULT_OPTIONS, "기본값으로 복원했습니다.");
});

form.addEventListener("input", handleFormChange);
form.addEventListener("change", handleFormChange);

if (storage) {
    storage.get(OPTION_KEYS, (data) => {
        renderOptions(data, { markSaved: true });
    });
} else {
    renderOptions(DEFAULT_OPTIONS, { markSaved: true });
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
