// Console용 실험: 같은 방송의 1080p 선택이 취소되면 반환값만 한 번 true로 바꿔요.
// URL·UA·재생 메타데이터·JSON.parse·전역 이벤트 메서드를 변경하지 않아요.
(() => {
    "use strict";

    const expectedPath = "/live/75cbf189b3bb8f9f687d2aca0d0a382b";
    if (location.hostname !== "chzzk.naver.com" || location.pathname !== expectedPath) {
        console.log("같은 한동숙 방송 페이지에서 실행해 주세요.");
        return;
    }
    if (
        JSON.parse.__betterChzzkGridBypassParseWrapped ||
        document.documentElement.getAttribute("data-betterchzzk-grid-bypass-state") === "1"
    ) {
        console.log("기존 그리드 기능의 개입이 보여요. 확장을 끄고 새로고침해 주세요.");
        return;
    }
    const host = document.querySelector(".chzzk_player.type_live");
    const video = host?.querySelector("video.webplayer-internal-video");
    if (!host || !video) return console.log("라이브 영상을 찾지 못했어요.");
    const read = (object, key) => {
        try {
            return object?.[key];
        } catch {
            return undefined;
        }
    };
    const fiberKey = Object.getOwnPropertyNames(host).find((key) => key.startsWith("__reactFiber$"));
    const seen = new Set();
    const matches = [];
    const consider = (candidate) => {
        if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
        seen.add(candidate);
        try {
            if (typeof candidate.getPreProcessorControl !== "function" || typeof candidate.querySelector !== "function")
                return;
            if (!(candidate.shadowRoot instanceof Element) || !candidate.shadowRoot.contains(video)) return;
            const pane = candidate.querySelector("pzp-setting-quality-pane");
            if (
                typeof pane?.$dispatch === "function" &&
                typeof pane.selectVideoTrack === "function" &&
                !matches.some((item) => item.vm === pane)
            ) {
                matches.push({ player: candidate, vm: pane });
            }
        } catch {
            // 접근할 수 없는 후보는 제외해요.
        }
    };
    let ownersChecked = 0;
    for (let fiber = fiberKey ? host[fiberKey] : null; fiber && ownersChecked < 8; fiber = read(fiber, "return")) {
        ownersChecked++;
        for (const owner of [fiber, read(fiber, "alternate")]) {
            let hook = read(owner, "memoizedState");
            for (let index = 0; hook && index < 48; index++, hook = read(hook, "next")) {
                const value = read(hook, "memoizedState");
                consider(value);
                consider(read(value, "current"));
            }
        }
    }
    if (matches.length !== 1)
        return console.log(JSON.stringify({ error: "player_not_found", ownersChecked, matches: matches.length }));
    const { player, vm } = matches[0];
    const original = vm.$dispatch;
    if (["qualityChoiceObserver", "qualityChoiceOnce"].includes(original.name)) {
        console.log("이전 임시 코드가 아직 대기 중이에요. 60초 뒤 다시 실행해 주세요.");
        return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(vm, "$dispatch");
    let active = true;
    const snapshot = () => {
        try {
            const currentVideo = host.querySelector("video.webplayer-internal-video");
            return {
                video: currentVideo
                    ? {
                          width: currentVideo.videoWidth,
                          height: currentVideo.videoHeight,
                          paused: currentVideo.paused,
                          readyState: currentVideo.readyState,
                          errorCode: currentVideo.error?.code ?? null,
                      }
                    : null,
                selectedTracks: Array.from(player.videoTracks || [])
                    .filter((track) => track.selected)
                    .map((track) => ({
                        id: track.id,
                        label: track.label,
                        kind: track.kind,
                        width: track.width,
                        height: track.height,
                    })),
            };
        } catch {
            return { unavailable: true };
        }
    };
    const restore = () => {
        active = false;
        clearTimeout(expiry);
        if (vm.$dispatch !== wrapper) return;
        if (descriptor) Object.defineProperty(vm, "$dispatch", descriptor);
        else delete vm.$dispatch;
    };
    const wrapper = function qualityChoiceOnce(...args) {
        const track = args[1]?.track;
        if (
            !active ||
            this !== vm ||
            args[0] !== "change" ||
            track?.width !== 1920 ||
            track?.height !== 1080 ||
            track?.kind !== "low-latency" ||
            track?.dataset?.encodingTrackId !== "1080p"
        ) {
            return Reflect.apply(original, this, args);
        }
        restore();
        if (location.pathname !== expectedPath || !host.isConnected || !host.contains(video))
            return Reflect.apply(original, this, args);

        const before = snapshot();
        const parseBefore = JSON.parse;
        const providerBefore = read(player, "srcObject");
        const resources = new Map();
        let observer;
        try {
            observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
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
                        const extension =
                            url.pathname.match(/\.(m3u8|m4s|ts|mp4|aac)$/i)?.[1]?.toLowerCase() || "other";
                        const key = `${url.host}|${extension}`;
                        if (!resources.has(key) && resources.size >= 16) continue;
                        const value = resources.get(key) || { host: url.host, type: extension, local, count: 0 };
                        value.count++;
                        resources.set(key, value);
                    } catch {
                        // 해석할 수 없는 리소스는 기록하지 않아요.
                    }
                }
            });
            observer.observe({ type: "resource", buffered: false });
        } catch {
            observer?.disconnect();
            observer = undefined;
        }

        let originalAllowed;
        try {
            originalAllowed = Reflect.apply(original, this, args);
        } catch (error) {
            observer?.disconnect();
            throw error;
        }
        const usedReturn = originalAllowed === false ? true : originalAllowed;
        console.log(
            JSON.stringify(
                {
                    probe: "quality-choice-once",
                    measuredAt: new Date().toISOString(),
                    originalAllowed: typeof originalAllowed === "boolean" ? originalAllowed : null,
                    usedReturn: typeof usedReturn === "boolean" ? usedReturn : null,
                    returnType: typeof originalAllowed,
                    changed: originalAllowed === false,
                    before,
                },
                null,
                2
            )
        );
        for (const seconds of [2, 10]) {
            setTimeout(() => {
                if (seconds === 10) observer?.disconnect();
                if (location.pathname !== expectedPath || !host.isConnected) return;
                console.log(
                    JSON.stringify(
                        {
                            probe: `quality-choice-once-after-${seconds}s`,
                            after: snapshot(),
                            sameParseFunction: JSON.parse === parseBefore,
                            sameProviderObject:
                                providerBefore === undefined ? null : read(player, "srcObject") === providerBefore,
                            resourceObserverAvailable: Boolean(observer),
                            observedResources: Array.from(resources.values()),
                        },
                        null,
                        2
                    )
                );
            }, seconds * 1000);
        }
        return usedReturn;
    };
    try {
        Object.defineProperty(vm, "$dispatch", { configurable: true, writable: true, value: wrapper });
    } catch {
        return console.log("이번 플레이어에는 실험을 준비할 수 없어요.");
    }
    const expiry = setTimeout(() => {
        restore();
        console.log("대기 시간이 끝나 원래 함수로 복원했어요.");
    }, 60000);
    console.log("실험 준비 완료: 60초 안에 1080p를 한 번 선택하고, 안내 팝업은 10초 동안 그대로 두세요.");
})();
