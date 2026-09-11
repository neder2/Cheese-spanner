/* Refresh notice in the extension popup and options page. */
(() => {
    const { UPDATE_KEY, READ_KEY, NOTIFICATIONS_KEY } = globalThis.BetterChzzkUpdateNotice;
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
    const storage = globalThis.chrome?.storage?.local;
    const notice = document.getElementById("updateNotice");
    let destroyed = false;
    let loadGeneration = 0;

    function loadNotice() {
        if (destroyed || !storage || !version) return;
        const generation = ++loadGeneration;
        storage.get([UPDATE_KEY, READ_KEY], (data) => {
            const failed = BetterChzzkSettings.getStorageLastError();
            if (destroyed || failed || generation !== loadGeneration) return;
            chrome.storage.sync.get(NOTIFICATIONS_KEY, (options) => {
                const failed = BetterChzzkSettings.getStorageLastError();
                if (destroyed || failed || generation !== loadGeneration) return;
                const unread =
                    options?.[NOTIFICATIONS_KEY] !== false &&
                    data?.[UPDATE_KEY]?.version === version &&
                    data?.[READ_KEY] !== version;
                notice.hidden = !unread;
                document.getElementById("updateNoticeTitle").textContent = unread
                    ? `Better Chzzk ${version} 업데이트`
                    : "";
            });
        });
    }

    const onStorageChanged = (changes, area) => {
        if (area === "sync" && Object.hasOwn(changes, NOTIFICATIONS_KEY)) loadNotice();
        if (area === "local" && (Object.hasOwn(changes, UPDATE_KEY) || Object.hasOwn(changes, READ_KEY))) loadNotice();
    };
    globalThis.chrome?.storage?.onChanged?.addListener(onStorageChanged);
    window.addEventListener(
        "pagehide",
        () => {
            destroyed = true;
            loadGeneration++;
            globalThis.chrome?.storage?.onChanged?.removeListener(onStorageChanged);
        },
        { once: true }
    );
    loadNotice();
})();
