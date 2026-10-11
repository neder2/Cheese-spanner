/**
 * features/adblockPopupPage.js — 광고 차단 안내의 확인 버튼에 연결된 현재 React 콜백을 한 번 호출한다.
 *
 * 실행 컨텍스트: MAIN world, document_start. 옵션·관찰·표시 주기·재표시 한도는 isolated의 adblockPopup.js가 소유한다.
 * 하는 일: isolated가 확인 버튼에 동기 요청 이벤트를 보내면 실측한 안내(ad_blocking_info_layer)의 구조·문구·도움말과
 *   버튼·안내 노드의 현재 __reactProps$*를 다시 확인하고, onClick이 실측 형태(e => { e.isTrusted && setter(false) })일 때만
 *   { isTrusted: true } 인수로 한 번 호출한다. 브라우저의 신뢰된 클릭이 아니라 사이트 콜백의 입력 검사를 통과시키는 호출이다.
 *   감지·dab·재생 정보·전역 이벤트·React 내부와 body 스크롤은 바꾸지 않고, 닫힘 여부는 네이티브 제거로만 판단된다.
 *   isolated가 호출 전에 안내를 잠시 숨기므로 가시성·크기가 아니라 연결·문서 소속·구조·현재 콜백으로 판단한다.
 * 통신: betterchzzk:adblock-notice-confirm 요청 이벤트의 target, 호출했을 때만 event.preventDefault(),
 *   진단용 data-betterchzzk-adblock-notice-confirm 속성. 페이지가 보낸 함수명·선택자·코드는 받지 않는다.
 */
(() => {
    "use strict";

    const REQUEST_EVENT = "betterchzzk:adblock-notice-confirm";
    const READY_ATTR = "data-betterchzzk-adblock-notice-page-ready";
    const STATUS_ATTR = "data-betterchzzk-adblock-notice-confirm";
    const NOTICE_AREA = "ad_blocking_info_layer";
    const NOTICE = `[role="alertdialog"][aria-modal="true"][data-nlog-area="${NOTICE_AREA}"]`;
    const DIALOG = '[role="alertdialog"], [role="dialog"], [aria-modal="true"]';
    const BACKDROP = '[class^="_dimmed_"], [class*=" _dimmed_"]';
    const REACT_PROPS_PREFIX = "__reactProps$";
    // 2026-10-11 strings-ko_kr.json의 ad_block.title·description·confirm과 mX의 도움말 링크.
    const TITLE = "광고차단프로그램을사용중이신가요?";
    const DESCRIPTION =
        "광고차단프로그램사용시재생환경에영향을미칠수있으니사용중인확장프로그램이있다면,삭제후서비스를이용해주세요.";
    const CONFIRM = "확인";
    const HELP_URL = "https://help.naver.com/alias/navergame/chzzkars49.naver";
    const ROUTE = /^\/(?:live\/[^/]+|video\/\d+)\/?$/;
    // 2026-09-14·09-16·10-11 배포본의 라이브·다시보기 confirmHandler가 모두 이 형태였다.
    const HANDLER_SHAPE = /^([A-Za-z_$][\w$]*)=>\{\1\.isTrusted&&[A-Za-z_$][\w$]*\(!1\)\}$/;
    const functionToString = Function.prototype.toString;
    const invoked = new WeakSet();
    const counts = { invoked: 0, refused: 0 };

    const root = document.documentElement;
    if (root?.hasAttribute(READY_ATTR)) return;
    root?.setAttribute(READY_ATTR, "1");

    const compact = (value) =>
        String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");

    function findNotice(button) {
        if (
            !(button instanceof HTMLButtonElement) ||
            !button.isConnected ||
            button.ownerDocument !== document ||
            !ROUTE.test(location.pathname)
        )
            return null;
        const notice = button.closest(NOTICE);
        const backdrop = notice?.parentElement;
        if (
            !notice ||
            document.querySelectorAll(`[data-nlog-area="${NOTICE_AREA}"]`).length !== 1 ||
            !backdrop?.matches(BACKDROP) ||
            backdrop.parentElement !== document.body ||
            backdrop.children.length !== 1 ||
            backdrop.closest(DIALOG) ||
            notice.querySelector(DIALOG)
        )
            return null;
        const titles = notice.querySelectorAll("strong");
        const links = notice.querySelectorAll("a");
        const buttons = notice.querySelectorAll("button");
        const paragraphs = Array.from(notice.querySelectorAll("p"), (item) => compact(item.textContent));
        if (
            titles.length !== 1 ||
            compact(titles[0].textContent) !== TITLE ||
            !paragraphs.includes(DESCRIPTION) ||
            links.length !== 1 ||
            links[0].getAttribute("href") !== HELP_URL ||
            buttons.length !== 1 ||
            buttons[0] !== button ||
            compact(button.textContent) !== CONFIRM ||
            button.type !== "button" ||
            button.disabled ||
            button.getAttribute("aria-disabled") === "true"
        )
            return null;
        return notice;
    }

    function readProps(element) {
        const keys = Object.getOwnPropertyNames(element).filter((name) => name.startsWith(REACT_PROPS_PREFIX));
        // Two React copies on one node leave the owning callback ambiguous.
        if (keys.length !== 1) return null;
        const props = element[keys[0]];
        return props && typeof props === "object" ? { key: keys[0], props } : null;
    }

    function findConfirmHandler(button, notice) {
        const own = readProps(button);
        const container = readProps(notice);
        if (!own || !container || own.key !== container.key) return null;
        const { props } = own;
        if (
            container.props.role !== "alertdialog" ||
            container.props["data-nlog-area"] !== NOTICE_AREA ||
            props.type !== "button" ||
            props.disabled ||
            typeof props.onClick !== "function"
        )
            return null;
        let source;
        try {
            source = Reflect.apply(functionToString, props.onClick, []);
        } catch (_) {
            return null;
        }
        return HANDLER_SHAPE.test(source.replace(/\s+/g, "")) ? props.onClick : null;
    }

    function publish(status) {
        counts[status === "invoked" ? "invoked" : "refused"] += 1;
        root?.setAttribute(STATUS_ATTR, JSON.stringify({ status, ...counts }));
    }

    function handleRequest(event) {
        const button = event.target;
        let status = "refused";
        try {
            const notice = findNotice(button);
            const handler = notice && !invoked.has(button) ? findConfirmHandler(button, notice) : null;
            if (handler) {
                invoked.add(button);
                status = "error";
                // The measured handler reads only isTrusted; React and the event system stay untouched.
                handler(Object.freeze({ isTrusted: true }));
                status = "invoked";
                event.preventDefault();
            }
        } catch (_) {
            // A throwing page callback leaves the notice for manual confirmation.
        }
        publish(status);
    }

    document.addEventListener(REQUEST_EVENT, handleRequest, true);
})();
