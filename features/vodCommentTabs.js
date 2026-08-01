/**
 * features/vodCommentTabs.js — VOD 댓글 탭 모듈의 옵션·라우트·mount 수명주기를 조립한다.
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트.
 * 의존: BetterChzzkSettings, BetterChzzk.utils, BetterChzzk.vodComments의 model/repository/
 *   nativeAdapter/view 모듈.
 * 옵션 키: vodCommentTabsEnabled.
 */
(() => {
    "use strict";

    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.vodCommentTabs) return;

    const {
        model,
        nativeAdapter: nativeAdapterModule,
        repository: repositoryModule,
        view: viewModule,
    } = root.vodComments;
    const {
        bindFeatureOptions,
        fetchChzzkCommentPage,
        getMainVideoElement,
        getVodVideoNoFromPath,
        injectStyleOnce,
        isVodRoute,
        startPageChangeDetection,
    } = root.utils;

    const MOUNT_SYNC_DELAY_MS = 80;
    const MOUNT_GAP_GRACE_MS = 600;
    const COMMENT_ONLY_ASIDE_ID = "betterchzzk-vod-comment-aside";
    const ANCHOR_SELECTOR = [
        "#player_layout",
        "#vod-aside",
        "#vod-aside [role='log']",
        "#vod-aside h1",
        "#vod-aside h2",
        "#vod-aside h3",
        "#vod-aside h4",
        "#vod-aside h5",
        "#vod-aside h6",
    ].join(",");

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let runtimeInstalled = false;
    let bodyObserver = null;
    let ensureTimerId = 0;
    let mountGapTimerId = 0;
    let commentPrefetchHandle = null;
    let commentPrefetchGeneration = 0;
    let requestPresentationGeneration = 0;
    let appliedEnabledState = null;
    let selectedTab = "chat";
    let activeOrder = model.DEFAULT_ORDER;
    let currentVideoNo = getVodVideoNoFromPath();
    let commentView = null;
    let commentOnlyAside = null;
    let commentOnlyHost = null;
    let commentOnlyVideoMoreColumn = null;
    let nativeChatShellSeen = false;
    let fullscreenListenerInstalled = false;

    const commentRepository = repositoryModule.createCommentRepository({
        fetchPage: fetchChzzkCommentPage,
        pageSize: model.COMMENT_PAGE_SIZE,
        maxCommentsPerOrder: model.MAX_COMMENTS_PER_ORDER,
        maxRepliesPerComment: model.MAX_REPLIES_PER_COMMENT,
        maxRepliesPerOrder: model.MAX_REPLIES_PER_ORDER,
    });
    commentRepository.setVideo(currentVideoNo);

    const nativeAdapter = nativeAdapterModule.createNativeAdapter({
        onMeasurements(measurements) {
            commentView?.applyNativeMeasurements(measurements);
        },
    });

    commentView = viewModule.createCommentView({
        injectStyleOnce,
        onLoadMore: (focusRequest) => loadMoreComments(focusRequest),
        onNativeAction: (control, action) => nativeAdapter.forwardAction(control, action),
        onOrderChange: (order, focusRequest) => changeOrder(order, focusRequest),
        onRefresh: (focusRequest) => refreshComments(focusRequest),
        onRendered: () => nativeAdapter.syncAll(),
        onRowRendered: (commentId) => nativeAdapter.syncCommentIds(new Set([commentId])),
        onRetryInitial: (focusRequest) => loadInitialComments({ focusRequest, refresh: true }),
        onScroll: (scrollTop) => {
            commentRepository.setScrollTop(scrollTop, { order: activeOrder, videoNo: currentVideoNo });
        },
        onTabChange: (tab, options) => selectTab(tab, options),
        onTimecode: (control) => activateCommentTimecode(control),
    });

    function isFeatureEnabled() {
        return featureOptions.vodCommentTabsEnabled === true;
    }

    function findNativeHeading(aside) {
        return Array.from(aside?.querySelectorAll?.("h1, h2, h3, h4, h5, h6") || []).find(
            (heading) => model.compactText(heading.textContent) === "라이브 채팅 다시보기"
        );
    }

    function removeCommentOnlyShell() {
        commentOnlyAside?.remove();
        if (commentOnlyHost?.getAttribute("data-bcvc-comment-only-host") === "1") {
            commentOnlyHost.removeAttribute("data-bcvc-comment-only-host");
        }
        commentOnlyVideoMoreColumn?.removeAttribute("data-bcvc-comment-only-vod-column");
        commentOnlyAside = null;
        commentOnlyHost = null;
        commentOnlyVideoMoreColumn = null;
    }

    function findCommentOnlyHost() {
        const player = document.getElementById("player_layout");
        if (!(player instanceof HTMLElement)) return null;
        const section = player.closest("section");
        if (!(section instanceof HTMLElement)) return null;

        let candidate = player;
        while (candidate.parentElement && candidate.parentElement !== section) {
            if (candidate.parentElement.parentElement === section) return candidate;
            candidate = candidate.parentElement;
        }
        return null;
    }

    function findRaisedVideoMoreColumn(section) {
        const heading = findVideoMoreHeading(section);
        let candidate = heading?.parentElement;
        while (candidate instanceof HTMLElement && candidate !== section) {
            if (Number.parseFloat(getComputedStyle(candidate).marginTop) < 0) return candidate;
            candidate = candidate.parentElement;
        }
        return null;
    }

    function isVideoMoreHeading(element) {
        return model.compactText(element?.textContent) === "영상 더보기";
    }

    function findVideoMoreHeading(rootElement) {
        return Array.from(rootElement?.querySelectorAll?.("h1, h2, h3, h4, h5, h6") || []).find(isVideoMoreHeading);
    }

    function containsVideoMoreHeading(element) {
        return Array.from(element?.querySelectorAll?.("h1, h2, h3, h4, h5, h6") || []).some(isVideoMoreHeading);
    }

    function syncCommentOnlyVideoMoreColumn() {
        const section = commentOnlyHost?.closest("section");
        if (!(section instanceof HTMLElement) || !commentOnlyAside?.isConnected) return;
        if (
            commentOnlyVideoMoreColumn?.isConnected &&
            section.contains(commentOnlyVideoMoreColumn) &&
            containsVideoMoreHeading(commentOnlyVideoMoreColumn)
        ) {
            return;
        }

        commentOnlyVideoMoreColumn?.removeAttribute("data-bcvc-comment-only-vod-column");
        commentOnlyVideoMoreColumn = findRaisedVideoMoreColumn(section);
        commentOnlyVideoMoreColumn?.setAttribute("data-bcvc-comment-only-vod-column", "1");
    }

    function resolveCommentOnlyAnchors() {
        const host = findCommentOnlyHost();
        if (!(host instanceof HTMLElement)) return null;

        if (commentOnlyAside?.isConnected && commentOnlyHost === host) {
            syncCommentOnlyVideoMoreColumn();
            const container = commentOnlyAside.querySelector("[data-bcvc-comment-only-container='1']");
            const header = commentOnlyAside.querySelector("[data-bcvc-comment-only-header='1']");
            const heading = header?.querySelector("h2");
            if (container instanceof HTMLElement && header instanceof HTMLElement && heading instanceof HTMLElement) {
                return {
                    appearanceHeading: findVideoMoreHeading(host.closest("section")),
                    aside: commentOnlyAside,
                    chatLog: null,
                    container,
                    header,
                    heading,
                };
            }
        }

        removeCommentOnlyShell();
        const aside = document.createElement("aside");
        aside.id = COMMENT_ONLY_ASIDE_ID;
        aside.setAttribute("data-bcvc-comment-only-aside", "1");
        const container = document.createElement("div");
        container.setAttribute("data-bcvc-comment-only-container", "1");
        const header = document.createElement("div");
        header.setAttribute("data-bcvc-comment-only-header", "1");
        const heading = document.createElement("h2");
        heading.textContent = "댓글";
        header.appendChild(heading);
        container.appendChild(header);
        aside.appendChild(container);
        host.setAttribute("data-bcvc-comment-only-host", "1");
        host.appendChild(aside);
        commentOnlyAside = aside;
        commentOnlyHost = host;
        syncCommentOnlyVideoMoreColumn();
        return {
            appearanceHeading: findVideoMoreHeading(host.closest("section")),
            aside,
            chatLog: null,
            container,
            header,
            heading,
        };
    }

    function resolveNativeAnchors() {
        if (!isFeatureEnabled() || !isVodRoute()) return null;
        const aside = document.querySelector("aside#vod-aside");
        if (!(aside instanceof HTMLElement)) {
            if (document.fullscreenElement || nativeChatShellSeen) {
                removeCommentOnlyShell();
                return null;
            }
            return resolveCommentOnlyAnchors();
        }
        removeCommentOnlyShell();

        const chatLog = aside.querySelector("[role='log']");
        const heading = findNativeHeading(aside);
        const header = heading?.parentElement;
        const container = header?.parentElement;
        if (!(chatLog instanceof HTMLElement) || !(heading instanceof HTMLElement)) return null;
        if (!(header instanceof HTMLElement) || !(container instanceof HTMLElement) || !container.contains(chatLog)) {
            return null;
        }
        nativeChatShellSeen = true;
        return { appearanceHeading: heading, aside, chatLog, container, header, heading };
    }

    function getActiveState() {
        return commentRepository.getState(currentVideoNo, activeOrder);
    }

    function saveActiveScroll() {
        if (selectedTab !== "comments" || !commentView.getPanel()) return;
        commentRepository.setScrollTop(commentView.getScrollTop(), {
            order: activeOrder,
            videoNo: currentVideoNo,
        });
    }

    function presentRequest(promise, { focusRequest = null, renderInitial = false } = {}) {
        const state = getActiveState();
        const presentation = ++requestPresentationGeneration;
        if (selectedTab === "comments") {
            if (renderInitial) commentView.renderState(state, { restoreScroll: false });
            else commentView.updateState(state);
        }

        Promise.resolve(promise).then((result) => {
            if (presentation !== requestPresentationGeneration) return;
            if (result.status === "stale" || result.status === "aborted") return;
            if (result.state !== getActiveState() || result.state.videoNo !== currentVideoNo) return;
            if (selectedTab !== "comments" || !commentView.getPanel()) return;

            if (result.status === "loaded" && !result.initial) {
                if (focusRequest && result.added[0]) focusRequest.resultKey = result.added[0].key;
                commentView.appendRows(result.state, result.added);
            } else if (result.initial) {
                commentView.renderState(result.state, { restoreScroll: false });
            } else {
                commentView.updateState(result.state);
            }
            commentView.restoreFocus(focusRequest);
        });
        return promise;
    }

    function loadInitialComments({ focusRequest = null, prefetch = false, refresh = false } = {}) {
        const options = { order: activeOrder, videoNo: currentVideoNo };
        const promise = refresh
            ? commentRepository.refresh(options)
            : prefetch
              ? commentRepository.prefetchInitial(options)
              : commentRepository.loadInitial({ ...options, foreground: true });
        return presentRequest(promise, {
            focusRequest,
            renderInitial: !prefetch && selectedTab === "comments",
        });
    }

    function loadMoreComments(focusRequest = null) {
        const promise = commentRepository.loadMore({ order: activeOrder, videoNo: currentVideoNo });
        return presentRequest(promise, { focusRequest });
    }

    function refreshComments(focusRequest = null) {
        return loadInitialComments({ focusRequest, refresh: true });
    }

    function showActiveComments({ focusRequest = null } = {}) {
        const state = getActiveState();
        commentView.setActiveOrder(activeOrder);
        if (!state.loaded && !state.error) {
            loadInitialComments({ focusRequest });
            return;
        }
        commentView.showState(state, { focusRequest });
    }

    function changeOrder(order, focusRequest = null) {
        if (!model.isCommentOrder(order) || order === activeOrder) return;
        saveActiveScroll();
        activeOrder = order;
        commentRepository.setOrder(order);
        commentView.setActiveOrder(order);
        showActiveComments({ focusRequest });
    }

    function selectTab(tab, options = {}) {
        if (selectedTab === "comments") saveActiveScroll();
        if (tab === "comments") cancelScheduledCommentPrefetch();
        selectedTab = tab === "comments" ? "comments" : "chat";
        commentView.setSelectedTab(selectedTab, options);
        if (selectedTab === "comments") showActiveComments();
    }

    function seekToCommentTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0 || !isVodRoute()) return false;
        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement)) return false;
        const duration = Number(video.duration);
        const target = Number.isFinite(duration) && duration >= 0 ? Math.min(seconds, duration) : seconds;
        try {
            video.currentTime = target;
            return true;
        } catch (_) {
            return false;
        }
    }

    function activateCommentTimecode(control) {
        if (nativeAdapter.forwardTimecode(control)) return true;
        return seekToCommentTime(Number(control.getAttribute("data-bcvc-seconds")));
    }

    function cancelScheduledCommentPrefetch() {
        const handle = commentPrefetchHandle;
        commentPrefetchHandle = null;
        commentPrefetchGeneration += 1;
        if (handle !== null && typeof window.cancelIdleCallback === "function") {
            window.cancelIdleCallback(handle);
        }
    }

    function canPrefetchInitialComments(videoNo) {
        if (
            !runtimeInstalled ||
            !isFeatureEnabled() ||
            !isVodRoute() ||
            selectedTab !== "chat" ||
            document.visibilityState !== "visible" ||
            window.navigator?.connection?.saveData === true ||
            !commentView.getPanel()?.isConnected ||
            videoNo !== getVodVideoNoFromPath()
        ) {
            return false;
        }
        const state = getActiveState();
        return !state.loaded && !state.loading && !state.error && state.items.length === 0;
    }

    function scheduleCommentPrefetch() {
        cancelScheduledCommentPrefetch();
        if (typeof window.requestIdleCallback !== "function") return;
        const videoNo = currentVideoNo;
        if (!videoNo || !canPrefetchInitialComments(videoNo)) return;
        const generation = commentPrefetchGeneration;
        commentPrefetchHandle = window.requestIdleCallback(() => {
            if (generation !== commentPrefetchGeneration) return;
            commentPrefetchHandle = null;
            if (!canPrefetchInitialComments(videoNo)) return;
            loadInitialComments({ prefetch: true });
        });
    }

    function mountView(anchors) {
        if (!(anchors.chatLog instanceof HTMLElement)) selectedTab = "comments";
        commentView.setActiveOrder(activeOrder);
        commentView.setSelectedTab(selectedTab);
        commentView.mount(anchors);
        nativeAdapter.attach({ panel: commentView.getPanel() });
        if (selectedTab === "comments") showActiveComments();
        else scheduleCommentPrefetch();
    }

    function reattachView(anchors) {
        saveActiveScroll();
        if (!commentView.reattach(anchors)) return false;
        nativeAdapter.attach({ panel: commentView.getPanel() });
        if (selectedTab === "comments") commentView.showState(getActiveState());
        else scheduleCommentPrefetch();
        return true;
    }

    function teardownMount({ abortRequests = false, preserveCommentOnlyShell = false } = {}) {
        cancelScheduledCommentPrefetch();
        clearEnsureTimer();
        clearMountGapTimer();
        if (abortRequests) commentRepository.abortAll();
        saveActiveScroll();
        nativeAdapter.detach();
        commentView.destroy();
        if (!preserveCommentOnlyShell) removeCommentOnlyShell();
    }

    function ensureMounted() {
        ensureTimerId = 0;
        if (!isFeatureEnabled() || !isVodRoute()) {
            teardownMount();
            return;
        }
        if (document.fullscreenElement) {
            teardownMount();
            return;
        }
        const anchors = resolveNativeAnchors();
        if (!anchors) {
            if (commentView.hasMount()) scheduleMountGapTeardown();
            return;
        }
        clearMountGapTimer();

        if (commentView.matchesShell(anchors) && commentView.ownedNodesConnected()) {
            if (commentView.getChatLog() !== anchors.chatLog) commentView.replaceChatLog(anchors.chatLog);
            else commentView.setHeaderAppearanceSource(anchors.appearanceHeading);
            nativeAdapter.refresh();
            return;
        }
        if (
            commentView.canReattach() &&
            Boolean(commentView.getChatLog()) === Boolean(anchors.chatLog) &&
            reattachView(anchors)
        ) {
            return;
        }
        teardownMount({ preserveCommentOnlyShell: anchors.aside === commentOnlyAside });
        mountView(anchors);
    }

    function clearEnsureTimer() {
        if (!ensureTimerId) return;
        clearTimeout(ensureTimerId);
        ensureTimerId = 0;
    }

    function clearMountGapTimer() {
        if (!mountGapTimerId) return;
        clearTimeout(mountGapTimerId);
        mountGapTimerId = 0;
    }

    function scheduleMountGapTeardown() {
        if (mountGapTimerId) return;
        mountGapTimerId = setTimeout(() => {
            mountGapTimerId = 0;
            if (runtimeInstalled && isFeatureEnabled() && isVodRoute() && resolveNativeAnchors()) {
                scheduleEnsureMounted({ immediate: true });
                return;
            }
            teardownMount({ abortRequests: true });
        }, MOUNT_GAP_GRACE_MS);
    }

    function scheduleEnsureMounted({ immediate = false } = {}) {
        if (immediate) {
            clearEnsureTimer();
            ensureMounted();
            return;
        }
        if (ensureTimerId) return;
        ensureTimerId = setTimeout(ensureMounted, MOUNT_SYNC_DELAY_MS);
    }

    function nodeCouldAffectAnchors(node) {
        return (
            node instanceof Element && (node.matches(ANCHOR_SELECTOR) || Boolean(node.querySelector?.(ANCHOR_SELECTOR)))
        );
    }

    function mutationCouldAffectAnchors(mutation) {
        if (mutation.type !== "childList") return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeCouldAffectAnchors);
    }

    function nodeCouldAffectNativeCommentArea(node) {
        return (
            node instanceof Element && (node.matches("#commentArea") || Boolean(node.querySelector?.("#commentArea")))
        );
    }

    function mutationCouldAffectNativeCommentArea(mutation) {
        if (mutation.type !== "childList") return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeCouldAffectNativeCommentArea);
    }

    function nodeCouldAffectVideoMoreColumn(node) {
        if (!(node instanceof Element)) return false;
        const headings = node.matches("h1, h2, h3, h4, h5, h6")
            ? [node]
            : node.querySelectorAll("h1, h2, h3, h4, h5, h6");
        return Array.from(headings).some(isVideoMoreHeading);
    }

    function mutationCouldAffectVideoMoreColumn(mutation) {
        if (mutation.type !== "childList") return false;
        return [...mutation.addedNodes, ...mutation.removedNodes].some(nodeCouldAffectVideoMoreColumn);
    }

    function installBodyObserver() {
        if (!document.documentElement || !isVodRoute()) return;
        nativeAdapter.refresh();
        if (bodyObserver) return;
        bodyObserver = new MutationObserver((mutations) => {
            if (!isFeatureEnabled() || !isVodRoute()) {
                if (!isVodRoute()) disconnectBodyObserver();
                teardownMount();
                return;
            }
            if (mutations.some(mutationCouldAffectNativeCommentArea)) nativeAdapter.refresh();
            if (commentOnlyAside?.isConnected && mutations.some(mutationCouldAffectVideoMoreColumn)) {
                syncCommentOnlyVideoMoreColumn();
                scheduleEnsureMounted();
            }
            if (commentView.isDisconnected()) scheduleEnsureMounted({ immediate: true });
            else if (mutations.some(mutationCouldAffectAnchors)) scheduleEnsureMounted();
        });
        bodyObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function disconnectBodyObserver() {
        bodyObserver?.disconnect();
        bodyObserver = null;
    }

    function handleFullscreenChange() {
        if (!runtimeInstalled || !isFeatureEnabled() || !isVodRoute()) return;
        if (document.fullscreenElement) {
            teardownMount();
            return;
        }
        installBodyObserver();
        scheduleEnsureMounted({ immediate: true });
    }

    function installFullscreenListener() {
        if (fullscreenListenerInstalled) return;
        document.addEventListener("fullscreenchange", handleFullscreenChange, true);
        fullscreenListenerInstalled = true;
    }

    function disconnectFullscreenListener() {
        if (!fullscreenListenerInstalled) return;
        document.removeEventListener("fullscreenchange", handleFullscreenChange, true);
        fullscreenListenerInstalled = false;
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        if (!isVodRoute()) {
            disconnectBodyObserver();
            teardownMount();
            return;
        }
        currentVideoNo = getVodVideoNoFromPath();
        commentRepository.setVideo(currentVideoNo);
        activeOrder = commentRepository.getOrder();
        installFullscreenListener();
        installBodyObserver();
        scheduleEnsureMounted({ immediate: true });
    }

    function uninstallRuntime() {
        if (!runtimeInstalled) return;
        runtimeInstalled = false;
        disconnectFullscreenListener();
        disconnectBodyObserver();
        teardownMount();
        commentRepository.reset({ order: model.DEFAULT_ORDER, videoNo: "" });
        requestPresentationGeneration += 1;
        activeOrder = model.DEFAULT_ORDER;
        selectedTab = "chat";
        nativeChatShellSeen = false;
        commentView.setActiveOrder(activeOrder);
        commentView.setSelectedTab(selectedTab);
    }

    function handlePageChange() {
        const videoNo = getVodVideoNoFromPath();
        if (videoNo === currentVideoNo) {
            if (isFeatureEnabled() && videoNo) {
                installFullscreenListener();
                installBodyObserver();
            } else {
                disconnectFullscreenListener();
            }
            return;
        }

        teardownMount();
        currentVideoNo = videoNo;
        nativeChatShellSeen = false;
        commentRepository.setVideo(videoNo);
        requestPresentationGeneration += 1;
        activeOrder = model.DEFAULT_ORDER;
        selectedTab = "chat";
        commentView.setActiveOrder(activeOrder);
        commentView.setSelectedTab(selectedTab);
        if (isFeatureEnabled() && videoNo) {
            installFullscreenListener();
            installBodyObserver();
            scheduleEnsureMounted();
        } else {
            disconnectFullscreenListener();
            disconnectBodyObserver();
        }
    }

    function applyOptions(options) {
        featureOptions = options;
        const enabled = isFeatureEnabled();
        if (enabled === appliedEnabledState) return;

        const wasEnabled = appliedEnabledState;
        appliedEnabledState = enabled;
        if (enabled) installRuntime();
        else if (wasEnabled === true) uninstallRuntime();
    }

    startPageChangeDetection(handlePageChange);
    bindFeatureOptions(applyOptions);

    root.vodCommentTabs = Object.freeze({ parseTimecodeSeconds: model.parseTimecodeSeconds });
})();
