/* Short, replayable guide in the extension popup and options page. */
(() => {
    const { UPDATE_KEY, READ_KEY, NOTIFICATIONS_KEY, steps } = globalThis.BetterChzzkUpdateGuide;
    const version = globalThis.chrome?.runtime?.getManifest?.()?.version;
    const storage = globalThis.chrome?.storage?.local;
    const notice = document.getElementById("updateNotice");
    const dialog = document.getElementById("featureGuide");
    const next = document.getElementById("guideNext");
    const previous = document.getElementById("guidePrevious");
    const finish = document.getElementById("guideFinish");
    const error = document.getElementById("guideError");
    let index = 0;
    let saving = false;
    let loadGeneration = 0;

    function loadNotice() {
        if (!storage || !version) return;
        const generation = ++loadGeneration;
        storage.get([UPDATE_KEY, READ_KEY], (data) => {
            const failed = BetterChzzkSettings.getStorageLastError();
            if (failed || generation !== loadGeneration) return;
            chrome.storage.sync.get(NOTIFICATIONS_KEY, (options) => {
                const failed = BetterChzzkSettings.getStorageLastError();
                if (failed || generation !== loadGeneration) return;
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

    function renderStep() {
        document.getElementById("guideTitle").textContent = steps[index].title;
        document.getElementById("guideText").textContent = steps[index].text;
        document.getElementById("guideProgress").textContent = `${index + 1} / ${steps.length}`;
        previous.disabled = index === 0;
        next.disabled = index === steps.length - 1;
        finish.hidden = index !== steps.length - 1;
        error.hidden = true;
    }

    function openGuide() {
        index = 0;
        renderStep();
        if (!dialog.open) dialog.showModal();
        next.focus();
    }

    function closeGuide() {
        dialog.close();
    }

    function completeGuide() {
        if (saving) return;
        if (!storage || !version) {
            closeGuide();
            return;
        }
        saving = true;
        finish.disabled = true;
        storage.set({ [READ_KEY]: version }, () => {
            const failed = BetterChzzkSettings.getStorageLastError();
            saving = false;
            finish.disabled = false;
            if (failed) {
                error.textContent = "확인 상태를 저장하지 못했어요. 다시 눌러 주세요.";
                error.hidden = false;
                return;
            }
            notice.hidden = true;
            closeGuide();
        });
    }

    document.getElementById("guideOpen").addEventListener("click", openGuide);
    document.getElementById("guideReplay").addEventListener("click", openGuide);
    const replayButton = document.getElementById("guideTutorialReplay");
    replayButton.addEventListener("click", async () => {
        const status = document.getElementById("guideTutorialStatus");
        replayButton.disabled = true;
        status.hidden = false;
        status.textContent = "치지직 페이지에서 튜토리얼을 여는 중이에요.";
        try {
            const result = await globalThis.BetterChzzkUpdateGuide.previewInChzzkTab(true);
            status.textContent = result?.ok
                ? "치지직 페이지에서 튜토리얼을 시작했어요."
                : result?.error || "튜토리얼 표시를 확인하지 못했어요.";
        } catch (error) {
            status.textContent = `튜토리얼을 열지 못했어요. ${error?.message || "확장을 다시 로드한 뒤 시도해 주세요."}`;
        } finally {
            replayButton.disabled = false;
        }
    });
    document.getElementById("guideClose").addEventListener("click", closeGuide);
    document.getElementById("guideLater").addEventListener("click", closeGuide);
    previous.addEventListener("click", () => {
        if (index > 0) index--;
        renderStep();
    });
    next.addEventListener("click", () => {
        if (index < steps.length - 1) {
            index++;
            renderStep();
        }
    });
    finish.addEventListener("click", completeGuide);

    const onStorageChanged = (changes, area) => {
        if (area === "sync" && Object.hasOwn(changes, NOTIFICATIONS_KEY)) loadNotice();
        if (area === "local" && (Object.hasOwn(changes, UPDATE_KEY) || Object.hasOwn(changes, READ_KEY))) loadNotice();
    };
    globalThis.chrome?.storage?.onChanged?.addListener(onStorageChanged);
    window.addEventListener("pagehide", () => globalThis.chrome?.storage?.onChanged?.removeListener(onStorageChanged));
    loadNotice();
})();
