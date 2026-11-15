/**
 * 워커 전용. 기존 치지직 문서의 팔로잉 폴더에 새 확장 연결이 필요할 때만 패키지 파일을 주입한다.
 */
(() => {
    "use strict";

    const SITE = "https://chzzk.naver.com/";
    const FILES = [
        "shared/settings.js",
        "shared/data.js",
        "shared/selectors.js",
        "content.js",
        "shared/uiTheme.js",
        "shared/followingFolders.js",
        "features/followingFolders.js",
    ];

    // Chrome이 실행할 함수라 외부 스코프에 의존하지 않아요.
    function needsFolderRuntime() {
        return (
            location.origin === "https://chzzk.naver.com" &&
            document.visibilityState === "visible" &&
            document.readyState === "complete" &&
            !globalThis.CheeseSpanner?.utils?.bindFeatureOptions
        );
    }

    function install(chrome) {
        const { scripting, tabs } = chrome;
        if (!scripting?.executeScript || !tabs?.onActivated) return;
        const { storageGet } = CheeseSpanner.utils;
        const pending = new Set();

        async function recover(tab) {
            const id = tab?.id;
            if (
                !Number.isInteger(id) ||
                id < 0 ||
                !tab.active ||
                tab.discarded ||
                tab.pendingUrl ||
                tab.status !== "complete" ||
                !tab.url?.startsWith(SITE) ||
                pending.has(id)
            )
                return;
            pending.add(id);
            try {
                const options = await storageGet(chrome.storage.sync, "followingFoldersEnabled");
                if (options.followingFoldersEnabled !== true) return;
                const [probe] = await scripting.executeScript({
                    target: { tabId: id, frameIds: [0] },
                    world: "ISOLATED",
                    injectImmediately: true,
                    func: needsFolderRuntime,
                });
                if (probe?.result !== true || probe.frameId !== 0 || !probe.documentId) return;
                // 활성화 확인 뒤 탭이 이동해도 확인했던 최상위 문서에만 주입해요.
                await scripting.executeScript({
                    target: { tabId: id, documentIds: [probe.documentId] },
                    world: "ISOLATED",
                    injectImmediately: true,
                    files: FILES,
                });
            } catch {
                // 탭 종료·이동·사이트 접근 제한 등으로 주입할 수 없으면 다음 활성화에서 다시 확인해요.
            } finally {
                pending.delete(id);
            }
        }

        function recoverActiveTab(query) {
            return tabs.query({ ...query, active: true, url: `${SITE}*` }).then(
                ([tab]) => recover(tab),
                () => {}
            );
        }

        tabs.onActivated.addListener(({ tabId }) => tabs.get(tabId).then(recover, () => {}));
        chrome.windows?.onFocusChanged?.addListener((windowId) => {
            if (windowId >= 0) return recoverActiveTab({ windowId });
        });
        chrome.runtime.onInstalled?.addListener(({ reason }) => {
            if (reason === "install" || reason === "update") return recoverActiveTab({ lastFocusedWindow: true });
        });
    }

    globalThis.CheeseSpannerFollowingFoldersRecovery = Object.freeze({ install });
})();
