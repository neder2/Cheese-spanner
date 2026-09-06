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
                    title: "사이드바 숨김 기능 추가",
                    text: "확장 옵션의 ‘탐색 → 사이드바’에서 인기 카테고리, 다가오는 방송 일정, 파트너 스트리머, 서비스 바로가기를 골라 숨길 수 있어요.",
                },
                {
                    title: "멀티뷰 기능 추가",
                    text: "확장 옵션의 ‘플레이어 → 멀티뷰’에서 기능을 켜고 권한을 허용한 뒤 저장해 주세요. 격자 버튼에서 방송을 추가해 최대 6개 방송을 함께 볼 수 있어요.",
                },
                {
                    title: "멀티뷰 설정은 여기 있어요",
                    text: "멀티뷰를 켜면 채팅창 상단에 설정 버튼이 나타나요. 방송 추가, 배치 변경, 채널별 싱크 조절을 여기서 할 수 있어요.",
                },
            ].map(Object.freeze)
        ),
    });
})();
