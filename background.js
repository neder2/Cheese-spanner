importScripts("shared/settings.js");

const { OPTION_KEYS, getStorageLastError, normalizeOptions } = BetterChzzkSettings;

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(OPTION_KEYS, (data) => {
        if (getStorageLastError()) return;

        const normalized = normalizeOptions(data);
        const updates = {};

        for (const key of OPTION_KEYS) {
            if (normalized[key] !== data[key]) updates[key] = normalized[key];
        }

        if (Object.keys(updates).length) {
            chrome.storage.sync.set(updates, () => {
                getStorageLastError();
            });
        }
    });
});
