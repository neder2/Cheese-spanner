/* Shared update state and notice injection. */
(() => {
    function injectNotice(tabId) {
        return chrome.scripting.executeScript({
            target: { tabId },
            files: ["shared/updateNotice.js", "features/updateNotice.js"],
            world: "ISOLATED",
        });
    }
    globalThis.BetterChzzkUpdateNotice = Object.freeze({
        injectNotice,
        UPDATE_KEY: "betterchzzkUpdateNotice",
        READ_KEY: "betterchzzkUpdateReadVersion",
        NOTIFICATIONS_KEY: "updateNotificationsEnabled",
    });
})();
