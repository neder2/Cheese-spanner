// 옵션 화면의 명시적 다시보기만 처리한다. 자동 표시와 기록 쓰기는 워커 소유다.
(() => {
    "use strict";
    const button = document.getElementById("updateGuideReplay");
    const status = document.getElementById("updateGuideStatus");
    const catalog = globalThis.CheeseSpannerUpdateGuide;
    if (!button || !catalog || button.dataset.bcugBound) return;
    button.dataset.bcugBound = "1";
    let guide;
    try {
        guide = catalog.getGuide(globalThis.chrome?.runtime?.getManifest?.().version);
    } catch (_) {
        guide = null;
    }
    if (!guide) {
        button.disabled = true;
        status.textContent = "이 버전의 새 기능 안내 없음. 변경 내용은 릴리즈 노트에서 확인.";
        return;
    }
    let busy = false;
    let closed = false;
    const call = (operation) =>
        new Promise((resolve, reject) => {
            operation((value) => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(value);
            });
        });
    function showStatus(message) {
        if (!closed) status.textContent = message;
    }
    function chzzkTab(tab) {
        if (!Number.isInteger(tab?.id) || tab.id < 0) return false;
        try {
            const url = new URL(tab.url);
            return url.origin === "https://chzzk.naver.com" && !url.username && !url.password;
        } catch (_) {
            return false;
        }
    }
    button.addEventListener("click", async () => {
        if (busy || closed) return;
        busy = true;
        button.disabled = true;
        showStatus("치지직 화면에서 안내 여는 중");
        try {
            // Only an action popup has no owning tab. A normal options tab never selects another tab.
            if (!globalThis.chrome?.tabs?.getCurrent || !chrome.tabs.query || !chrome.tabs.sendMessage) {
                showStatus("치지직 탭에서 확장 아이콘을 열고 다시 시도");
                return;
            }
            const ownTab = await call((done) => chrome.tabs.getCurrent(done));
            if (closed) return;
            if (ownTab) {
                showStatus("치지직 탭에서 확장 아이콘을 열고 다시 시도");
                return;
            }
            const tabs = await call((done) => chrome.tabs.query({ active: true, currentWindow: true }, done));
            if (closed) return;
            const tab = Array.isArray(tabs) && tabs.length === 1 ? tabs[0] : null;
            if (!chzzkTab(tab)) {
                showStatus("치지직 화면을 연 뒤 다시 시도");
                return;
            }
            const reply = await call((done) =>
                chrome.tabs.sendMessage(
                    tab.id,
                    {
                        type: catalog.MESSAGE_TYPE,
                        protocol: catalog.PROTOCOL,
                        action: "replay",
                        guideVersion: guide.version,
                    },
                    { frameId: 0 },
                    done
                )
            );
            if (closed) return;
            if (reply?.ok !== true) {
                showStatus("안내 열기 실패. 전체 화면을 종료하고 치지직 화면 새로고침 후 다시 시도.");
                return;
            }
            showStatus("치지직 화면에 안내 표시. 설정창을 닫아도 유지.");
            if (document.getElementById("notice")?.dataset.state === "saved") window.close();
        } catch (_) {
            showStatus("치지직 화면 연결 실패. 페이지 새로고침 후 다시 시도.");
        } finally {
            busy = false;
            if (!closed) button.disabled = false;
        }
    });
    window.addEventListener(
        "pagehide",
        () => {
            closed = true;
        },
        { once: true }
    );
})();
