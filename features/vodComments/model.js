/**
 * features/vodComments/model.js — VOD 댓글의 순수 데이터 정규화와 계산을 제공한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: shared/data.js의 공용 댓글 응답 판독기. DOM, 네트워크, storage를 다루지 않는다.
 */
(() => {
    "use strict";

    const root = (globalThis.CheeseSpanner = globalThis.CheeseSpanner || {});
    const namespace = (root.vodComments = root.vodComments || {});
    if (namespace.model) return;

    const { parseChzzkCommentPage: parseCommentPage, validateChzzkCommentResponse: validateCommentResponse } =
        root.utils;
    const COMMENT_PAGE_SIZE = 10;
    const MAX_COMMENTS_PER_ORDER = 300;
    const MAX_REPLIES_PER_COMMENT = 50;
    const MAX_REPLIES_PER_ORDER = 300;
    const COLLAPSED_COMMENT_MAX_CHARS = 250;
    const DEFAULT_ORDER = "POPULAR";
    const SORT_OPTIONS = Object.freeze([
        Object.freeze({ label: "인기순", order: "POPULAR" }),
        Object.freeze({ label: "최신순", order: "DESC" }),
        Object.freeze({ label: "등록순", order: "ASC" }),
    ]);
    const IMAGE_ATTACHMENT_TYPES = Object.freeze(["PHOTO", "STICKER", "EMOTICON"]);
    const DEFAULT_IMAGE_BASE_URL = "https://chzzk.naver.com/";
    const CHAPTER_TIMECODE = /(?:^|[\s([（［|])((?:\d{1,2}:)?\d{1,2}:\d{2})(?!:\d)(?=$|[\s)\]）］|,.:：–—~～-])/g;
    const CHAPTER_TITLE_SEPARATOR = /^[\s()[\]（）［］|,.:：–—~～-]+|[\s()[\]（）［］|,.:：–—~～-]+$/g;
    const MAX_COMMENT_CHAPTERS = 100;
    const MIN_AUTOMATIC_CHAPTERS = 3;

    function compactText(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeLimit(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
    }

    function isCommentOrder(value) {
        return SORT_OPTIONS.some((option) => option.order === value);
    }

    function getCommentKey(row, fallbackIndex = 0) {
        const comment = row?.comment || {};
        const id = comment.commentId;
        if (id !== undefined && id !== null && id !== "") return `id:${id}`;
        return `fallback:${comment.createdDate || ""}:${row?.user?.userIdHash || ""}:${
            comment.content || ""
        }:${fallbackIndex}`;
    }

    function getIdlessCommentSignature(row) {
        const comment = row?.comment || {};
        const id = comment.commentId;
        if (id !== undefined && id !== null && id !== "") return "";
        const createdDate = comment.createdDate;
        const userIdHash = row?.user?.userIdHash;
        const content = comment.content;
        if (
            typeof createdDate !== "string" ||
            !createdDate ||
            typeof userIdHash !== "string" ||
            !userIdHash ||
            typeof content !== "string" ||
            !content
        ) {
            return "";
        }
        return JSON.stringify([createdDate, userIdHash, content]);
    }

    function getReplyKey(parentKey, row, fallbackIndex = 0) {
        return `reply:${parentKey}:${getCommentKey(row, fallbackIndex)}`;
    }

    function normalizeReplyRow(reply) {
        if (!reply || typeof reply !== "object") return null;
        if (reply.comment && typeof reply.comment === "object") return reply;
        if (!reply.commentType) return reply;
        const directUser = reply.user && typeof reply.user === "object" ? reply.user : null;
        return {
            ...reply,
            comment: reply,
            user: directUser || {
                profileImageUrl: reply.profileImageUrl,
                userIdHash: reply.userIdHash,
                userNickname: reply.userNickname,
                writer: reply.writer,
            },
        };
    }

    function collectReplyRows(row, { maxReplies = MAX_REPLIES_PER_COMMENT } = {}) {
        const rows = [];
        const seenObjects = new Set();
        const seenIds = new Set();
        const limit = normalizeLimit(maxReplies, MAX_REPLIES_PER_COMMENT);
        let truncated = row?.replyCommentsTruncated === true || row?.comment?.replyCommentsTruncated === true;

        for (const source of [row?.replyComments, row?.comment?.replyComments]) {
            if (!Array.isArray(source)) continue;
            for (const reply of source) {
                if (!reply || typeof reply !== "object" || seenObjects.has(reply)) continue;
                seenObjects.add(reply);
                const normalized = normalizeReplyRow(reply);
                if (!normalized) continue;
                const commentId = normalized.comment?.commentId;
                const idKey =
                    commentId === undefined || commentId === null || commentId === "" ? "" : String(commentId);
                if (idKey && seenIds.has(idKey)) continue;
                if (idKey) seenIds.add(idKey);
                if (rows.length >= limit) {
                    truncated = true;
                    return { rows, truncated };
                }
                rows.push(normalized);
            }
        }
        return { rows, truncated };
    }

    function cloneStoredReply(normalized) {
        if (!normalized || typeof normalized !== "object") return null;
        const stored = { ...normalized, replyComments: [] };
        if (normalized.comment && typeof normalized.comment === "object") {
            stored.comment = { ...normalized.comment, replyComments: [] };
        }
        return stored;
    }

    function normalizeCommentRowReplies(row, maxReplies) {
        const hasReplySource = Array.isArray(row?.replyComments) || Array.isArray(row?.comment?.replyComments);
        if (!hasReplySource) return { replyCount: 0, repliesCapped: false, row };

        const collected = collectReplyRows(row, { maxReplies });
        const replyComments = collected.rows.map(cloneStoredReply).filter(Boolean);
        const stored = {
            ...row,
            replyComments,
            replyCommentsTruncated: collected.truncated,
        };
        if (row.comment && typeof row.comment === "object") {
            stored.comment = {
                ...row.comment,
                replyComments: [],
                replyCommentsTruncated: false,
            };
        }
        return {
            replyCount: replyComments.length,
            repliesCapped: collected.truncated,
            row: stored,
        };
    }

    function mergeCommentItems(
        existingItems,
        bestRows,
        rows,
        {
            maxItems = MAX_COMMENTS_PER_ORDER,
            maxRepliesPerComment = MAX_REPLIES_PER_COMMENT,
            maxRepliesTotal = MAX_REPLIES_PER_ORDER,
            offset = 0,
        } = {}
    ) {
        const itemLimit = normalizeLimit(maxItems, MAX_COMMENTS_PER_ORDER);
        const perCommentReplyLimit = normalizeLimit(maxRepliesPerComment, MAX_REPLIES_PER_COMMENT);
        const totalReplyLimit = normalizeLimit(maxRepliesTotal, MAX_REPLIES_PER_ORDER);
        const items = Array.isArray(existingItems) ? [...existingItems] : [];
        const itemIndexes = new Map();
        const bestIdlessObjects = new Map();
        const bestIdlessSignatures = new Map();
        const added = [];
        let capped = false;
        let replyCount = 0;
        let repliesCapped = false;

        for (const [index, item] of items.entries()) {
            if (!item || typeof item !== "object" || !item.key || itemIndexes.has(item.key)) continue;
            itemIndexes.set(item.key, index);
            const itemReplyCount = Number(item.replyCount);
            replyCount += Number.isFinite(itemReplyCount)
                ? Math.max(0, Math.trunc(itemReplyCount))
                : collectReplyRows(item.row, { maxReplies: perCommentReplyLimit }).rows.length;
            if (item.repliesCapped) repliesCapped = true;
        }
        replyCount = Math.min(replyCount, totalReplyLimit);

        function appendSource(source, { best, fallbackOffset }) {
            for (const [index, row] of (Array.isArray(source) ? source : []).entries()) {
                if (!row || typeof row !== "object") continue;
                const idlessSignature = getIdlessCommentSignature(row);
                const duplicateCounts = idlessSignature ? bestIdlessSignatures : bestIdlessObjects;
                const duplicateKey = idlessSignature || row;
                const duplicateCount = duplicateCounts.get(duplicateKey) || 0;
                if (!best && duplicateCount > 0) {
                    if (duplicateCount === 1) duplicateCounts.delete(duplicateKey);
                    else duplicateCounts.set(duplicateKey, duplicateCount - 1);
                    continue;
                }
                if (best) duplicateCounts.set(duplicateKey, duplicateCount + 1);
                const key = getCommentKey(row, fallbackOffset + index);
                const existingIndex = itemIndexes.get(key);
                if (existingIndex !== undefined) {
                    const existing = items[existingIndex];
                    if (best && !existing.best) {
                        const upgraded = { ...existing, best: true };
                        items[existingIndex] = upgraded;
                    }
                    continue;
                }
                if (items.length >= itemLimit) {
                    capped = true;
                    break;
                }

                const remainingReplies = Math.max(0, totalReplyLimit - replyCount);
                const normalized = normalizeCommentRowReplies(row, Math.min(perCommentReplyLimit, remainingReplies));
                const item = {
                    best,
                    key,
                    replyCount: normalized.replyCount,
                    repliesCapped: normalized.repliesCapped,
                    row: normalized.row,
                };
                itemIndexes.set(key, items.length);
                items.push(item);
                added.push(item);
                replyCount += normalized.replyCount;
                if (normalized.repliesCapped) repliesCapped = true;
            }
        }

        appendSource(bestRows, { best: true, fallbackOffset: -1000 });
        appendSource(rows, { best: false, fallbackOffset: normalizeLimit(offset, 0) });
        if (items.length >= itemLimit) capped = true;

        return {
            added,
            capped,
            items,
            repliesCapped,
            replyCount,
        };
    }

    function applyCommentPage(
        existingItems,
        content,
        {
            maxItems = MAX_COMMENTS_PER_ORDER,
            maxRepliesPerComment = MAX_REPLIES_PER_COMMENT,
            maxRepliesTotal = MAX_REPLIES_PER_ORDER,
            offset = 0,
            pageSize = COMMENT_PAGE_SIZE,
        } = {}
    ) {
        const page = parseCommentPage(content, { offset, pageSize });
        const merged = mergeCommentItems(existingItems, page.bestRows, page.rows, {
            maxItems,
            maxRepliesPerComment,
            maxRepliesTotal,
            offset,
        });
        const itemLimit = normalizeLimit(maxItems, MAX_COMMENTS_PER_ORDER);
        return {
            ...page,
            ...merged,
            hasMore: page.hasMore && !merged.capped && merged.items.length < itemLimit,
        };
    }

    function parseCommentDate(value) {
        const text = compactText(value);
        const match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
        if (!match) return null;
        const [, year, month, day, hours, minutes, seconds] = match.map(Number);
        if (month < 1 || month > 12 || day < 1 || day > 31 || hours > 23 || minutes > 59 || seconds > 59) {
            return null;
        }
        const date = new Date(Date.UTC(year, month - 1, day, hours - 9, minutes, seconds));
        if (Number.isNaN(date.getTime())) return null;
        const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
        if (
            kst.getUTCFullYear() !== year ||
            kst.getUTCMonth() !== month - 1 ||
            kst.getUTCDate() !== day ||
            kst.getUTCHours() !== hours ||
            kst.getUTCMinutes() !== minutes ||
            kst.getUTCSeconds() !== seconds
        ) {
            return null;
        }
        return date;
    }

    function formatCommentDate(value, nowMs = Date.now()) {
        const date = parseCommentDate(value);
        if (!date) return compactText(value);
        const now = Number(nowMs);
        const currentTime = Number.isFinite(now) ? now : Date.now();
        const elapsed = currentTime - date.getTime();
        if (elapsed >= 0 && elapsed < 60 * 1000) return "방금 전";
        if (elapsed >= 0 && elapsed < 60 * 60 * 1000) {
            return `${Math.max(1, Math.floor(elapsed / 60000))}분 전`;
        }
        if (elapsed >= 0 && elapsed < 24 * 60 * 60 * 1000) return `${Math.floor(elapsed / 3600000)}시간 전`;
        const kstDate = new Date(date.getTime() + 9 * 60 * 60 * 1000);
        const currentKstDate = new Date(currentTime + 9 * 60 * 60 * 1000);
        const year = kstDate.getUTCFullYear();
        const month = String(kstDate.getUTCMonth() + 1).padStart(2, "0");
        const day = String(kstDate.getUTCDate()).padStart(2, "0");
        return year === currentKstDate.getUTCFullYear() ? `${month}.${day}` : `${year}.${month}.${day}`;
    }

    const normalizeImageUrl = root.utils.normalizeChzzkImageUrl;

    function getPhotoThumbnailUrl(src) {
        const normalized = normalizeImageUrl(src);
        if (!normalized) return "";
        const url = new URL(normalized);
        if (url.origin === "https://nng-phinf.pstatic.net") url.search = "?type=w375";
        return url.href;
    }

    function getPhotoDimensions(extraJson) {
        if (!extraJson) return {};
        try {
            const { width, height } =
                typeof extraJson === "string" ? JSON.parse(extraJson.trim().replace(/,+$/, "")) : extraJson;
            if (Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0) {
                return { width, height };
            }
        } catch {
            // Older photos may omit or carry malformed dimensions. Keep their validated URL.
        }
        return {};
    }

    function normalizeAttachments(comment, { baseUrl = DEFAULT_IMAGE_BASE_URL, maxItems = 5 } = {}) {
        const limit = normalizeLimit(maxItems, 5);
        const items = [];
        for (const attachment of Array.isArray(comment?.attaches) ? comment.attaches : []) {
            if (items.length >= limit) break;
            const type = compactText(attachment?.attachType).toUpperCase();
            if (!IMAGE_ATTACHMENT_TYPES.includes(type)) continue;
            const src = normalizeImageUrl(attachment?.attachValue, baseUrl);
            if (!src) continue;
            items.push(type === "PHOTO" ? { src, type, ...getPhotoDimensions(attachment.extraJson) } : { src, type });
        }
        return items;
    }

    function isSurrogatePairBoundary(text, index) {
        if (index <= 0 || index >= text.length) return false;
        const high = text.charCodeAt(index - 1);
        const low = text.charCodeAt(index);
        return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    }

    function getCollapsedCommentText(text, { maxChars = COLLAPSED_COMMENT_MAX_CHARS } = {}) {
        const content = String(text || "");
        const charLimit = normalizeLimit(maxChars, COLLAPSED_COMMENT_MAX_CHARS);
        if (content.length <= charLimit) return "";
        const cutoff = isSurrogatePairBoundary(content, charLimit) ? charLimit - 1 : charLimit;
        return content.slice(0, cutoff) + "...";
    }

    function parseCommentChapters(text) {
        const chapters = new Map();
        for (const line of text.split(/\r?\n/)) {
            const matches = [...line.matchAll(CHAPTER_TIMECODE)];
            for (const [index, match] of matches.entries()) {
                const [, timecode] = match;
                const seconds = root.utils.parseTimecodeSeconds(timecode);
                if (!Number.isFinite(seconds)) continue;
                const next = matches[index + 1];
                const endOfTime = match.index + match[0].length;
                const description = line.slice(endOfTime, next?.index);
                const beforeTime = matches.length === 1 ? line.slice(0, match.index) : "";
                const title =
                    compactText(description.replace(CHAPTER_TITLE_SEPARATOR, "")) ||
                    compactText(beforeTime.replace(CHAPTER_TITLE_SEPARATOR, ""));
                const previous = chapters.get(seconds);
                if (!previous || (!previous.title && title)) {
                    chapters.set(seconds, { seconds, timecode, title });
                }
            }
        }
        return [...chapters.values()].sort((a, b) => a.seconds - b.seconds).slice(0, MAX_COMMENT_CHAPTERS);
    }

    function selectAutomaticChapterComment(items, duration) {
        let selected = null;
        let highestBuffCount = -1;
        for (const item of items) {
            const row = item?.row;
            const comment = row?.comment;
            if (
                typeof comment?.content !== "string" ||
                comment.deleted ||
                comment.hideByCleanBot ||
                comment.secret ||
                (comment.commentType && comment.commentType !== "COMMENT")
            )
                continue;
            const id = comment.commentId;
            if ((typeof id !== "string" && typeof id !== "number") || !/^[1-9]\d*$/.test(String(id))) continue;
            const buffCount = Number(row.buffNerf?.buffCount ?? 0);
            if (!Number.isSafeInteger(buffCount) || buffCount <= highestBuffCount) continue;
            const chapters = parseCommentChapters(comment.content);
            if (chapters.filter(({ seconds }) => seconds < duration).length < MIN_AUTOMATIC_CHAPTERS) continue;
            highestBuffCount = buffCount;
            selected = { commentId: String(id), chapters };
        }
        return selected;
    }

    namespace.model = Object.freeze({
        COLLAPSED_COMMENT_MAX_CHARS,
        COMMENT_PAGE_SIZE,
        DEFAULT_ORDER,
        MAX_COMMENTS_PER_ORDER,
        MAX_REPLIES_PER_COMMENT,
        MAX_REPLIES_PER_ORDER,
        MIN_AUTOMATIC_CHAPTERS,
        SORT_OPTIONS,
        applyCommentPage,
        collectReplyRows,
        compactText,
        formatCommentDate,
        getCollapsedCommentText,
        getCommentKey,
        getPhotoThumbnailUrl,
        getReplyKey,
        isCommentOrder,
        mergeCommentItems,
        normalizeAttachments,
        normalizeCommentRowReplies,
        normalizeImageUrl,
        normalizeReplyRow,
        parseCommentChapters,
        parseCommentDate,
        parseCommentPage,
        parseTimecodeSeconds: root.utils.parseTimecodeSeconds,
        selectAutomaticChapterComment,
        validateCommentResponse,
    });
})();
