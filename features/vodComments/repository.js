/**
 * features/vodComments/repository.js — VOD·정렬별 댓글 데이터와 요청 상태를 관리한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: BetterChzzk.vodComments.model. fetchPage는 coordinator가 주입한다.
 */
(() => {
    "use strict";

    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const namespace = (root.vodComments = root.vodComments || {});
    if (namespace.repository) return;

    const model = namespace.model;
    if (!model) throw new Error("VOD 댓글 model이 repository보다 먼저 로드되어야 합니다.");

    const {
        COMMENT_PAGE_SIZE,
        DEFAULT_ORDER,
        MAX_COMMENTS_PER_ORDER,
        MAX_REPLIES_PER_COMMENT,
        MAX_REPLIES_PER_ORDER,
        applyCommentPage,
        compactText,
        isCommentOrder,
    } = model;

    function normalizeLimit(value, fallback, { minimum = 0 } = {}) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(minimum, Math.trunc(number)) : fallback;
    }

    function createCommentRepository({
        fetchPage,
        pageSize = COMMENT_PAGE_SIZE,
        maxCommentsPerOrder = MAX_COMMENTS_PER_ORDER,
        maxRepliesPerComment = MAX_REPLIES_PER_COMMENT,
        maxRepliesPerOrder = MAX_REPLIES_PER_ORDER,
    } = {}) {
        if (typeof fetchPage !== "function") throw new TypeError("fetchPage 함수가 필요합니다.");

        const normalizedPageSize = normalizeLimit(pageSize, COMMENT_PAGE_SIZE, { minimum: 1 });
        const commentLimit = normalizeLimit(maxCommentsPerOrder, MAX_COMMENTS_PER_ORDER);
        const perCommentReplyLimit = normalizeLimit(maxRepliesPerComment, MAX_REPLIES_PER_COMMENT);
        const totalReplyLimit = normalizeLimit(maxRepliesPerOrder, MAX_REPLIES_PER_ORDER);
        const states = new Map();
        let currentVideoNo = "";
        let activeOrder = DEFAULT_ORDER;
        let generation = 0;

        function normalizeOrder(order) {
            return isCommentOrder(order) ? order : DEFAULT_ORDER;
        }

        function stateKey(videoNo, order) {
            return `${videoNo}\u0000${order}`;
        }

        function touchState(state) {
            state.version += 1;
        }

        function createState(videoNo, order) {
            return {
                capped: false,
                commentActive: true,
                controller: null,
                error: "",
                hasMore: true,
                inFlight: null,
                items: [],
                loaded: false,
                loading: false,
                loadingMore: false,
                moreError: "",
                nextOffset: 0,
                order,
                requestContext: null,
                requestToken: 0,
                scrollTop: 0,
                totalCount: null,
                version: 0,
                videoNo,
            };
        }

        function getState(videoNo = currentVideoNo, order = activeOrder) {
            const normalizedVideoNo = compactText(videoNo);
            const normalizedOrder = normalizeOrder(order);
            const key = stateKey(normalizedVideoNo, normalizedOrder);
            if (!states.has(key)) states.set(key, createState(normalizedVideoNo, normalizedOrder));
            return states.get(key);
        }

        function getActiveState() {
            return getState(currentVideoNo, activeOrder);
        }

        function getVideoNo() {
            return currentVideoNo;
        }

        function getOrder() {
            return activeOrder;
        }

        function resolveState(options = {}) {
            if (options && typeof options === "object" && options.state?.videoNo !== undefined) {
                return options.state;
            }
            const videoNo = options && typeof options === "object" ? options.videoNo : undefined;
            const order = options && typeof options === "object" ? options.order : undefined;
            return getState(videoNo ?? currentVideoNo, order ?? activeOrder);
        }

        function abortStateObject(state) {
            if (!state) return false;
            const hadRequest = Boolean(state.controller || state.inFlight || state.loading);
            state.requestToken += 1;
            state.controller?.abort();
            state.controller = null;
            state.inFlight = null;
            state.loading = false;
            state.loadingMore = false;
            state.requestContext = null;
            touchState(state);
            return hadRequest;
        }

        function abortState(target = {}) {
            if (target?.videoNo !== undefined && target?.order !== undefined && target?.items) {
                return abortStateObject(target);
            }
            const state = resolveState(target);
            return abortStateObject(state);
        }

        function abortAll() {
            let aborted = false;
            for (const state of states.values()) {
                if (abortStateObject(state)) aborted = true;
            }
            return aborted;
        }

        function resetState(state) {
            abortStateObject(state);
            Object.assign(state, {
                capped: false,
                commentActive: true,
                error: "",
                hasMore: true,
                items: [],
                loaded: false,
                moreError: "",
                nextOffset: 0,
                scrollTop: 0,
                totalCount: null,
            });
            touchState(state);
            return state;
        }

        function reset(options = {}) {
            const nextOptions = typeof options === "string" ? { videoNo: options } : options || {};
            const nextVideoNo = compactText(nextOptions.videoNo ?? currentVideoNo);
            const nextOrder = normalizeOrder(nextOptions.order ?? DEFAULT_ORDER);
            abortAll();
            generation += 1;
            states.clear();
            currentVideoNo = nextVideoNo;
            activeOrder = nextOrder;
            return currentVideoNo ? getActiveState() : null;
        }

        function setVideo(videoNo) {
            const nextVideoNo = compactText(videoNo);
            if (nextVideoNo === currentVideoNo) return getActiveState();
            return reset({ videoNo: nextVideoNo, order: DEFAULT_ORDER });
        }

        function setOrder(order) {
            if (!isCommentOrder(order)) return false;
            if (order === activeOrder) return getActiveState();
            const previous = getActiveState();
            if (previous.loading || previous.inFlight) abortStateObject(previous);
            activeOrder = order;
            return getActiveState();
        }

        function setScrollTop(scrollTop, options = {}) {
            const state = resolveState(options);
            const value = Number(scrollTop);
            state.scrollTop = Number.isFinite(value) ? Math.max(0, value) : 0;
            return state.scrollTop;
        }

        function makeResult(status, state, { added = [], error = null, initial = false } = {}) {
            return { added, error, initial, state, status };
        }

        function isRequestCurrent(state, requestGeneration, token) {
            return generation === requestGeneration && state.requestToken === token;
        }

        function requestPage(state, { foreground, initial, offset }) {
            state.loading = true;
            state.loadingMore = !initial;
            state.error = "";
            state.moreError = "";
            const controller = new AbortController();
            state.controller = controller;
            const token = ++state.requestToken;
            const requestGeneration = generation;
            const requestContext = { foreground: foreground !== false };
            state.requestContext = requestContext;
            touchState(state);

            let fetched;
            try {
                fetched = fetchPage({
                    limit: normalizedPageSize,
                    objectId: state.videoNo,
                    offset,
                    orderType: state.order,
                    signal: controller.signal,
                });
            } catch (error) {
                fetched = Promise.reject(error);
            }

            const promise = Promise.resolve(fetched)
                .then((content) => {
                    if (generation !== requestGeneration) {
                        return makeResult("stale", state, { initial });
                    }
                    if (state.requestToken !== token) {
                        return makeResult(controller.signal.aborted ? "aborted" : "stale", state, { initial });
                    }
                    const applied = applyCommentPage(state.items, content, {
                        maxItems: commentLimit,
                        maxRepliesPerComment: perCommentReplyLimit,
                        maxRepliesTotal: totalReplyLimit,
                        offset,
                        pageSize: normalizedPageSize,
                    });
                    state.items = applied.items;
                    state.capped = applied.capped;
                    state.commentActive = applied.commentActive;
                    state.hasMore = applied.hasMore;
                    state.loaded = true;
                    state.nextOffset = applied.nextOffset;
                    if (applied.totalCount !== null) state.totalCount = applied.totalCount;
                    state.error = "";
                    state.moreError = "";
                    touchState(state);
                    return makeResult("loaded", state, { added: applied.added, initial });
                })
                .catch((error) => {
                    if (generation !== requestGeneration) return makeResult("stale", state, { error, initial });
                    if (state.requestToken !== token) {
                        return makeResult(controller.signal.aborted ? "aborted" : "stale", state, {
                            error,
                            initial,
                        });
                    }
                    if (controller.signal.aborted) return makeResult("aborted", state, { error, initial });

                    const message = error?.message || String(error);
                    if (initial) {
                        state.error = requestContext.foreground ? message : "";
                    } else {
                        state.moreError = message;
                    }
                    touchState(state);
                    return makeResult("error", state, { error, initial });
                })
                .then((result) => {
                    if (isRequestCurrent(state, requestGeneration, token) && state.inFlight === promise) {
                        state.loading = false;
                        state.loadingMore = false;
                        state.controller = null;
                        state.inFlight = null;
                        state.requestContext = null;
                        touchState(state);
                    }
                    return result;
                });

            state.inFlight = promise;
            return promise;
        }

        function skippedResult(state, initial) {
            return Promise.resolve(makeResult("skipped", state, { initial }));
        }

        function loadInitial(options = {}) {
            const state = resolveState(options);
            const foreground = options?.foreground !== false;
            if (!state.videoNo) return skippedResult(state, true);
            if (state.inFlight) {
                if (foreground && state.requestContext) {
                    state.requestContext.foreground = true;
                }
                return state.inFlight;
            }
            if (state.loaded) return skippedResult(state, true);
            return requestPage(state, { foreground, initial: true, offset: 0 });
        }

        function prefetchInitial(options = {}) {
            return loadInitial({ ...(options || {}), foreground: false });
        }

        function loadMore(options = {}) {
            const state = resolveState(options);
            if (!state.videoNo || !state.loaded || !state.hasMore || state.capped) {
                return skippedResult(state, false);
            }
            if (state.inFlight) return state.inFlight;
            return requestPage(state, {
                foreground: true,
                initial: false,
                offset: state.nextOffset,
            });
        }

        function refresh(options = {}) {
            const state = resolveState(options);
            resetState(state);
            if (!state.videoNo) return skippedResult(state, true);
            return requestPage(state, { foreground: true, initial: true, offset: 0 });
        }

        return Object.freeze({
            abortAll,
            abortState,
            getActiveState,
            getOrder,
            getState,
            getVideoNo,
            loadInitial,
            loadMore,
            prefetchInitial,
            refresh,
            reset,
            setOrder,
            setScrollTop,
            setVideo,
        });
    }

    namespace.repository = Object.freeze({ createCommentRepository });
})();
