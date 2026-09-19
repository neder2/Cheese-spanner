/** Read-only bridge for the live chatMessage shape measured on 2026-09-19. */
(() => {
    "use strict";

    const REQUEST_EVENT = "betterchzzk:watch-activity-source";
    const READY_EVENT = "betterchzzk:watch-activity-ready";
    const SOURCE_ATTR = "data-bcwa-source";
    const USER_ATTR = "data-bcwa-user";
    const ROW_SELECTOR = "aside#aside-chatting [role='log'] > [class*='_wrapper_'] > [class*='_item_']";
    const READY_ATTR = "data-betterchzzk-watch-activity-page-ready";
    if (document.documentElement?.hasAttribute(READY_ATTR)) return;
    document.documentElement?.setAttribute(READY_ATTR, "1");

    document.addEventListener(
        REQUEST_EVENT,
        (event) => {
            const row = event.target;
            if (!(row instanceof Element)) return;
            row.removeAttribute(SOURCE_ATTR);
            if (!/^\/live\/[^/]+/.test(location.pathname) || !row.matches(ROW_SELECTOR)) return;
            const user = row.getAttribute(USER_ATTR);
            if (!user || !/^[A-Za-z0-9_-]{1,128}$/.test(user)) return;

            for (const key of Object.getOwnPropertyNames(row)) {
                if (!key.startsWith("__reactProps$")) continue;
                try {
                    const message = row[key]?.children?.props?.chatMessage;
                    if (!message || message.user !== user || message.status !== "NORMAL") continue;
                    if (!Number.isSafeInteger(message.time) || message.time < Date.UTC(2020, 0, 1)) continue;
                    if (message.time > Date.now() + 5 * 60 * 1000) continue;
                    let kind;
                    let amount = 0;
                    if (message.type === 1) kind = "chat";
                    else if (
                        message.type === 10 &&
                        message.extras?.donationType === "CHAT" &&
                        message.extras.isAnonymous !== true &&
                        message.user !== "anonymous" &&
                        Number.isSafeInteger(message.extras.payAmount) &&
                        message.extras.payAmount > 0
                    ) {
                        kind = "donation";
                        amount = message.extras.payAmount;
                    } else continue;
                    // Confirmed CHAT donations can omit content; their amount is independent of the message.
                    const text = kind === "donation" ? (message.originalContent ?? "") : message.originalContent;
                    if (typeof text !== "string") continue;
                    row.setAttribute(
                        SOURCE_ATTR,
                        JSON.stringify({
                            id: `${user}:${message.time}:${message.type}`,
                            at: message.time,
                            kind,
                            text: text.slice(0, 400),
                            amount,
                        })
                    );
                    return;
                } catch (_) {
                    // A React row can be detached or replaced during a synchronous request.
                }
            }
        },
        true
    );
    window.dispatchEvent(new Event(READY_EVENT));
})();
