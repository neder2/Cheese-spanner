/* Directory selection belongs to the extension options page, not to the streaming site's origin. */
(() => {
    "use strict";
    const directory = globalThis.CheeseSpannerRecordingDirectory;
    const choose = document.getElementById("videoRecorderChooseDirectory");
    const clear = document.getElementById("videoRecorderClearDirectory");
    const status = document.getElementById("videoRecorderDirectoryStatus");
    const downloads = document.getElementById("videoRecorderDownloadSettings");
    let busy = false;
    let revision = 0;
    let selected = null;

    async function refresh() {
        const current = ++revision;
        try {
            const handle = await directory.get();
            const granted = handle && await handle.queryPermission({ mode: "readwrite" }) === "granted";
            if (current !== revision) return;
            selected = handle;
            clear.hidden = !handle;
            downloads.hidden = Boolean(handle);
            status.textContent = handle
                ? granted ? `선택한 폴더: ${handle.name} · 이 기기에서 기억해요.` : `‘${handle.name}’ 폴더에 접근하려면 ‘폴더 선택’을 눌러 다시 허용해 주세요.`
                : "현재는 Chrome 다운로드 폴더 설정을 사용해요.";
        } catch (_) {
            if (current === revision) status.textContent = "저장 폴더를 불러오지 못했어요. 폴더를 다시 선택해 주세요.";
        }
    }

    choose.addEventListener("click", async () => {
        if (busy || choose.disabled) return;
        // Browser-action popups close when focus moves to a system dialog. Use the full options tab.
        if (globalThis.chrome?.extension?.getViews?.({ type: "popup" }).includes(window)) {
            try {
                await chrome.tabs.create({ url: chrome.runtime.getURL("options.html#recording-folder") });
            } catch (_) {
                status.textContent = "확장 설정을 새 탭으로 열지 못했어요.";
            }
            return;
        }
        if (typeof window.showDirectoryPicker !== "function") {
            status.textContent = "이 브라우저는 폴더 선택을 지원하지 않아요. 아래 다운로드 폴더 설정을 이용해 주세요.";
            return;
        }
        busy = true;
        revision++;
        choose.disabled = clear.disabled = true;
        try {
            // Call before any await so the native picker retains this click's user activation.
            const handle = await window.showDirectoryPicker({ id: "cheese-spanner-recording", mode: "readwrite", startIn: selected || "downloads" });
            if (await handle.queryPermission({ mode: "readwrite" }) !== "granted") throw new Error("permission-denied");
            await directory.set(handle);
            await refresh();
        } catch (error) {
            if (error.name !== "AbortError") status.textContent = "폴더를 선택하지 못했어요. 폴더 접근을 허용한 뒤 다시 시도해 주세요.";
        } finally {
            busy = false;
            choose.disabled = clear.disabled = false;
        }
    });

    clear.addEventListener("click", async () => {
        if (busy || clear.disabled) return;
        busy = true;
        revision++;
        choose.disabled = clear.disabled = true;
        try {
            await directory.set(null);
            await refresh();
        } catch (_) {
            status.textContent = "저장 폴더를 변경하지 못했어요. 다시 시도해 주세요.";
        } finally {
            busy = false;
            choose.disabled = clear.disabled = false;
        }
    });

    function reveal() {
        if (location.hash !== "#recording-folder") return;
        document.querySelector('.tab[data-tab="player"]')?.click();
        const group = document.querySelector('[data-option-group="player-recorder"]');
        group.open = true;
        group.scrollIntoView?.({ block: "nearest" });
        choose.focus();
    }
    window.addEventListener("hashchange", reveal);
    window.addEventListener("focus", () => { if (!busy) void refresh(); });
    void refresh();
    reveal();
})();
