/**
 * features/volumeWheelPage.js — 재생 화면에서 마우스 휠로 볼륨 컨트롤 위를 스크롤하면 영상 볼륨을 조절한다.
 *
 * 실행 컨텍스트: MAIN world(페이지 컨텍스트). document_start에 로드되며 전역 BetterChzzkSettings/BetterChzzk에
 *   접근할 수 없다 — 옵션은 isolated world의 volumeWheel.js가 DOM attribute/CustomEvent로 중계해준다.
 * 동작 위치: /live 또는 /video 라우트의 볼륨 컨트롤(.pzp-pc__volume 계열) 위.
 * 하는 일: window에 capture 단계 wheel 리스너를 설치해, 이벤트 경로가 볼륨 컨트롤과 겹치고 메인 video와
 *   같은 플레이어 컨텍스트에 있을 때만 deltaY 부호로 볼륨을 step만큼 증감시킨다. 확장 자체 미리보기 영상
 *   은 메인 video 후보에서 제외한다. 대상 판정은 shared/volumeControls.js를 사용한다. route bridge의
 *   betterchzzk:routechange와 기존 라우트 폴백마다 리스너 설치 여부를 다시 동기화한다.
 * 옵션 키: volumeWheelEnabled, volumeWheelStep (모두 volumeWheel.js를 통해 전달받음).
 * 통신: CONFIG_ATTR(data-betterchzzk-volume-wheel-options) attribute를 읽고, CONFIG_EVENT
 *   (betterchzzk:volume-wheel-options)를 window에서 수신해 옵션을 갱신한다.
 */
(() => {
    const CONFIG_EVENT = "betterchzzk:volume-wheel-options";
    const ROUTE_CHANGE_EVENT = "betterchzzk:routechange";
    const CONFIG_ATTR = "data-betterchzzk-volume-wheel-options";
    const { getVolumeControlCandidates, getVolumeControlForVideo, getMainVideoElement, isPlaybackRoute } =
        globalThis.BetterChzzkVolumeControls;

    let options = {
        enabled: false,
        step: 5,
    };
    let volumeApplyToken = 0;
    let wheelListenerInstalled = false;
    let routeSyncTimer = 0;

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getStepRatio() {
        const step = Number(options.step);
        return clamp(Number.isFinite(step) ? step : 5, 1, 50) / 100;
    }

    function commitVideoVolume(video, ratio) {
        const next = clamp(ratio, 0, 1);
        if (next <= 0) {
            video.volume = 0;
            video.muted = true;
            return;
        }

        if (video.muted) video.muted = false;
        video.volume = next;
        if (video.muted) video.muted = false;
    }

    function scheduleVolumeCommit(video, ratio, token) {
        const apply = () => {
            if (token !== volumeApplyToken) return;
            commitVideoVolume(video, ratio);
        };

        queueMicrotask(apply);
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
        setTimeout(apply, 0);
    }

    function applyVolumeDelta(video, directionSteps) {
        if (!(video instanceof HTMLVideoElement)) return false;

        const current = video.muted ? 0 : Number.isFinite(video.volume) ? video.volume : 0;
        const next = clamp(current + directionSteps * getStepRatio(), 0, 1);
        const token = ++volumeApplyToken;

        commitVideoVolume(video, next);
        scheduleVolumeCommit(video, next, token);
        return true;
    }

    function handleWheel(event) {
        if (!options.enabled || !isPlaybackRoute()) return;
        if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;

        const controls = getVolumeControlCandidates(event);
        if (!controls.length) return;

        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement)) return;

        const control = getVolumeControlForVideo(controls, video);
        if (!control) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const direction = event.deltaY < 0 ? 1 : -1;
        applyVolumeDelta(video, direction);
    }

    function parseOptions(value) {
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            if (!parsed || typeof parsed !== "object") return null;
            const step = Number(parsed.step);
            return {
                enabled: parsed.enabled === true,
                step: clamp(Number.isFinite(step) ? step : 5, 1, 50),
            };
        } catch {
            return null;
        }
    }

    function applyOptionsFromAttribute() {
        const parsed = parseOptions(document.documentElement.getAttribute(CONFIG_ATTR));
        if (parsed) options = parsed;
        syncWheelListener();
    }

    function installWheelListener() {
        if (wheelListenerInstalled) return;
        wheelListenerInstalled = true;
        window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    }

    function uninstallWheelListener() {
        if (!wheelListenerInstalled) return;
        wheelListenerInstalled = false;
        window.removeEventListener("wheel", handleWheel, true);
    }

    function syncWheelListener() {
        if (options.enabled && isPlaybackRoute()) installWheelListener();
        else uninstallWheelListener();
    }

    function scheduleWheelListenerSync() {
        if (routeSyncTimer) return;
        routeSyncTimer = window.setTimeout(() => {
            routeSyncTimer = 0;
            syncWheelListener();
        }, 0);
    }

    window.addEventListener(CONFIG_EVENT, applyOptionsFromAttribute, true);
    window.addEventListener(ROUTE_CHANGE_EVENT, syncWheelListener, true);
    window.addEventListener("popstate", syncWheelListener, true);
    window.addEventListener("hashchange", syncWheelListener, true);
    window.addEventListener("pageshow", syncWheelListener, true);
    document.addEventListener("click", scheduleWheelListenerSync, true);
    applyOptionsFromAttribute();
})();
