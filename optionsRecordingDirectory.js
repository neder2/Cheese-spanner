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

    function releaseControls() {
        busy = false;
        delete choose.dataset.pickerBusy;
        delete clear.dataset.pickerBusy;
        const enabled = document.querySelector('[data-option="videoRecorderEnabled"]');
        choose.disabled = clear.disabled = enabled.disabled || !enabled.checked;
    }

    async function refresh() {
        const current = ++revision;
        try {
            const handle = await directory.get();
            const granted = handle && (await handle.queryPermission({ mode: "readwrite" })) === "granted";
            if (current !== revision) return;
            selected = handle;
            clear.hidden = !handle;
            downloads.hidden = Boolean(handle);
            status.textContent = handle
                ? granted
                    ? `저장 폴더: ${handle.name} · 이 기기에서 기억`
                    : `‘${handle.name}’ 폴더 접근 권한 필요. ‘폴더 선택’에서 다시 허용.`
                : "현재 Chrome 다운로드 폴더 설정 사용 중";
        } catch (_) {
            if (current === revision) status.textContent = "저장 폴더 불러오기 실패. 폴더 다시 선택.";
        }
    }

    choose.addEventListener("click", async () => {
        if (busy || choose.disabled) return;
        // Browser-action popups close when focus moves to a system dialog. Use the full options tab.
        if (globalThis.chrome?.extension?.getViews?.({ type: "popup" }).includes(window)) {
            try {
                await chrome.tabs.create({ url: chrome.runtime.getURL("options.html#recording-folder") });
            } catch (_) {
                status.textContent = "확장 설정을 새 탭으로 열지 못함";
            }
            return;
        }
        if (typeof window.showDirectoryPicker !== "function") {
            status.textContent = "이 브라우저에서 폴더 선택 불가. 아래 다운로드 폴더 설정 사용.";
            return;
        }
        busy = true;
        choose.dataset.pickerBusy = clear.dataset.pickerBusy = "true";
        revision++;
        choose.disabled = clear.disabled = true;
        try {
            // Call before any await so the native picker retains this click's user activation.
            const handle = await window.showDirectoryPicker({
                id: "cheese-spanner-recording",
                mode: "readwrite",
                startIn: selected || "downloads",
            });
            if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted")
                throw new Error("permission-denied");
            await directory.set(handle);
            await refresh();
        } catch (error) {
            if (error.name !== "AbortError") status.textContent = "폴더 선택 실패. 폴더 접근을 허용한 뒤 다시 시도.";
        } finally {
            releaseControls();
        }
    });

    clear.addEventListener("click", async () => {
        if (busy || clear.disabled) return;
        busy = true;
        choose.dataset.pickerBusy = clear.dataset.pickerBusy = "true";
        revision++;
        choose.disabled = clear.disabled = true;
        try {
            await directory.set(null);
            await refresh();
        } catch (_) {
            status.textContent = "저장 폴더 변경 실패. 다시 시도.";
        } finally {
            releaseControls();
        }
    });

    function reveal() {
        if (location.hash !== "#recording-folder") return;
        globalThis.CheeseSpannerOptionsNavigation.showGuideTarget("recording");
    }
    window.addEventListener("hashchange", reveal);
    window.addEventListener("focus", () => {
        if (!busy) void refresh();
    });
    void refresh();
    reveal();
})();
