// Console용 3분 실험. 확인된 1080p 선택의 취소 결과만 변경해요.
// 종료는 임시 함수·관측을 해제하며, 이미 선택된 화질이나 저장값을 되돌리지는 않아요.
(() => {
    "use strict";
    const key = "bcQualityTrial";
    const path = "/live/75cbf189b3bb8f9f687d2aca0d0a382b";
    const notice = (message) => console.log(`[화질 실험] ${message}`);
    if (location.hostname !== "chzzk.naver.com" || location.pathname !== path)
        return notice("같은 한동숙 방송 페이지에서 실행해 주세요.");
    if (Object.hasOwn(window, key)) return notice("이미 실행한 실험이 있어요. 새로고침해야 새 실험을 시작해요.");
    if (
        JSON.parse.__betterChzzkGridBypassParseWrapped ||
        document.documentElement.getAttribute("data-betterchzzk-grid-bypass-state") === "1"
    )
        return notice("기존 그리드 기능의 개입이 보여요. 확장을 끄고 새로고침해 주세요.");
    const host = document.querySelector(".chzzk_player.type_live");
    const video = host?.querySelector("video.webplayer-internal-video");
    if (!video) return notice("라이브 영상을 찾지 못했어요.");
    const read = (object, name) => {
        try {
            return object?.[name];
        } catch {
            return undefined;
        }
    };
    const fiberKey = Object.getOwnPropertyNames(host).find((name) => name.startsWith("__reactFiber$"));
    const seen = new Set();
    const matches = [];
    const consider = (candidate) => {
        if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
        seen.add(candidate);
        try {
            if (
                typeof candidate.getPreProcessorControl !== "function" ||
                typeof candidate.querySelector !== "function" ||
                !(candidate.shadowRoot instanceof Element) ||
                !candidate.shadowRoot.contains(video)
            )
                return;
            const pane = candidate.querySelector("pzp-setting-quality-pane");
            if (
                typeof pane?.$dispatch === "function" &&
                typeof pane.selectVideoTrack === "function" &&
                !matches.some((match) => match.vm === pane)
            )
                matches.push({ player: candidate, vm: pane });
        } catch {
            // 접근할 수 없는 후보는 제외해요.
        }
    };
    let owner = fiberKey ? host[fiberKey] : null;
    for (let depth = 0; owner && depth < 8; depth++, owner = read(owner, "return")) {
        for (const fiber of [owner, read(owner, "alternate")]) {
            let hook = read(fiber, "memoizedState");
            for (let index = 0; hook && index < 48; index++, hook = read(hook, "next")) {
                const value = read(hook, "memoizedState");
                consider(value);
                consider(read(value, "current"));
            }
        }
    }
    if (matches.length !== 1) return notice(`플레이어를 하나로 확인하지 못했어요. 후보: ${matches.length}`);
    const { player, vm } = matches[0];
    const original = vm.$dispatch;
    if (["qualityChoiceObserver", "qualityChoiceOnce", "qualityChoiceSession"].includes(original.name))
        return notice("이전 임시 코드가 남아 있어요. 새로고침한 뒤 실행해 주세요.");
    const descriptor = Object.getOwnPropertyDescriptor(vm, "$dispatch");
    if (descriptor && !descriptor.configurable) return notice("이번 플레이어에는 실험을 설치할 수 없어요.");
    const parseBefore = JSON.parse;
    const providerBefore = read(player, "srcObject");
    const runId = new Date().toISOString();
    const started = performance.now();
    const rows = [];
    const resources = new Map();
    const timers = new Set();
    let active = false;
    let choice = 0;
    let choiceTimer;
    let observer;
    let endReason = null;
    const trackInfo = (track) => ({
        label: String(track.label ?? "").slice(0, 40),
        width: track.width,
        height: track.height,
        kind: String(track.kind ?? "").slice(0, 40),
        encodingTrackId: String(track.dataset?.encodingTrackId ?? "").slice(0, 40),
    });
    const snapshot = () => {
        try {
            const quality = video.getVideoPlaybackQuality?.();
            return {
                video: {
                    width: video.videoWidth,
                    height: video.videoHeight,
                    currentTime: video.currentTime,
                    totalVideoFrames: quality?.totalVideoFrames ?? null,
                    droppedVideoFrames: quality?.droppedVideoFrames ?? null,
                    paused: video.paused,
                    readyState: video.readyState,
                    errorCode: video.error?.code ?? null,
                    connected: video.isConnected,
                },
                selectedTracks: Array.from(player.videoTracks || [])
                    .filter((track) => track.selected)
                    .slice(0, 8)
                    .map(trackInfo),
                sameParseFunction: JSON.parse === parseBefore,
                sameProviderObject: providerBefore === undefined ? null : read(player, "srcObject") === providerBefore,
            };
        } catch {
            return { unavailable: true };
        }
    };
    const record = (phase, extra = {}, state = snapshot()) => {
        if (rows.length >= 48) return;
        rows.push({
            phase,
            choice,
            measuredAt: new Date().toISOString(),
            elapsedMs: Math.round(performance.now() - started),
            ...extra,
            state,
        });
    };
    const report = () =>
        console.log(
            JSON.stringify(
                {
                    probe: "quality-choice-session-2026-09-14",
                    runId,
                    active,
                    endReason,
                    resourceObserverAvailable: Boolean(observer),
                    rows,
                    observedResources: Array.from(resources.values()),
                },
                null,
                2
            )
        );
    const current = () => {
        try {
            return (
                location.pathname === path &&
                host.isConnected &&
                host.contains(video) &&
                player.querySelector("pzp-setting-quality-pane") === vm &&
                JSON.parse === parseBefore &&
                read(player, "srcObject") === providerBefore
            );
        } catch {
            return false;
        }
    };
    const collect = (entries) => {
        for (const entry of entries) {
            try {
                const url = new URL(entry.name);
                const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
                if (
                    !local &&
                    !["livecloud.pstatic.net", "nvelop-livecloud.pstatic.net", "navercdn.com"].some(
                        (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
                    )
                )
                    continue;
                const type = url.pathname.match(/\.(m3u8|m4s|ts|mp4|aac)$/i)?.[1]?.toLowerCase() || "other";
                const bucket = `${url.host}|${type}`;
                if (!resources.has(bucket) && resources.size >= 16) continue;
                const value = resources.get(bucket) || { host: url.host, type, local, count: 0 };
                value.count++;
                resources.set(bucket, value);
            } catch {
                // 해석할 수 없는 리소스 이름은 기록하지 않아요.
            }
        }
    };
    const stop = (reason = "manual") => {
        if (!active) return;
        active = false;
        endReason = reason;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        if (observer) {
            collect(observer.takeRecords());
            observer.disconnect();
        }
        for (const type of ["popstate", "hashchange", "pagehide"]) window.removeEventListener(type, onNavigation);
        if (vm.$dispatch === wrapper) {
            if (descriptor) Object.defineProperty(vm, "$dispatch", descriptor);
            else delete vm.$dispatch;
        }
        record("stop", { reason, methodRestored: vm.$dispatch === original });
        notice(`종료했어요 (${reason}). 임시 개입만 해제하며, 선택한 화질은 그대로일 수 있어요.`);
        report();
    };
    const onNavigation = () => stop("navigation");
    const schedule = (milliseconds, callback) => {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!active) return;
            if (!current()) return stop("context-changed");
            callback();
        }, milliseconds);
        timers.add(timer);
        return timer;
    };
    const wrapper = function qualityChoiceSession(...args) {
        if (!active) return Reflect.apply(original, this, args);
        if (!current() || performance.now() - started >= 180000) {
            stop(current() ? "time-limit" : "context-changed");
            return Reflect.apply(original, this, args);
        }
        const track = args[1]?.track;
        if (this !== vm || args[0] !== "change" || !track) return Reflect.apply(original, this, args);
        if (choice >= 12) {
            stop("choice-limit");
            return Reflect.apply(original, this, args);
        }
        const before = snapshot();
        const target =
            track.width === 1920 &&
            track.height === 1080 &&
            track.kind === "low-latency" &&
            track.dataset?.encodingTrackId === "1080p";
        let result;
        try {
            result = Reflect.apply(original, this, args);
        } catch (error) {
            stop("dispatch-error");
            throw error;
        }
        const changed = active && current() && performance.now() - started < 180000 && target && result === false;
        const usedReturn = changed ? true : result;
        choice++;
        record(
            "choice",
            {
                requested: trackInfo(track),
                changed,
                originalAllowed: typeof result === "boolean" ? result : null,
                usedReturn: typeof usedReturn === "boolean" ? usedReturn : null,
                returnType: typeof result,
            },
            before
        );
        notice(`선택 #${choice}: ${track.label} / 취소 결과 변경=${changed}`);
        if (!active) return usedReturn;
        if (!current() || performance.now() - started >= 180000) {
            stop(current() ? "time-limit" : "context-changed");
            return usedReturn;
        }
        clearTimeout(choiceTimer);
        timers.delete(choiceTimer);
        choiceTimer = schedule(10000, () => {
            record("after-choice-10s");
            notice(`선택 #${choice} 관측: ${video.videoWidth}×${video.videoHeight}. 다음 화질을 선택해도 돼요.`);
        });
        return usedReturn;
    };
    try {
        Object.defineProperty(window, key, {
            configurable: true,
            value: Object.freeze({ report, stop: () => stop("manual") }),
        });
        Object.defineProperty(vm, "$dispatch", { configurable: true, writable: true, value: wrapper });
    } catch {
        delete window[key];
        return notice("실험을 설치하지 못했어요.");
    }
    active = true;
    try {
        observer = new PerformanceObserver((list) => {
            if (!active) return;
            if (!current()) return stop("context-changed");
            collect(list.getEntries());
        });
        observer.observe({ type: "resource", buffered: false });
    } catch {
        observer?.disconnect();
        observer = undefined;
    }
    for (const type of ["popstate", "hashchange", "pagehide"]) window.addEventListener(type, onNavigation);
    record("start");
    for (const seconds of [60, 120]) schedule(seconds * 1000, () => record(`after-start-${seconds}s`));
    schedule(180000, () => stop("time-limit"));
    notice("3분 실험 시작. 1080p → 480p → 1080p 순서로 각각 10초 이상 두세요. 팝업은 일반화질로 시청으로 닫아 주세요.");
    notice("마지막에는 1080p로 두세요. 3분 뒤 전체 결과를 출력해요. 조기 종료: bcQualityTrial.stop()");
})();
