// Console용 일회성 관측이에요. 원래 선택 요청의 반환값을 그대로 돌려줘요.
// 해당 화질 메뉴 인스턴스의 $dispatch만 잠시 감싸고, 한 번 관측하거나 60초가 지나면 복원해요.
(() => {
    "use strict";

    const host = document.querySelector(".chzzk_player.type_live");
    const video = host?.querySelector("video.webplayer-internal-video");
    if (!host || !video) return console.log("라이브 영상이 재생되는 페이지에서 실행해 주세요.");
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
    let ownersChecked = 0;
    const consider = (candidate) => {
        if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
        seen.add(candidate);
        try {
            if (typeof candidate.getPreProcessorControl !== "function" || typeof candidate.querySelector !== "function")
                return;
            const root = candidate.shadowRoot;
            if (!(root instanceof Element) || !root.contains(video)) return;
            const pane = candidate.querySelector("pzp-setting-quality-pane");
            if (
                typeof pane?.$dispatch === "function" &&
                typeof pane.selectVideoTrack === "function" &&
                !matches.some((entry) => entry.vm === pane)
            ) {
                matches.push({ player: candidate, vm: pane });
            }
        } catch {
            /* 읽기 실패 시 해당 후보를 건너뛰어요. */
        }
    };
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
    if (matches.length !== 1) {
        console.log(
            JSON.stringify({
                error: "현재 영상에 연결된 화질 메뉴를 확인하지 못했어요. 이 결과를 보내주세요.",
                hasReactFiber: Boolean(fiberKey),
                ownersChecked,
                matches: matches.length,
            })
        );
        return;
    }

    const { player, vm } = matches[0];
    const original = vm.$dispatch;
    if (original.name === "qualityChoiceObserver") {
        console.warn("이미 관측 중이에요. 1080p를 한 번 선택해 주세요.");
        return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(vm, "$dispatch");
    const pagePath = location.pathname;
    let active = true;

    const trackInfo = (track) =>
        track
            ? {
                  id: track.id ?? null,
                  label: track.label ?? null,
                  kind: track.kind ?? null,
                  width: track.width ?? null,
                  height: track.height ?? null,
                  selected: Boolean(track.selected),
                  encodingTrackId: track.dataset?.encodingTrackId ?? null,
              }
            : null;
    const snapshot = () => {
        try {
            const video = host.querySelector("video.webplayer-internal-video");
            return {
                video: video
                    ? {
                          width: video.videoWidth,
                          height: video.videoHeight,
                          paused: video.paused,
                          readyState: video.readyState,
                          errorCode: video.error?.code ?? null,
                      }
                    : null,
                selectedTracks: Array.from(player.videoTracks || [])
                    .filter((track) => track.selected)
                    .map(trackInfo),
            };
        } catch {
            return { unavailable: true };
        }
    };
    const stop = () => {
        active = false;
        clearTimeout(timeout);
        if (vm.$dispatch !== wrapper) return;
        if (descriptor) Object.defineProperty(vm, "$dispatch", descriptor);
        else delete vm.$dispatch;
    };
    const wrapper = function qualityChoiceObserver(...args) {
        if (!active || args[0] !== "change" || !args[1]?.track) {
            return Reflect.apply(original, this, args);
        }
        if (location.pathname !== pagePath) {
            stop();
            return Reflect.apply(original, this, args);
        }
        let requestedTrack;
        try {
            requestedTrack = trackInfo(args[1].track);
        } catch {
            requestedTrack = { unavailable: true };
        }
        const before = snapshot();
        stop();
        const result = Reflect.apply(original, this, args);
        console.log(
            JSON.stringify(
                {
                    probe: "quality-choice-observer-v2-2026-09-14",
                    measuredAt: new Date().toISOString(),
                    requestedTrack,
                    dispatchAllowed: typeof result === "boolean" ? result : null,
                    returnType: typeof result,
                    before,
                },
                null,
                2
            )
        );
        setTimeout(() => {
            if (location.pathname === pagePath && host.isConnected) {
                console.log(JSON.stringify({ probe: "quality-choice-after-2s", after: snapshot() }, null, 2));
            }
        }, 2000);
        return result;
    };
    try {
        Object.defineProperty(vm, "$dispatch", { configurable: true, writable: true, value: wrapper });
    } catch {
        console.warn("이 화질 메뉴에는 관측을 설치할 수 없어요. 변경하지 않았어요.");
        return;
    }
    const timeout = setTimeout(() => {
        stop();
        console.log("관측 시간이 끝났고 원래 상태로 복원했어요.");
    }, 60000);
    console.log(
        "관측 준비 완료: 60초 안에 공식 화질 메뉴에서 1080p를 한 번 선택해 주세요. 선택 결과는 변경하지 않아요."
    );
})();
