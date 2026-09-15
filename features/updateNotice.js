// 공지 형식 보관용. 현재 manifest와 background에서는 로드하지 않는다.
// 다음 공지에서 재사용할 때 본문·버전과 표시 조건을 함께 갱신한다.
(() => {
    const FLAG = "__betterChzzkQualityUpdateNotice";
    const KEY = "betterchzzk:quality-update-notice";
    const ID = "betterchzzk-quality-update-notice";
    if (location.origin !== "https://chzzk.naver.com" || window.top !== window) return;
    if (typeof window[FLAG] === "function") {
        window[FLAG]();
        return;
    }
    let inFlight = false;
    const cleanup = () => {
        document.removeEventListener("visibilitychange", check);
        document.removeEventListener("DOMContentLoaded", check);
    };
    function release(token, resumeWhenVisible = false) {
        chrome.runtime.sendMessage({ type: KEY, action: "release", token }, () => {
            const error = chrome.runtime.lastError;
            if (error || !resumeWhenVisible) return;
            document.addEventListener("visibilitychange", check);
            if (!document.hidden) check();
        });
    }
    function show(notice) {
        const style = document.createElement("style");
        style.textContent = `
#${ID}{--bcqn-bg:#fff;--bcqn-text:#202124;--bcqn-border:#dce0e5;box-sizing:border-box;width:calc(100% - 32px);max-width:440px;max-height:calc(100% - 32px);padding:24px;margin:auto;border:1px solid var(--sem-color-border-neutral-weak,var(--Border-Neutral-Weak,var(--bcqn-border)));border-radius:16px;background:var(--sem-color-surface-neutral-base,var(--Surface-Neutral-Base,var(--bcqn-bg)));color:var(--sem-color-content-neutral-cool-strong,var(--Content-Neutral-Cool-Strong,var(--bcqn-text)));font:14px/1.65 system-ui,sans-serif;word-break:keep-all;overflow-wrap:anywhere;box-shadow:0 16px 48px #0003}
#${ID}::backdrop{background:rgba(0,0,0,.5)}
#${ID}[open]{animation:bcqn-enter-hop 680ms ease-in-out 1}
@keyframes bcqn-enter-hop{0%,50%,100%{transform:translateY(0)}25%{transform:translateY(-8px)}75%{transform:translateY(-3px)}}
#${ID} h2{margin:0 0 14px;font-size:20px;line-height:1.4;color:inherit}
#${ID} p{margin:10px 0}
#${ID} .bcqn-actions{display:flex;justify-content:flex-end;margin-top:20px}
#${ID} button{min-width:84px;min-height:40px;padding:8px 20px;border:0;border-radius:8px;background:#00e693;color:#111;font:600 14px/1.5 system-ui,sans-serif;cursor:pointer}
#${ID} button:focus-visible{outline:2px solid var(--sem-color-content-neutral-cool-strong,var(--Content-Neutral-Cool-Strong,var(--bcqn-text)));outline-offset:3px}
@media(prefers-color-scheme:dark){#${ID}{--bcqn-bg:#242629;--bcqn-text:#e7e9ec;--bcqn-border:#44484d}}
@media(prefers-reduced-motion:reduce){#${ID}[open]{animation:none}}
`;
        const dialog = document.createElement("dialog");
        dialog.id = ID;
        dialog.setAttribute("aria-labelledby", `${ID}-title`);
        dialog.setAttribute("aria-describedby", `${ID}-body`);
        const title = document.createElement("h2");
        title.id = `${ID}-title`;
        title.textContent = "중요!!! 공지";
        const body = document.createElement("div");
        body.id = `${ID}-body`;
        for (const text of [
            "팝업같은 거 띄워서 죄송합니다. 꼭 읽어주세요.",
            "기존 그리드 우회 방식은 치지직의 재생 정보를 변경하므로, 서비스·소프트웨어의 수정·변형을 제한하는 네이버 이용약관에 저촉될 소지가 있습니다. 배포와 지원을 계속하기 어렵다고 판단해 기존 방식의 지원을 종료했습니다.",
            "비슷한 이유로 확장 프로그램 이름도 변경했습니다.",
            "화질 고정 기능을 강화하고, 시청에 방해되는 팝업을 제거하도록 개선했습니다.",
            "팝업 제거는 설정의 ‘시청 방해 팝업 제거’에서 조절할 수 있습니다.",
            "현재 화질 고정 기능은 설치된 그리드 프로그램의 사용을 차단하지 않습니다.",
            "열려 있던 치지직 탭은 새로고침하면 새 방식이 적용됩니다.",
        ]) {
            const paragraph = document.createElement("p");
            paragraph.textContent = text;
            body.append(paragraph);
        }
        const actions = document.createElement("div");
        actions.className = "bcqn-actions";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "확인";
        actions.append(button);
        dialog.append(title, body, actions);
        const previousFocus = document.activeElement;
        const remove = () => {
            dialog.remove();
            style.remove();
            if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
        };
        button.addEventListener("click", () => dialog.close());
        dialog.addEventListener("close", remove, { once: true });
        document.head.append(style);
        document.body.append(dialog);
        try {
            dialog.showModal();
            button.focus();
        } catch (_) {
            remove();
            release(notice.token);
        }
    }
    function check() {
        if (!document.body || document.hidden || inFlight || document.getElementById(ID)) return;
        inFlight = true;
        chrome.storage.local.get([KEY], (data) => {
            if (chrome.runtime.lastError || data?.[KEY]?.pending !== true) {
                inFlight = false;
                cleanup();
                return;
            }
            chrome.runtime.sendMessage({ type: KEY, action: "claim" }, (notice) => {
                const error = chrome.runtime.lastError;
                inFlight = false;
                cleanup();
                if (error || !notice?.show || notice.version !== "1.3.7") return;
                if (document.hidden || !document.body) {
                    release(notice.token, true);
                    return;
                }
                show(notice);
            });
        });
    }
    window[FLAG] = check;
    document.addEventListener("visibilitychange", check);
    document.addEventListener("DOMContentLoaded", check, { once: true });
    check();
})();
