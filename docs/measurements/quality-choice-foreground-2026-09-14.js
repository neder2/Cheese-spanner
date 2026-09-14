// 화질 선택에 개입하지 않고 현재 영상의 60초 진행 상태를 읽어요.
(() => {
    "use strict";
    const key = "bcFrameCheck";
    const path = "/live/75cbf189b3bb8f9f687d2aca0d0a382b";
    if (location.hostname !== "chzzk.naver.com" || location.pathname !== path)
        return console.log("같은 한동숙 방송에서 실행해 주세요.");
    if (Object.hasOwn(window, key)) return console.log("이미 관측 중이에요.");
    const selector = ".chzzk_player.type_live video.webplayer-internal-video";
    const video = document.querySelector(selector);
    if (!video || video.videoWidth !== 1920 || video.videoHeight !== 1080)
        return console.log("현재 영상이 1080p가 아니에요. 지금 상태를 알려 주세요.");
    if (document.hidden) return console.log("치지직 탭을 화면에 띄운 뒤 실행해 주세요.");
    const started = performance.now();
    const source = video.currentSrc;
    const rows = [];
    const timers = new Set();
    let active = true;
    let hiddenDuringCheck = false;
    const sample = () => {
        const quality = video.getVideoPlaybackQuality?.();
        rows.push({
            elapsedMs: Math.round(performance.now() - started),
            visibility: document.visibilityState,
            focused: document.hasFocus(),
            sameVideo: document.querySelector(selector) === video && video.isConnected,
            sameSource: video.currentSrc === source,
            width: video.videoWidth,
            height: video.videoHeight,
            currentTime: video.currentTime,
            totalVideoFrames: quality?.totalVideoFrames ?? null,
            droppedVideoFrames: quality?.droppedVideoFrames ?? null,
            paused: video.paused,
            readyState: video.readyState,
            errorCode: video.error?.code ?? null,
        });
    };
    const finish = (reason) => {
        if (!active) return;
        active = false;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        delete window[key];
        sample();
        console.log(
            JSON.stringify(
                {
                    probe: "quality-choice-foreground-2026-09-14",
                    measuredAt: new Date().toISOString(),
                    reason,
                    hiddenDuringCheck,
                    rows,
                },
                null,
                2
            )
        );
    };
    const onVisibility = () => {
        if (document.hidden) hiddenDuringCheck = true;
    };
    const onPageHide = () => finish("pagehide");
    Object.defineProperty(window, key, { configurable: true, value: Object.freeze({ stop: () => finish("manual") }) });
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    sample();
    for (const seconds of [15, 30, 60]) {
        const timer = setTimeout(() => {
            timers.delete(timer);
            if (!active) return;
            if (location.pathname !== path || document.querySelector(selector) !== video || !video.isConnected)
                return finish("context-changed");
            if (seconds === 60) finish("complete");
            else sample();
        }, seconds * 1000);
        timers.add(timer);
    }
    console.log("관측 시작: 화질을 바꾸지 말고 치지직 영상을 화면에 둔 채 60초 기다려 주세요.");
})();
