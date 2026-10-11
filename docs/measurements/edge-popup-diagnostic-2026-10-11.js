// Console용 진단: 엣지·크롬에 남는 시청 방해 안내의 구조·문구·버튼과 치즈 스패너 상태를 읽어요.
// 안내가 떠 있는 /live/{채널} 화면에서 실행해요. 클릭·숨김·저장·요청을 하지 않고 화면만 읽어요.
(() => {
    "use strict";

    const clean = (value) =>
        String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    const describe = (element) => ({
        tag: element.tagName.toLowerCase(),
        cls: clean(element.getAttribute("class")),
        parent: clean(element.parentElement?.getAttribute("class")),
        role: element.getAttribute("role"),
        nlog: [element, ...element.querySelectorAll("[data-nlog-area]")]
            .map((item) => item.getAttribute("data-nlog-area"))
            .filter(Boolean),
        paragraphs: Array.from(element.querySelectorAll("p"), (item) => clean(item.textContent)),
        text: clean(element.textContent).slice(0, 300),
        buttons: Array.from(element.querySelectorAll("button"), (item) => ({
            text: clean(item.textContent),
            label: item.getAttribute("aria-label"),
        })),
    });
    const roots = new Set(
        document.querySelectorAll(
            '[class^="_dimmed_"], [class*=" _dimmed_"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], [class^="popup_container__"], [class*=" popup_container__"]'
        )
    );
    // 구조가 다른 안내도 찾도록 '설치'가 들어간 버튼에서 문단을 포함한 가까운 상위 요소를 함께 모아요.
    for (const button of document.querySelectorAll("button")) {
        if (!clean(button.textContent).includes("설치")) continue;
        let node = button;
        for (let depth = 0; depth < 4 && node.parentElement; depth++) {
            node = node.parentElement;
            if (node.querySelector("p")) break;
        }
        roots.add(node);
    }
    console.log(
        JSON.stringify(
            {
                path: location.pathname,
                ua: navigator.userAgent,
                guide: document.documentElement.getAttribute("data-betterchzzk-auto-quality-guide"),
                popups: Array.from(roots, describe),
            },
            null,
            2
        )
    );
})();
