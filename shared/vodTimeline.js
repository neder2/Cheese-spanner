/**
 * shared/vodTimeline.js — VOD 상세 응답과 장시간 분할 방송의 시간축을 정규화한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트. content.js가 구성한 BetterChzzk.utils를 사용하며
 *   네트워크 요청, DOM 조작, storage 접근 없이 순수 계산과 연결 세그먼트 순회만 담당한다.
 * 공개 API: BetterChzzk.vodTimeline.normalizeVideoDetail, resolveSegmentStartInfo,
 *   mergeBroadcastSegment.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.vodTimeline) return;

    const VOD_SPLIT_SEGMENT_MS = 17 * 60 * 60 * 1000;
    const VOD_SPLIT_OFFSET_TOLERANCE_MS = 45 * 60 * 1000;
    const VOD_SPLIT_MIN_OFFSET_MS = VOD_SPLIT_SEGMENT_MS - VOD_SPLIT_OFFSET_TOLERANCE_MS;
    const VOD_SPLIT_DURATION_TOLERANCE_MS = 2 * 60 * 1000;
    const VOD_SPLIT_START_TOLERANCE_MS = 60 * 1000;
    const VOD_SPLIT_MAX_LINKS = 8;

    const { parseChzzkDate, pickString, pickVideoEndDateText, pickVideoStartDateText } = root.utils;

    function toPositiveNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : NaN;
    }

    function toDateMs(value) {
        const ms = parseChzzkDate(value)?.getTime();
        return Number.isFinite(ms) ? ms : NaN;
    }

    function normalizeVideoDetail(detail) {
        const source = detail && typeof detail === "object" ? detail : {};
        const older = source.nextVideo && typeof source.nextVideo === "object" ? source.nextVideo : {};

        return {
            videoNo: pickString(source.videoNo, source.videoId, source.id),
            title: pickString(source.videoTitle, source.title, source.liveTitle),
            durationSeconds: toPositiveNumber(source.duration),
            startMs: toDateMs(pickVideoStartDateText(source)),
            endMs: toDateMs(pickVideoEndDateText(source)),
            olderVideoNo: pickString(older.videoNo, older.videoId, older.id),
            olderDurationSeconds: toPositiveNumber(older.duration),
        };
    }

    function throwIfAborted(signal) {
        if (!signal?.aborted) return;
        if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();

        const error = new Error("The operation was aborted.");
        error.name = "AbortError";
        throw error;
    }

    function isAbortError(error) {
        return error?.name === "AbortError";
    }

    function hasFullSplitDuration(durationSeconds) {
        return (
            Number.isFinite(durationSeconds) &&
            Math.abs(durationSeconds * 1000 - VOD_SPLIT_SEGMENT_MS) <= VOD_SPLIT_DURATION_TOLERANCE_MS
        );
    }

    function getInferredSegmentOffsetMs(detail) {
        if (!Number.isFinite(detail.endMs) || !Number.isFinite(detail.durationSeconds)) return 0;

        const inferredSegmentStartMs = detail.endMs - detail.durationSeconds * 1000;
        const rawOffsetMs = inferredSegmentStartMs - detail.startMs;
        if (!Number.isFinite(rawOffsetMs) || rawOffsetMs < VOD_SPLIT_MIN_OFFSET_MS) return 0;

        const segmentIndex = Math.round(rawOffsetMs / VOD_SPLIT_SEGMENT_MS);
        if (segmentIndex <= 0) return 0;

        const alignedOffsetMs = segmentIndex * VOD_SPLIT_SEGMENT_MS;
        return Math.abs(rawOffsetMs - alignedOffsetMs) <= VOD_SPLIT_OFFSET_TOLERANCE_MS ? alignedOffsetMs : 0;
    }

    async function resolveSegmentStartInfo(detail, { fetchDetail, signal } = {}) {
        throwIfAborted(signal);
        const current = normalizeVideoDetail(detail);
        if (!Number.isFinite(current.startMs)) {
            return {
                originalStartMs: NaN,
                segmentOffsetMs: 0,
                segmentStartMs: NaN,
            };
        }

        const inferredOffsetMs = getInferredSegmentOffsetMs(current);
        const seen = new Set(current.videoNo ? [current.videoNo] : []);
        let cursor = current;
        let linkedSegmentCount = 0;

        while (linkedSegmentCount < VOD_SPLIT_MAX_LINKS) {
            throwIfAborted(signal);
            if (
                !cursor.olderVideoNo ||
                seen.has(cursor.olderVideoNo) ||
                !hasFullSplitDuration(cursor.olderDurationSeconds)
            ) {
                break;
            }

            const olderVideoNo = cursor.olderVideoNo;
            seen.add(olderVideoNo);

            let olderRawDetail;
            try {
                olderRawDetail = await fetchDetail(olderVideoNo, { signal });
                throwIfAborted(signal);
            } catch (error) {
                if (signal?.aborted) throwIfAborted(signal);
                if (isAbortError(error)) throw error;
                break;
            }

            const olderDetail = normalizeVideoDetail(olderRawDetail);
            if (
                !Number.isFinite(olderDetail.startMs) ||
                Math.abs(olderDetail.startMs - current.startMs) > VOD_SPLIT_START_TOLERANCE_MS ||
                !hasFullSplitDuration(olderDetail.durationSeconds)
            ) {
                break;
            }

            linkedSegmentCount += 1;
            cursor = olderDetail;
        }

        const linkedOffsetMs = linkedSegmentCount * VOD_SPLIT_SEGMENT_MS;
        const segmentOffsetMs = linkedOffsetMs > 0 ? linkedOffsetMs : inferredOffsetMs;
        return {
            originalStartMs: current.startMs,
            segmentOffsetMs,
            segmentStartMs: current.startMs + segmentOffsetMs,
        };
    }

    function isRecord(value) {
        return Boolean(value && typeof value === "object" && !Array.isArray(value));
    }

    function appendVideoNos(target, source) {
        const candidates = [...(Array.isArray(source?.videoNos) ? source.videoNos : []), source?.videoNo];
        for (const candidate of candidates) {
            const videoNo = pickString(candidate);
            if (videoNo && !target.includes(videoNo)) target.push(videoNo);
        }
    }

    function cloneWithVideoNos(entry) {
        const result = { ...(isRecord(entry) ? entry : {}) };
        const videoNos = [];
        appendVideoNos(videoNos, entry);
        result.videoNos = videoNos;
        return result;
    }

    function mergeBroadcastSegment(existing, incoming) {
        if (!isRecord(existing)) return cloneWithVideoNos(incoming);
        if (!isRecord(incoming)) return cloneWithVideoNos(existing);

        const result = cloneWithVideoNos(existing);
        appendVideoNos(result.videoNos, incoming);

        const existingDuration = Number(existing.duration);
        const incomingDuration = Number(incoming.duration);
        result.duration =
            (Number.isFinite(existingDuration) ? existingDuration : 0) +
            (Number.isFinite(incomingDuration) ? incomingDuration : 0);

        const startMs = Number(existing.startMs);
        result.endMs = Number.isFinite(startMs) ? startMs + result.duration * 1000 : NaN;

        if (!pickString(result.title)) result.title = pickString(incoming.title);
        if (!pickString(result.titleKey)) result.titleKey = pickString(incoming.titleKey);
        return result;
    }

    root.vodTimeline = Object.freeze({
        mergeBroadcastSegment,
        normalizeVideoDetail,
        resolveSegmentStartInfo,
    });
})();
