// Page tests route BetterChzzk.utils.settingsStoreSet through the same fake storage area the worker would use.
// The real worker boundary (sender, allowlist, value validation, lock) is covered by tests/settings-store.test.js.
const SETTINGS_STORE_MESSAGE_TYPE = "betterchzzk:settings-store";

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
            .join(",")}}`;
    return JSON.stringify(value);
}

/** Returns true when the message was a settings store request and the callback will be answered. */
function forwardSettingsStore(chrome, message, callback) {
    if (message?.type !== SETTINGS_STORE_MESSAGE_TYPE) return false;
    const area = chrome.storage?.[message.area];
    const answer = (response) => callback?.(response);
    if (typeof area?.set !== "function") {
        setTimeout(() => answer({ ok: false, error: "storage-write-failed" }), 0);
        return true;
    }
    const write = () =>
        area.set(message.values, () => {
            answer(chrome.runtime?.lastError ? { ok: false, error: "storage-write-failed" } : { ok: true });
        });
    if (!message.expected) {
        write();
        return true;
    }
    const keys = Object.keys(message.expected);
    area.get(keys, (data) => {
        if (chrome.runtime?.lastError) {
            answer({ ok: false, error: "storage-read-failed" });
            return;
        }
        const current = {};
        let conflict = false;
        for (const key of keys) {
            const exists = Object.hasOwn(data || {}, key);
            current[key] = exists ? { value: data[key] } : { absent: true };
            const expected = message.expected[key];
            if (expected.absent ? exists : !exists || stable(data[key]) !== stable(expected.value)) conflict = true;
        }
        if (conflict) answer({ ok: false, error: "conflict", current });
        else write();
    });
    return true;
}

module.exports = { SETTINGS_STORE_MESSAGE_TYPE, forwardSettingsStore };
