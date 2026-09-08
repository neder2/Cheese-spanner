// This build's short feature guide. Refresh the steps together with release documentation.
(() => {
    function injectNotice(tabId) {
        return chrome.scripting.executeScript({
            target: { tabId },
            files: ["shared/updateGuide.js", "features/updateNotice.js"],
            world: "ISOLATED",
        });
    }

    async function previewInChzzkTab(tutorial = false) {
        if (!globalThis.chrome?.runtime?.id)
            return { ok: false, error: "확장 아이콘을 눌러 연 설정에서 실행해 주세요." };
        if (!chrome.scripting?.executeScript || !chrome.tabs?.query)
            return {
                ok: false,
                error: "안내 실행 권한이 없어요. 확장 관리에서 Better Chzzk를 다시 로드해 주세요.",
            };
        const tabs = await chrome.tabs.query({ url: "https://chzzk.naver.com/*" });
        const tab = tabs
            .filter(
                (entry) =>
                    Number.isInteger(entry.id) &&
                    !entry.discarded &&
                    /^https:\/\/chzzk\.naver\.com\//.test(entry.url || "")
            )
            .sort(
                (a, b) =>
                    Number(Boolean(b.active)) - Number(Boolean(a.active)) ||
                    (b.lastAccessed || 0) - (a.lastAccessed || 0)
            )[0];
        if (!tab) return { ok: false, error: "치지직 페이지를 먼저 열어 주세요." };
        await injectNotice(tab.id);
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "ISOLATED",
            func: (tutorial) =>
                (tutorial
                    ? globalThis.BetterChzzkUpdateNoticeRuntime?.showTutorial()
                    : globalThis.BetterChzzkUpdateNoticeRuntime?.showPreview()) === true,
            args: [tutorial],
        });
        if (!results.some((result) => result.result === true))
            return { ok: false, error: "치지직 페이지에 알림을 표시하지 못했어요." };
        await chrome.tabs.update(tab.id, { active: true });
        await chrome.windows.update(tab.windowId, { focused: true });
        return { ok: true };
    }

    globalThis.BetterChzzkUpdateGuide = Object.freeze({
        injectNotice,
        previewInChzzkTab,
        UPDATE_KEY: "betterchzzkUpdateNotice",
        READ_KEY: "betterchzzkUpdateReadVersion",
        NOTIFICATIONS_KEY: "updateNotificationsEnabled",
        RELOAD_GUIDE_KEY: "betterchzzkUpdateGuideAfterReload",
        steps: Object.freeze(
            [
                {
                    title: "광고 차단 기능 추가",
                    text: "광고 차단, 중간 광고 차단, 배너 광고 차단을 지원해요. 아직 실험적인 기능이라 불완전할 수 있어요.",
                },
            ].map(Object.freeze)
        ),
    });
})();
