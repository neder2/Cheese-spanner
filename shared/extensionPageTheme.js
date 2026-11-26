// Read the saved preference as soon as an extension page starts parsing.
(() => {
    "use strict";
    const storage = globalThis.chrome?.storage;
    if (!storage?.sync) return;
    const preview = document.currentScript?.hasAttribute("data-options-preview");
    let changed = false;
    function apply(theme) {
        if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
        else delete document.documentElement.dataset.theme;
    }
    // The options editor owns live previews and merges saved changes with unsaved edits.
    if (!preview) {
        storage.onChanged.addListener((changes, area) => {
            if (area !== "sync" || !Object.hasOwn(changes, "optionsTheme")) return;
            changed = true;
            apply(changes.optionsTheme.newValue);
        });
    }
    storage.sync.get("optionsTheme", (values) => {
        if (chrome.runtime.lastError || changed || (preview && document.readyState !== "loading")) return;
        apply(values?.optionsTheme);
    });
})();
