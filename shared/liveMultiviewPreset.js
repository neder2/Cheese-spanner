/** 사용자가 직접 저장한 라이브 멀티뷰 채널 목록 한 개. 서비스 워커 전용. */
(() => {
    const TYPE = "cheese-spanner:live-multiview-preset";
    const KEY = "cheese-spanner:live-multiview-preset:v1";
    const FIELDS = {
        list: ["type", "route", "action"],
        save: ["type", "route", "action", "expected", "channels"],
        delete: ["type", "route", "action", "expected"],
    };
    function channels(value) {
        if (!Array.isArray(value) || !value.length || value.length > 6) return null;
        const seen = new Set();
        const result = [];
        for (const item of value) {
            if (
                !item ||
                typeof item !== "object" ||
                Array.isArray(item) ||
                Object.keys(item).length !== 2 ||
                !Object.hasOwn(item, "id") ||
                !Object.hasOwn(item, "name") ||
                typeof item.id !== "string" ||
                !/^[0-9a-f]{32}$/.test(item.id) ||
                seen.has(item.id) ||
                typeof item.name !== "string" ||
                item.name.length > 2 * globalThis.CheeseSpannerChatMultiview.MAX_NAME_LENGTH ||
                item.name !== globalThis.CheeseSpannerChatMultiview.normalizeChannelName(item.name)
            )
                return null;
            seen.add(item.id);
            result.push({ id: item.id, name: item.name });
        }
        return result;
    }
    function createController(chrome) {
        let queue = Promise.resolve();
        function handle(message, sender) {
            if (
                !CheeseSpannerSettings.isChzzkTopFrameSender(sender, chrome.runtime.id) ||
                message?.type !== TYPE ||
                typeof message.action !== "string" ||
                !Object.hasOwn(FIELDS, message.action) ||
                !FIELDS[message.action].every((field) => Object.hasOwn(message, field)) ||
                Object.keys(message).length !== FIELDS[message.action].length ||
                typeof message.route !== "string" ||
                !/^[0-9a-f]{32}$/.test(message.route || "")
            )
                return Promise.resolve({ ok: false });
            try {
                const url = new URL(sender.tab.url || sender.url);
                if (
                    url.origin !== "https://chzzk.naver.com" ||
                    url.username ||
                    url.password ||
                    url.pathname.replace(/\/$/, "") !== "/live/" + message.route
                )
                    return Promise.resolve({ ok: false });
            } catch {
                return Promise.resolve({ ok: false });
            }
            const action = message.action;
            const next = action === "save" ? channels(message.channels) : null;
            const expected = message.expected === null ? null : channels(message.expected);
            if (
                (action === "save" && !next) ||
                (action !== "list" && expected === null && message.expected !== null) ||
                (action === "delete" && !expected)
            )
                return Promise.resolve({ ok: false });
            async function run() {
                const area = chrome.storage?.local;
                if (!area) return { ok: false };
                const u = CheeseSpanner.utils;
                const stored = await u.storageGet(area, KEY);
                const saved = Object.hasOwn(stored, KEY) ? channels(stored[KEY]) : null;
                if (!saved && Object.hasOwn(stored, KEY)) return { ok: false };
                if (action === "list") return { ok: true, saved };
                if (JSON.stringify(expected) !== JSON.stringify(saved)) return { ok: false, conflict: true };
                if (action === "delete") await u.storageRemove(area, KEY);
                else if (JSON.stringify(next) !== JSON.stringify(saved)) await u.storageSet(area, { [KEY]: next });
                return { ok: true, saved: next };
            }
            const task = queue.then(run).catch(() => ({ ok: false }));
            queue = task;
            return task;
        }
        return { handle };
    }
    globalThis.CheeseSpannerLiveMultiviewPreset = { TYPE, createController };
})();
