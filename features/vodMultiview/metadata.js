(() => {
    "use strict";

    const { fetchJson, parseChzzkDate, normalizeChzzkImageUrl } = CheeseSpanner.utils;
    const api = "https://api.chzzk.naver.com/service";
    const detailUrl = `${api}/v3/videos/`;
    // 분할 가능성이 있는 응답은 방송 시작일만으로 구간의 첫 프레임을 확정할 수 없다.
    const splitDurationFloor = 17 * 3600 - 120;
    const videoNoPattern = /^[1-9]\d{0,14}$/;
    const mediaIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
    const mediaKeyPattern = /^[A-Za-z0-9_-]{1,512}$/;
    const channelIdPattern = /^[a-f0-9]{32}$/i;
    const pageSize = 30;
    const maxDetails = 30;

    function videoNoFromUrl(value) {
        if (typeof value !== "string" || value.length > 2048) return "";
        try {
            const url = new URL(value.trim());
            if (url.origin !== "https://chzzk.naver.com" || url.username || url.password) return "";
            const videoNo = /^\/video\/([^/]+)\/?$/.exec(url.pathname)?.[1];
            return videoNoPattern.test(videoNo) ? videoNo : "";
        } catch {
            return "";
        }
    }

    function getTimeline(detail) {
        const startMs = parseChzzkDate(detail.liveOpenDate)?.getTime();
        const duration = detail.duration;
        if (
            !Number.isFinite(startMs) ||
            startMs <= 0 ||
            !Number.isFinite(duration) ||
            duration <= 0 ||
            duration >= splitDurationFloor ||
            Number(detail.nextVideo?.duration) >= splitDurationFloor
        )
            return null;

        const endMs = startMs + duration * 1000;
        const declaredEndMs = parseChzzkDate(detail.liveEndDate)?.getTime();
        if (
            (detail.liveEndDate && (!Number.isFinite(declaredEndMs) || Math.abs(endMs - declaredEndMs) > 2000)) ||
            (detail.nextVideo?.liveOpenDate && detail.nextVideo.liveOpenDate === detail.liveOpenDate)
        )
            return null;

        return { startMs, endMs, duration };
    }

    function readVideo(response, videoNo, needsKey) {
        const detail = response?.content;
        if (response?.code === 401 || response?.code === 403) return { status: "restricted" };
        if (response?.code !== 200 || String(detail?.videoNo) !== videoNo) return { status: "lookup-error" };
        if (
            detail.adult ||
            (detail.blindType != null && detail.blindType !== "NONE") ||
            detail.membershipBenefitType === "MEMBER_ONLY" ||
            detail.naverOnly ||
            detail.dab
        )
            return { status: "restricted" };
        if (
            detail.videoType !== "REPLAY" ||
            detail.vodStatus !== "ABR_HLS" ||
            detail.liveRewindPlaybackJson != null ||
            typeof detail.videoId !== "string" ||
            !mediaIdPattern.test(detail.videoId) ||
            !channelIdPattern.test(detail.channel?.channelId || "") ||
            (detail.encryptionType != null && detail.encryptionType !== "NONE" && detail.encryptionType !== "AES")
        )
            return { status: "unsupported" };
        if (needsKey && (typeof detail.inKey !== "string" || !mediaKeyPattern.test(detail.inKey)))
            return { status: "restricted" };

        const timeline = getTimeline(detail);
        if (!timeline) return { status: "unknown-time" };
        return {
            status: "ok",
            media: { videoNo, id: detail.videoId, ...timeline },
            ...(needsKey && { key: detail.inKey, aes: detail.encryptionType === "AES" }),
            channelId: detail.channel.channelId,
            channelName: typeof detail.channel.channelName === "string" ? detail.channel.channelName.slice(0, 100) : "",
            title: typeof detail.videoTitle === "string" ? detail.videoTitle.trim().slice(0, 200) : "",
        };
    }

    async function loadVideo(videoNo, { signal, needsKey = false }) {
        if (!videoNoPattern.test(videoNo)) return { status: "lookup-error" };
        try {
            return readVideo(await fetchJson(detailUrl + videoNo, { signal }), videoNo, needsKey);
        } catch (error) {
            if (signal?.aborted) throw error;
            return { status: /^HTTP (401|403)$/.test(error?.message) ? "restricted" : "lookup-error" };
        }
    }

    async function searchChannels(keyword, { signal }) {
        const params = new URLSearchParams({ keyword, offset: "0", size: "5", withFirstChannelContent: "false" });
        const response = await fetchJson(`${api}/v1/search/channels?${params}`, { signal });
        if (response?.code !== 200 || !Array.isArray(response.content?.data)) throw new Error("Invalid channel search");
        const results = new Map();
        for (const item of response.content.data.slice(0, 5)) {
            const channel = item?.channel;
            if (!channelIdPattern.test(channel?.channelId || "") || typeof channel.channelName !== "string") continue;
            const name = channel.channelName.trim().slice(0, 100);
            if (name && !results.has(channel.channelId))
                results.set(channel.channelId, {
                    id: channel.channelId,
                    name,
                    image: normalizeChzzkImageUrl(channel.channelImageUrl),
                });
        }
        return [...results.values()];
    }

    function publishedAt(row) {
        return Number.isFinite(row?.publishDateAt) ? row.publishDateAt : parseChzzkDate(row?.publishDate)?.getTime();
    }

    async function findReplay(channelId, main, { signal, at, excluded = [] }) {
        const { startMs, endMs } = main;
        if (
            !channelIdPattern.test(channelId) ||
            !Number.isFinite(startMs) ||
            !Number.isFinite(endMs) ||
            startMs >= endMs
        )
            return { status: "lookup-error" };
        const pages = new Map();
        async function readPage(page) {
            if (pages.has(page)) return pages.get(page);
            const params = new URLSearchParams({
                sortType: "LATEST",
                pagingType: "PAGE",
                page,
                size: pageSize,
                videoType: "REPLAY",
            });
            const response = await fetchJson(`${api}/v1/channels/${channelId}/videos?${params}`, { signal });
            const content = response?.content;
            if (
                response?.code !== 200 ||
                !Array.isArray(content?.data) ||
                !Number.isSafeInteger(content.totalPages) ||
                content.totalPages < 0 ||
                (content.data.length && content.page !== page)
            )
                throw new Error("Invalid channel video page");
            pages.set(page, content);
            return content;
        }

        const first = await readPage(0);
        const latestPublication = publishedAt(first.data[0]);
        if (!first.data.length || latestPublication < startMs) return { status: "no-replay" };
        const preferCurrent =
            at >= startMs && at < endMs && (!Number.isFinite(latestPublication) || at <= latestPublication);
        // Publication can lag the broadcast. Skip publications older than the main broadcast start,
        // then confirm the actual broadcast intervals from the details.
        let page = 0;
        let end = first.totalPages;
        while (page + 1 < end) {
            const middle = page + Math.floor((end - page) / 2);
            const { data } = await readPage(middle);
            const newest = publishedAt(data[0]);
            if (!Number.isFinite(newest)) throw new Error("Unknown replay publication order");
            if (newest >= startMs) page = middle;
            else end = middle;
        }

        const seen = new Set([main.videoNo, ...excluded]);
        let inspected = 0;
        let incomplete = false;
        let overlappingReplay;
        for (; page >= 0; page--) {
            const { data } = await readPage(page);
            for (const row of data.slice().reverse()) {
                const no = String(row?.videoNo);
                if (
                    row?.videoType !== "REPLAY" ||
                    !videoNoPattern.test(no) ||
                    seen.has(no) ||
                    publishedAt(row) < startMs
                )
                    continue;
                if (inspected >= maxDetails) return overlappingReplay || { status: "search-limit" };
                seen.add(no);
                inspected++;
                const replay = await loadVideo(no, { signal, needsKey: true });
                if (replay.status === "lookup-error") incomplete = true;
                if (
                    replay.status === "ok" &&
                    replay.channelId === channelId &&
                    replay.media.id !== main.id &&
                    replay.media.startMs < endMs &&
                    replay.media.endMs > startMs
                ) {
                    if (!preferCurrent || (replay.media.startMs <= at && at < replay.media.endMs)) return replay;
                    overlappingReplay ??= replay;
                }
            }
        }
        return overlappingReplay || { status: incomplete ? "lookup-error" : "no-replay" };
    }

    CheeseSpanner.vodMultiviewMetadata = Object.freeze({ loadVideo, videoNoFromUrl, searchChannels, findReplay });
})();
