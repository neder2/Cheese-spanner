/** Normalizes observed video/comment data and computes search/progress values without DOM state. */
(() => {
    const root = (globalThis.CheeseSpanner = globalThis.CheeseSpanner || {});
    const { pickArray, pickChzzkVideoNo, normalizeCompact: normalize } = root.utils;
    function pickPublishDate(video) {
        return video.publishDate || video.publishDateAt || video.liveOpenDate || "";
    }

    function extractVideos(json) {
        const content = json?.content ?? json;
        const arr = pickArray(content);
        if (!arr) return [];
        return arr
            .map((v) => {
                const videoNo = pickChzzkVideoNo(v);
                const title = v.videoTitle ?? v.title ?? v.subject ?? "";
                if (!videoNo || !title) return null;
                const readCount = v.readCount ?? v.videoReadCount ?? v.viewCount ?? null;
                const readCountNumber =
                    readCount === null || readCount === undefined || readCount === "" ? null : Number(readCount);
                const livePv = v.livePv ?? v.livePlaybackCount ?? v.liveViewCount ?? null;
                const livePvNumber = livePv === null || livePv === undefined || livePv === "" ? null : Number(livePv);
                return {
                    videoNo,
                    title: String(title),
                    titleNorm: normalize(title),
                    thumb: v.thumbnailImageUrl || v.thumbnailUrl || v.thumbnail || "",
                    duration: typeof v.duration === "number" ? v.duration : null,
                    publishDate: pickPublishDate(v),
                    readCount: Number.isFinite(readCountNumber) ? readCountNumber : null,
                    livePv: Number.isFinite(livePvNumber) ? livePvNumber : null,
                    watchTimeline: v.watchTimeline || null,
                    progressRatio: getWatchProgressRatio(v.watchTimeline, v.duration),
                    type: v.videoType || v.type || "",
                    commentActive: v.commentActive !== false,
                    commentTexts: [],
                    commentNorm: "",
                    commentFetched: v.commentActive === false,
                    commentLoading: false,
                    commentError: null,
                };
            })
            .filter(Boolean);
    }

    function collectCommentTexts(value, out = []) {
        if (!value) return out;
        if (Array.isArray(value)) {
            for (const item of value) collectCommentTexts(item, out);
            return out;
        }
        if (typeof value !== "object") return out;

        const comment = value.comment;
        if (comment && typeof comment === "object" && typeof comment.content === "string") {
            out.push(comment.content);
        } else if (typeof value.content === "string" && value.commentType) {
            out.push(value.content);
        }

        if (Array.isArray(value.replyComments)) collectCommentTexts(value.replyComments, out);
        return out;
    }

    function cleanCommentText(text) {
        return String(text || "")
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
            .join("\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    function uniqueCommentTexts(texts) {
        const seen = new Set();
        const out = [];
        for (const text of texts) {
            const cleaned = cleanCommentText(text);
            if (!cleaned) continue;
            const key = normalize(cleaned);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(cleaned);
        }
        return out;
    }

    function extractCommentTexts(content) {
        const texts = [];
        collectCommentTexts(content?.bestComments, texts);
        collectCommentTexts(content?.comments?.data, texts);
        return uniqueCommentTexts(texts);
    }

    function filterVideosByNormalizedQuery(videos, normalizedQuery, { includeComments = true } = {}) {
        if (!normalizedQuery) return videos;
        return videos.filter(
            (v) => v.titleNorm.includes(normalizedQuery) || (includeComments && hasCommentMatchNorm(v, normalizedQuery))
        );
    }

    // Each comment is normalized on its own and joined by a newline, which normalize() never leaves in a comment
    // or a query, so a match cannot span two different comments.
    function buildCommentNorm(texts) {
        return (Array.isArray(texts) ? texts : [])
            .map((text) => normalize(text))
            .filter(Boolean)
            .join("\n");
    }

    function hasCommentMatchNorm(video, normalizedQuery) {
        return Boolean(normalizedQuery && video?.commentNorm && video.commentNorm.includes(normalizedQuery));
    }

    function getCommentMatchText(video, query) {
        const q = normalize(query);
        if (!q || !Array.isArray(video?.commentTexts)) return "";
        const text = video.commentTexts.find((item) => normalize(item).includes(q));
        if (text) return cleanCommentText(text);
        return "";
    }

    function shouldFetchCommentsForQuery(video, query) {
        if (!video || !query) return false;
        if (video.titleNorm.includes(query)) return false;
        if (video.commentFetched || video.commentLoading || video.commentActive === false) return false;
        return true;
    }

    function getNumber(value) {
        if (value === null || value === undefined || value === "") return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }

    function getObjectNumberByKeys(obj, keys, depth = 0) {
        if (!obj || typeof obj !== "object" || depth > 4) return null;
        const wanted = new Set(keys.map((k) => k.toLowerCase()));

        for (const [key, value] of Object.entries(obj)) {
            const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
            if (wanted.has(normalizedKey)) {
                const n = getNumber(value);
                if (n !== null) return n;
            }
        }

        for (const value of Object.values(obj)) {
            if (value && typeof value === "object") {
                const n = getObjectNumberByKeys(value, keys, depth + 1);
                if (n !== null) return n;
            }
        }

        return null;
    }

    function getWatchProgressRatio(watchTimeline, duration) {
        if (!watchTimeline) return null;

        const durationNumber = getNumber(duration);
        const ratioFromNumber = (value) => {
            const n = getNumber(value);
            if (n === null || n <= 0) return null;
            if (n <= 1) return Math.min(n, 1);
            if (n <= 100) return Math.min(n / 100, 1);
            if (durationNumber && durationNumber > 0) return Math.min(n / durationNumber, 1);
            return null;
        };

        // Assumption, not verified for this list API: a bare numeric watchTimeline is a resume position in seconds,
        // as the video detail API's watchTimeline is (docs/contracts.md). The list API's type and unit with a
        // signed-in session were not measured (signed-out list samples were null). Either way it is never read as a
        // ratio or a percentage, and without an observed duration no progress is drawn.
        if (typeof watchTimeline !== "object") {
            const seconds = getNumber(watchTimeline);
            if (seconds === null || seconds <= 0 || !durationNumber || durationNumber <= 0) return null;
            return Math.min(seconds / durationNumber, 1);
        }

        const ratio = getObjectNumberByKeys(watchTimeline, [
            "progress",
            "progressrate",
            "progressratio",
            "watchratio",
            "playedratio",
            "percent",
            "percentage",
        ]);
        const ratioValue = ratioFromNumber(ratio);
        if (ratioValue !== null) return ratioValue;

        const seconds = getObjectNumberByKeys(watchTimeline, [
            "watchtime",
            "watchsecond",
            "watchseconds",
            "lastwatchtime",
            "lastwatchsecond",
            "lastwatchseconds",
            "lastplaybacktime",
            "lastplaybacksecond",
            "lastplaybackseconds",
            "lastplaybackposition",
            "lastplaytime",
            "currenttime",
            "currentsecond",
            "currentseconds",
            "playtime",
            "playseconds",
            "position",
            "offset",
            "timeline",
        ]);

        if (seconds === null || !durationNumber || durationNumber <= 0) return null;
        return Math.min(seconds / durationNumber, 1);
    }
    root.videoSearchModel = Object.freeze({
        pickPublishDate,
        extractVideos,
        collectCommentTexts,
        cleanCommentText,
        uniqueCommentTexts,
        extractCommentTexts,
        filterVideosByNormalizedQuery,
        buildCommentNorm,
        hasCommentMatchNorm,
        getCommentMatchText,
        shouldFetchCommentsForQuery,
        getNumber,
        getObjectNumberByKeys,
        getWatchProgressRatio,
    });
})();
