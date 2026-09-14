// Read-only playback diagnostics. Sampling and live metadata requests run only while open.
(() => {
    "use strict";
    if (BetterChzzk.streamInfo) return;
    BetterChzzk.streamInfo = {};
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        getMainVideoElement,
        getPlayerRoot,
        isPlaybackRoute,
        isLiveRoute,
        startPageChangeDetection,
        mutationMatchesSelector,
        injectStyleOnce,
        fetchJson,
    } = BetterChzzk.utils;
    const ID = "betterchzzk-stream-info";
    const UNKNOWN = "측정 불가";
    let enabled = false;
    let suspended = false;
    let observer = null;
    let removeRoute = null;
    let video = null;
    let player = null;
    let button = null;
    let panel = null;
    let timer = null;
    let previous = null;
    let request = null;
    let tracks = [];
    let metadataState = "";
    const values = new Map();

    function setValue(key, value) {
        const element = values.get(key);
        if (element && element.textContent !== value) element.textContent = value;
    }

    function inspectGraphicsAcceleration() {
        let context;
        try {
            const canvas = document.createElement("canvas");
            context = canvas.getContext("webgl");
            const extension = context?.getExtension("WEBGL_debug_renderer_info");
            if (!extension) return "확인 불가";
            const renderer = String(context.getParameter(extension.UNMASKED_RENDERER_WEBGL) || "").trim();
            if (!renderer) return "확인 불가";
            return /swiftshader|llvmpipe|software|basic render/i.test(renderer) ? "미사용 (소프트웨어)" : "사용 중";
        } catch {
            return "확인 불가";
        } finally {
            try {
                context?.getExtension("WEBGL_lose_context")?.loseContext();
            } catch {
                // A lost or restricted context must not prevent opening diagnostics.
            }
        }
    }

    function stopSampling() {
        clearInterval(timer);
        timer = null;
        previous = null;
        request?.abort();
        request = null;
        tracks = [];
        metadataState = "";
    }

    function closePanel(focus = false) {
        stopSampling();
        panel?.remove();
        panel = null;
        values.clear();
        button?.setAttribute("aria-expanded", "false");
        if (focus) button?.focus();
    }

    function onKeyDown(event) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closePanel(true);
    }

    function readTracks(content) {
        if (content?.status !== "OPEN") return [];
        const playback = JSON.parse(content.livePlaybackJson);
        return (Array.isArray(playback?.media) ? playback.media : []).flatMap((media) =>
            Array.isArray(media.encodingTrack) ? media.encodingTrack : []
        );
    }

    async function loadMetadata() {
        const channel = location.pathname.match(/^\/live\/([a-zA-Z0-9_-]+)\/?$/)?.[1];
        if (!channel) return;
        const controller = new AbortController();
        request = controller;
        metadataState = "불러오는 중";
        render();
        try {
            const json = await fetchJson(
                `https://api.chzzk.naver.com/service/v3/channels/${encodeURIComponent(channel)}/live-detail`,
                { signal: controller.signal }
            );
            if (controller.signal.aborted || request !== controller || !panel) return;
            tracks = readTracks(json?.content);
            metadataState = "";
        } catch {
            if (controller.signal.aborted || request !== controller) return;
            metadataState = "정보 조회 실패";
        }
        if (request === controller) request = null;
        render();
    }

    function render() {
        if (!panel || !video?.isConnected || document.hidden) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        setValue("quality", width && height ? `${width} × ${height}` : "영상 준비 중");
        const matches = tracks.filter(
            (track) => Number(track.videoWidth) === width && Number(track.videoHeight) === height
        );
        const rates = [
            ...new Set(
                matches.map((track) => Number(track.videoBitRate)).filter((rate) => Number.isFinite(rate) && rate > 0)
            ),
        ];
        setValue(
            "bitrate",
            rates.length === 1
                ? `${Math.round(rates[0] / 1000).toLocaleString("en-US")} kbps`
                : metadataState || UNKNOWN
        );
        let buffered = null;
        for (let i = 0; i < video.buffered.length; i++) {
            if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
                buffered = video.buffered.end(i) - video.currentTime;
                break;
            }
        }
        setValue("buffer", buffered === null ? "현재 위치에 버퍼 없음" : `${buffered.toFixed(2)}초`);
        const end = video.seekable.length ? video.seekable.end(video.seekable.length - 1) : NaN;
        const lag = end - video.currentTime;
        setValue(
            "delay",
            !isLiveRoute() ? "다시보기 해당 없음" : Number.isFinite(lag) && lag >= 0 ? `${lag.toFixed(2)}초` : UNKNOWN
        );
        setValue(
            "state",
            video.error
                ? "재생 오류"
                : video.ended
                  ? "재생 종료"
                  : video.paused
                    ? "일시정지"
                    : video.readyState < 3
                      ? "버퍼 대기"
                      : "재생 중"
        );
        setValue("speed", `${video.playbackRate.toFixed(2)}배`);
        const quality = video.getVideoPlaybackQuality?.();
        const total = quality?.totalVideoFrames;
        const dropped = quality?.droppedVideoFrames;
        const valid = Number.isFinite(total) && Number.isFinite(dropped) && total >= dropped && dropped >= 0;
        const now = performance.now();
        const source = video.currentSrc;
        const elapsed = previous ? (now - previous.time) / 1000 : 0;
        if (
            valid &&
            previous &&
            previous.source === source &&
            elapsed >= 0.5 &&
            total >= previous.total &&
            dropped >= previous.dropped
        ) {
            const presented = total - previous.total - (dropped - previous.dropped);
            setValue(
                "fps",
                video.paused || video.seeking ? "측정 대기" : `${Math.max(0, presented / elapsed).toFixed(1)} FPS`
            );
        } else if (!previous) setValue("fps", valid ? "측정 중" : UNKNOWN);
        if (valid && (!previous || elapsed >= 0.5)) previous = { time: now, total, dropped, source };
    }

    function startSampling() {
        if (!panel || document.hidden || timer) return;
        render();
        void loadMetadata();
        timer = setInterval(render, 1000);
    }

    function togglePanel(event) {
        event.stopPropagation();
        if (panel) {
            closePanel();
            return;
        }
        panel = document.createElement("section");
        panel.id = ID;
        panel.setAttribute("role", "region");
        panel.setAttribute("aria-label", "스트림 정보 (치즈 스패너)");
        panel.addEventListener("keydown", onKeyDown);
        panel.addEventListener("click", (e) => e.stopPropagation());
        const header = document.createElement("header");
        const title = document.createElement("strong");
        title.textContent = "스트림 정보";
        const close = document.createElement("button");
        close.type = "button";
        close.textContent = "닫기";
        close.setAttribute("aria-label", "스트림 정보 닫기");
        close.addEventListener("click", () => closePanel(true));
        header.append(title, close);
        const list = document.createElement("dl");
        for (const [key, label] of [
            ["quality", "현재 해상도"],
            ["bitrate", "영상 비트레이트 · 설정값"],
            ["delay", "라이브 끝과의 차이"],
            ["buffer", "남은 재생 버퍼"],
            ["fps", "FPS"],
            ["hardware", "하드웨어 가속"],
            ["state", "재생 상태"],
            ["speed", "재생 속도"],
        ]) {
            const term = document.createElement("dt");
            term.textContent = label;
            const value = document.createElement("dd");
            value.textContent = UNKNOWN;
            values.set(key, value);
            list.append(term, value);
        }
        setValue("hardware", inspectGraphicsAcceleration());
        values.get("hardware").title = "WebGL 렌더러 기준이며 현재 영상의 하드웨어 디코딩 여부와 다를 수 있어요.";
        const note = document.createElement("p");
        note.textContent =
            "비트레이트는 현재 해상도에 맞는 라이브 제공값이며 실제 전송 속도와 달라요. 딜레이는 촬영 시점부터의 지연이 아니에요. 하드웨어 가속은 WebGL 렌더러 기준으로, 영상 디코딩 여부와 다를 수 있어요. CPU·GPU 사용률은 제공하지 않아요.";
        panel.append(header, list, note);
        player.append(panel);
        button.setAttribute("aria-expanded", "true");
        startSampling();
        close.focus();
    }

    function unmount() {
        closePanel();
        video?.removeEventListener("emptied", onSourceReset);
        button?.remove();
        video = player = button = null;
    }

    function onSourceReset() {
        closePanel();
    }

    function sync() {
        if (!enabled || suspended || !isPlaybackRoute()) {
            unmount();
            return;
        }
        const nextVideo = getMainVideoElement();
        const nextPlayer = getPlayerRoot(nextVideo);
        const controls = nextPlayer?.querySelector(".pzp-pc__bottom-buttons-right");
        if (!nextVideo || !nextPlayer?.contains(nextVideo) || !controls) {
            unmount();
            return;
        }
        if (
            video === nextVideo &&
            player === nextPlayer &&
            button?.parentElement === controls &&
            (!panel || panel.isConnected)
        )
            return;
        unmount();
        video = nextVideo;
        player = nextPlayer;
        video.addEventListener("emptied", onSourceReset);
        button = document.createElement("button");
        button.id = `${ID}-button`;
        button.type = "button";
        button.className = "pzp-button pzp-pc-ui-button";
        const icon = document.createElement("span");
        icon.className = "pzp-ui-icon";
        icon.innerHTML =
            '<svg class="pzp-ui-icon__svg" xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true" focusable="false"><circle cx="18" cy="18" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M18 17v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="18" cy="13.5" r="1.1" fill="currentColor"/></svg>';
        button.append(icon);
        button.title = "스트림 정보 (치즈 스패너)";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("aria-controls", ID);
        const tooltip = document.createElement("span");
        tooltip.className = "pzp-button__tooltip pzp-button__tooltip--top";
        tooltip.textContent = "스트림 정보";
        button.prepend(tooltip);
        button.addEventListener("click", togglePanel);
        controls.prepend(button);
    }

    function routeChanged() {
        unmount();
        sync();
    }
    function visibilityChanged() {
        if (document.hidden) stopSampling();
        else startSampling();
    }
    function pageHide() {
        suspended = true;
        stopRuntime();
    }
    function pageShow() {
        suspended = false;
        if (enabled) startRuntime();
    }

    function startRuntime() {
        if (observer || suspended) return;
        injectStyleOnce(
            `${ID}-style`,
            `
#${ID}-button{opacity:0;pointer-events:none;min-width:36px;min-height:36px}
.pzp-pc.pzp-pc--controls #${ID}-button,#${ID}-button:focus-visible{opacity:1;pointer-events:auto}
.pzp-pc.pzp-pc--dialog #${ID}-button{display:none}
#${ID}{position:absolute;z-index:100;top:16px;right:16px;box-sizing:border-box;width:360px;max-width:calc(100% - 32px);max-height:calc(100% - 80px);overflow:auto;padding:16px;border:1px solid var(--Border-neutral-weak,#dadde3);border-radius:12px;background:var(--Surface-neutral-base,#fff);color:var(--Content-neutral-strong,#20242c);font:13px/1.5 sans-serif;box-shadow:0 8px 28px #0004;cursor:auto;user-select:text}
html.theme_dark #${ID}{background:var(--Surface-neutral-base,#202124);color:var(--Content-neutral-strong,#f1f3f5);border-color:var(--Border-neutral-weak,#454850)}
#${ID} header{display:flex;align-items:center;justify-content:space-between;gap:12px}#${ID} strong{font-size:16px}
#${ID} button{background:transparent;color:inherit;border:1px solid currentColor;border-radius:6px;min-height:32px;padding:4px 10px;cursor:pointer}
#${ID} button:focus-visible,#${ID}-button:focus-visible{outline:2px solid #00d694;outline-offset:3px}
#${ID} dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px 12px;margin:16px 0}#${ID} dt,#${ID} dd{margin:0;overflow-wrap:anywhere}#${ID} dd{text-align:right;font-variant-numeric:tabular-nums}#${ID} p{margin:0;font-size:12px;line-height:1.6}
`
        );
        removeRoute = startPageChangeDetection(routeChanged);
        document.addEventListener("visibilitychange", visibilityChanged);
        observer = createMutationObserverSync({
            onBodyReady: sync,
            onMutations(mutations) {
                if (!isPlaybackRoute()) return;
                if (
                    (video && !video.isConnected) ||
                    (button && !button.isConnected) ||
                    mutations.some((mutation) =>
                        mutationMatchesSelector(mutation, "video, .pzp-pc, .pzp-pc__bottom-buttons-right")
                    )
                )
                    sync();
            },
        });
        sync();
    }

    function stopRuntime() {
        observer?.disconnectAll();
        observer = null;
        removeRoute?.();
        removeRoute = null;
        document.removeEventListener("visibilitychange", visibilityChanged);
        unmount();
        document.getElementById(`${ID}-style`)?.remove();
    }

    bindFeatureOptions((options) => {
        enabled = options.streamInfoEnabled !== false;
        window.removeEventListener("pagehide", pageHide);
        window.removeEventListener("pageshow", pageShow);
        if (enabled) {
            window.addEventListener("pagehide", pageHide);
            window.addEventListener("pageshow", pageShow);
            startRuntime();
        } else stopRuntime();
    });
})();
