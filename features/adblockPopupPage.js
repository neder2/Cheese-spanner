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
    const POPUP =
        '[role="alertdialog"], [role="dialog"], [aria-modal="true"], [class^="popup_container__"], [class*=" popup_container__"]';
    const BACKDROP = '[class^="_dimmed_"], [class*=" _dimmed_"]';
    const REACT_PROPS_PREFIX = "__reactProps$";
    // 2026-10-11·10-17 안내의 식별자·도움말과 의미를 유지하며 조사·문장 분리만 허용한다.
    const NOTICE_TITLE = /^광고차단프로그램(?:을)?사용(?:중이신가요|중인가요|하시나요|하고계신가요)[?？.!。！]*$/;
    const NOTICE_DESCRIPTION = [
        "광고차단프로그램",
        "사용",
        "재생환경",
        "영향",
        "확장프로그램",
        "삭제",
        "서비스",
        "이용",
    ];
    const NOTICE_HEADINGS = "strong, h1, h2, h3, h4, h5, h6, [role=heading]";
    const CONFIRM = "확인";
    const HELP_URL = "https://help.naver.com/alias/navergame/chzzkars49.naver";
    const ROUTE = /^\/(?:live\/[^/]+|video\/\d+)\/?$/;
    // 2026-09-14·09-16·10-11·10-17의 단일 신뢰 조건·false 호출 의미만 허용한다.
    const HANDLER_ARROW = /^(?:([A-Za-z_$][\w$]*)|\(([A-Za-z_$][\w$]*)\))=>(.+)$/;
    const functionToString = Function.prototype.toString;
    const invoked = new WeakSet();
    const counts = { invoked: 0, refused: 0 };

    const root = document.documentElement;
    if (root?.hasAttribute(READY_ATTR)) return;
    root?.setAttribute(READY_ATTR, "1");

    const normalizeCompact = (value) =>
        String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");

    // Keep this target validation identical to the isolated helper; no marker grants trust.
    function hasOnlyNoticeChild(parent, child) {
        return (
            parent?.children.length === 1 &&
            parent.firstElementChild === child &&
            Array.from(parent.childNodes).every((node) => node === child || !node.textContent.trim())
        );
    }

    function isNoticeWrapper(parent, child) {
        return (
            parent?.tagName === "DIV" &&
            !parent.matches(POPUP) &&
            !["role", "data-nlog-area", "tabindex", "contenteditable"].some((name) => parent.hasAttribute(name)) &&
            hasOnlyNoticeChild(parent, child)
        );
    }

    function findNoticeBackdrop(popup) {
        let child = popup;
        let backdrop = child.parentElement;
        for (let depth = 0; depth < 2 && !backdrop?.matches(BACKDROP); depth++) {
            if (!isNoticeWrapper(backdrop, child)) return null;
            child = backdrop;
            backdrop = child.parentElement;
        }
        if (!backdrop?.matches(BACKDROP) || backdrop.matches(POPUP) || !hasOnlyNoticeChild(backdrop, child))
            return null;
        child = backdrop;
        for (let depth = 0; depth < 2 && child.parentElement !== document.body; depth++) {
            if (!isNoticeWrapper(child.parentElement, child)) return null;
            child = child.parentElement;
        }
        return child.parentElement === document.body ? backdrop : null;
    }

    function hasNoticeCopy(popup) {
        const titles = Array.from(popup.querySelectorAll(NOTICE_HEADINGS)).filter(
            (node) => !node.parentElement.closest(NOTICE_HEADINGS)
        );
        if (titles.length !== 1 || !NOTICE_TITLE.test(normalizeCompact(titles[0].textContent))) return false;
        const text = Array.from(popup.querySelectorAll("p"), (node) => normalizeCompact(node.textContent)).join("");
        if (text.length > 1000) return false;
        let position = 0;
        return NOTICE_DESCRIPTION.every((anchor) => {
            const index = text.indexOf(anchor, position);
            if (index < 0) return false;
            position = index + anchor.length;
            return true;
        });
    }

    function findNotice(button) {
        if (
            !(button instanceof HTMLButtonElement) ||
            !button.isConnected ||
            button.ownerDocument !== document ||
            !ROUTE.test(location.pathname)
        )
            return null;
        const notice = button.closest(NOTICE);
        if (
            !notice ||
            document.querySelectorAll(`[data-nlog-area="${NOTICE_AREA}"]`).length !== 1 ||
            !findNoticeBackdrop(notice) ||
            notice.querySelector(POPUP)
        )
            return null;
        const links = notice.querySelectorAll("a");
        const buttons = notice.querySelectorAll("button");
        if (
            !hasNoticeCopy(notice) ||
            links.length !== 1 ||
            links[0].getAttribute("href") !== HELP_URL ||
            buttons.length !== 1 ||
            buttons[0] !== button ||
            normalizeCompact(button.textContent) !== CONFIRM ||
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

    function isConfirmHandler(source) {
        if (source.length > 512) return false;
        const arrow = HANDLER_ARROW.exec(source.replace(/\s+/g, ""));
        if (!arrow) return false;
        const parameter = (arrow[1] || arrow[2]).replace(/\$/g, "\\$");
        const condition = `(?:${parameter}\\.isTrusted|\\(${parameter}\\.isTrusted\\))`;
        const value = "(?:false|!1|\\((?:false|!1)\\))";
        const call = `[A-Za-z_$][\\w$]*\\(${value}\\)`;
        const body = arrow[3];
        if (!body.startsWith("{")) return new RegExp(`^${condition}&&${call}$`).test(body);
        if (!body.endsWith("}")) return false;
        // No return, assignment, member call, second statement, else or other event property is accepted.
        const statement = `${condition}&&${call};?|if\\(${condition}\\)(?:${call};?|\\{${call};?\\})`;
        return new RegExp(`^(?:${statement})$`).test(body.slice(1, -1));
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
        return isConfirmHandler(source) ? props.onClick : null;
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
