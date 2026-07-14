/**
 * features/vodComments/model.js — VOD 댓글의 순수 데이터 정규화와 계산을 제공한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: 없음. DOM, 네트워크, storage를 다루지 않는다.
 */
(() => {
    "use strict";

    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const namespace = (root.vodComments = root.vodComments || {});
    if (namespace.model) return;

    const COMMENT_PAGE_SIZE = 10;
    const MAX_COMMENTS_PER_ORDER = 300;
    const MAX_REPLIES_PER_COMMENT = 50;
    const MAX_REPLIES_PER_ORDER = 300;
    const COLLAPSED_COMMENT_MAX_CHARS = 420;
    const COLLAPSED_COMMENT_MAX_LINES = 12;
    const DEFAULT_ORDER = "POPULAR";
    const TIMECODE_RE = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
    const TIMECODE_SCAN_RE = /(?:^|[\s([{])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)\]},.!?])/g;
    const SORT_OPTIONS = Object.freeze([
        Object.freeze({ label: "인기순", order: "POPULAR" }),
        Object.freeze({ label: "최신순", order: "DESC" }),
        Object.freeze({ label: "등록순", order: "ASC" }),
    ]);
    const IMAGE_ATTACHMENT_TYPES = Object.freeze(["PHOTO", "STICKER", "EMOTICON"]);
    const DEFAULT_IMAGE_BASE_URL = "https://chzzk.naver.com/";

    function compactText(value) {
        return String(value || "")
            .replace(/\s+/g, " ")
            .trim();
    }

    function normalizeLimit(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
    }

    function parseTimecodeSeconds(value) {
        const text = compactText(value);
        if (!TIMECODE_RE.test(text)) return NaN;

        const parts = text.split(":").map(Number);
        if (parts.some((part) => !Number.isFinite(part))) return NaN;
        if (parts.length === 2) {
            const [minutes, seconds] = parts;
            return seconds < 60 ? minutes * 60 + seconds : NaN;
        }
        if (parts.length === 3) {
            const [hours, minutes, seconds] = parts;
            return minutes < 60 && seconds < 60 ? hours * 3600 + minutes * 60 + seconds : NaN;
        }
        return NaN;
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

    function validateCommentResponse(content) {
        if (!content || typeof content !== "object") throw new Error("댓글 응답 형식을 확인할 수 없습니다.");
        if (!content.comments || typeof content.comments !== "object" || !Array.isArray(content.comments.data)) {
            throw new Error("댓글 목록 응답 형식을 확인할 수 없습니다.");
        }
        if (content.bestComments != null && !Array.isArray(content.bestComments)) {
            throw new Error("인기 댓글 응답 형식을 확인할 수 없습니다.");
        }
        return content;
    }

    function parseCommentPage(content, { offset = 0, pageSize = COMMENT_PAGE_SIZE } = {}) {
        validateCommentResponse(content);
        const comments = content.comments;
        const rows = [...comments.data];
        const normalizedOffset = normalizeLimit(offset, 0);
        const bestRows = normalizedOffset === 0 && Array.isArray(content.bestComments) ? [...content.bestComments] : [];
        const normalizedPageSize = Math.max(1, normalizeLimit(pageSize, COMMENT_PAGE_SIZE));
        const totalCountValue = Number(comments.totalCount ?? comments.commentCount);
        const totalCount = Number.isFinite(totalCountValue) && totalCountValue >= 0 ? totalCountValue : null;
        const page = comments.page;
        const next = Number(page?.next);
        let hasMore;
        let nextOffset;

        if (page && Object.hasOwn(page, "next")) {
            hasMore = Number.isFinite(next) && next > normalizedOffset;
            nextOffset = hasMore ? next : normalizedOffset + rows.length;
        } else {
            nextOffset = normalizedOffset + rows.length;
            hasMore = rows.length >= normalizedPageSize;
        }
        if (!rows.length) hasMore = false;

        return {
            bestRows,
            commentActive: content.commentActive !== false,
            hasMore,
            nextOffset,
            rows,
            totalCount,
        };
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

    function normalizeImageUrl(value, baseUrl = DEFAULT_IMAGE_BASE_URL) {
        const raw = compactText(value);
        if (!raw) return "";
        try {
            const url = new URL(raw, compactText(baseUrl) || DEFAULT_IMAGE_BASE_URL);
            return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
        } catch (_) {
            return "";
        }
    }

    function normalizeAttachments(comment, { baseUrl = DEFAULT_IMAGE_BASE_URL, maxItems = 5 } = {}) {
        const limit = normalizeLimit(maxItems, 5);
        return (Array.isArray(comment?.attaches) ? comment.attaches : [])
            .map((attachment) => ({
                src: normalizeImageUrl(attachment?.attachValue, baseUrl),
                type: compactText(attachment?.attachType).toUpperCase(),
            }))
            .filter((attachment) => attachment.src && IMAGE_ATTACHMENT_TYPES.includes(attachment.type))
            .slice(0, limit);
    }

    function getCollapsedCommentText(
        text,
        { maxChars = COLLAPSED_COMMENT_MAX_CHARS, maxLines = COLLAPSED_COMMENT_MAX_LINES } = {}
    ) {
        const content = String(text || "");
        const charLimit = normalizeLimit(maxChars, COLLAPSED_COMMENT_MAX_CHARS);
        const lineLimit = Math.max(1, normalizeLimit(maxLines, COLLAPSED_COMMENT_MAX_LINES));
        const lines = content.split("\n");
        let cutoff = content.length;
        if (lines.length > lineLimit) cutoff = lines.slice(0, lineLimit).join("\n").length;
        cutoff = Math.min(cutoff, charLimit);
        if (cutoff >= content.length) return "";

        let collapsed = content.slice(0, cutoff).trimEnd();
        if (cutoff === charLimit) {
            const lastBreak = collapsed.lastIndexOf("\n");
            if (lastBreak >= charLimit * 0.65) collapsed = collapsed.slice(0, lastBreak).trimEnd();
        }
        return collapsed ? `${collapsed}…` : "";
    }

    namespace.model = Object.freeze({
        COLLAPSED_COMMENT_MAX_CHARS,
        COLLAPSED_COMMENT_MAX_LINES,
        COMMENT_PAGE_SIZE,
        DEFAULT_ORDER,
        MAX_COMMENTS_PER_ORDER,
        MAX_REPLIES_PER_COMMENT,
        MAX_REPLIES_PER_ORDER,
        SORT_OPTIONS,
        TIMECODE_SCAN_RE,
        applyCommentPage,
        collectReplyRows,
        compactText,
        formatCommentDate,
        getCollapsedCommentText,
        getCommentKey,
        getReplyKey,
        isCommentOrder,
        mergeCommentItems,
        normalizeAttachments,
        normalizeCommentRowReplies,
        normalizeImageUrl,
        normalizeReplyRow,
        parseCommentDate,
        parseCommentPage,
        parseTimecodeSeconds,
        validateCommentResponse,
    });
})();
