/* Channel rules shared by options, page registration controls and the live-start service worker. */
(() => {
    const CHANNELS_KEY = "betterchzzk:live-start-channels";
    const STATE_KEY = "betterchzzk:live-start-state";
    const STATUS_KEY = "betterchzzk:live-start-status";
    const MAX_CHANNELS = 32;
    const CHANNEL_ID = /^[a-f0-9]{32}$/i;

    function parseChannelId(value) {
        const text = typeof value === "string" ? value.trim() : "";
        if (CHANNEL_ID.test(text)) return text.toLowerCase();
        try {
            const url = new URL(text);
            if (url.origin !== "https://chzzk.naver.com" || url.username || url.password) return "";
            return (
                url.pathname
                    .match(/^\/(?:live\/)?([a-f0-9]{32})(?:\/(?:videos|clips|community|about))?\/?$/i)?.[1]
                    .toLowerCase() || ""
            );
        } catch (_) {
            return "";
        }
    }

    function normalizeChannels(value) {
        const result = [];
        const seen = new Set();
        for (const item of Array.isArray(value) ? value.slice(0, MAX_CHANNELS) : []) {
            if (
                typeof item?.channelId !== "string" ||
                !CHANNEL_ID.test(item.channelId) ||
                seen.has(item.channelId.toLowerCase())
            )
                continue;
            const channelId = item.channelId.toLowerCase();
            const channelImageUrl = BetterChzzk.utils.normalizeChzzkImageUrl(item.channelImageUrl);
            seen.add(channelId);
            result.push({
                channelId,
                channelName: typeof item.channelName === "string" ? item.channelName.trim().slice(0, 100) : "",
                ...(channelImageUrl ? { channelImageUrl } : {}),
                notify: item.notify === true,
                autoOpen: item.autoOpen === true,
            });
        }
        return result;
    }

    function parseSnapshot(json, channelId) {
        const content = json?.content;
        if (json?.code !== 200 || content?.channel?.channelId !== channelId) return null;
        if (content.status !== "OPEN" && content.status !== "CLOSE") return null;
        if (!Number.isSafeInteger(content.liveId) || content.liveId <= 0) return null;
        return {
            liveId: String(content.liveId),
            open: content.status === "OPEN",
            title: typeof content.liveTitle === "string" ? content.liveTitle.trim().slice(0, 300) : "",
            channelName:
                typeof content.channel.channelName === "string" ? content.channel.channelName.trim().slice(0, 100) : "",
        };
    }

    globalThis.BetterChzzkLiveStart = Object.freeze({
        CHANNELS_KEY,
        STATE_KEY,
        STATUS_KEY,
        MAX_CHANNELS,
        parseChannelId,
        normalizeChannels,
        parseSnapshot,
    });
})();
