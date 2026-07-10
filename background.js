/**
 * background.js — MV3 service worker. 설치/업데이트 시 저장된 옵션을 스키마 기준으로 정규화한다.
 *
 * 하는 일: onInstalled에서 chrome.storage.sync의 옵션을 normalizeOptions로 정리해, 스키마 밖 값이나
 *   범위를 벗어난 값을 기본값·경계값으로 고쳐 저장한다. 그 외 상주 로직은 없다.
 * 의존: shared/settings.js(importScripts) — settings.js가 DOM API를 쓰지 않아야 하는 이유가 이 로드다.
 */
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
