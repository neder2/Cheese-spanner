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
        startPageChangeDetection,
        mutationMatchesSelector,
        injectStyleOnce,
        fetchJson,
    } = BetterChzzk.utils;
    const ID = "betterchzzk-stream-info";
    const SETTINGS_MENU = ':scope > .pzp-pc__settings[role="menu"]';
    const UNKNOWN = "측정 불가";
    let enabled = false;
    let suspended = false;
    let observer = null;
    let removeRoute = null;
    let video = null;
    let player = null;
    let settingsMenu = null;
    let settingsItem = null;
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
        updateSettingsItem();
        if (focus) focusPlayer();
    }

    function focusPlayer() {
        const target =
            player?.querySelector(".pzp-setting-button") ||
            (player?.hasAttribute("tabindex") ? player : player?.querySelector("button") || video);
        target?.focus({ preventScroll: true });
    }

    function updateSettingsItem() {
        if (!settingsItem) return;
        const label = settingsItem.querySelector(".pzp-ui-setting-home-item__label");
        const text = panel ? "스트림 정보 닫기" : "스트림 정보 열기";
        if (label.textContent !== text) label.textContent = text;
        const expanded = String(Boolean(panel));
        if (settingsItem.getAttribute("aria-expanded") !== expanded) {
            settingsItem.setAttribute("aria-expanded", expanded);
        }
    }

    function onSettingsItemClick(event) {
        event.stopPropagation();
        if (
            !enabled ||
            suspended ||
            !isPlaybackRoute() ||
            !video?.isConnected ||
            !player?.isConnected ||
            !player.contains(video) ||
            event.currentTarget !== settingsItem ||
            settingsItem.parentElement !== player.querySelector(SETTINGS_MENU)
        )
            return;
        player.querySelector('.pzp-setting-button[aria-expanded="true"]')?.click();
        togglePanel(event);
    }

    function onSettingsItemKeyDown(event) {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) event.currentTarget.click();
    }

    function onSettingsNavigation(event) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
        if (!settingsItem?.isConnected || event.target.parentElement !== settingsMenu) return;
        const items = Array.from(settingsMenu.children).filter(
            (item) =>
                item.getAttribute("role") === "menuitem" &&
                item.getClientRects().length &&
                getComputedStyle(item).visibility !== "hidden"
        );
        const index = items.indexOf(event.target);
        if (index < 0) return;
        const next =
            event.key === "Home"
                ? items[0]
                : event.key === "End"
                  ? items[items.length - 1]
                  : items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length];
        // The native keyboard list excludes injected rows; bridge only transitions involving our entry.
        if (event.target !== settingsItem && next !== settingsItem) return;
        event.preventDefault();
        event.stopPropagation();
        next.focus();
    }

    function removeSettingsItem() {
        settingsMenu?.removeEventListener("keydown", onSettingsNavigation, true);
        settingsMenu = null;
        settingsItem?.removeEventListener("click", onSettingsItemClick);
        settingsItem?.removeEventListener("keydown", onSettingsItemKeyDown);
        settingsItem?.remove();
        settingsItem = null;
    }

    function syncSettingsItem() {
        const container = player.querySelector(SETTINGS_MENU);
        if (settingsItem?.parentElement === container) return;
        removeSettingsItem();
        if (!container) return;
        settingsMenu = container;
        settingsItem = document.createElement("button");
        settingsItem.id = `${ID}-settings-item`;
        settingsItem.className = "pzp-ui-setting-home-item";
        settingsItem.type = "button";
        settingsItem.setAttribute("role", "menuitem");
        settingsItem.setAttribute("aria-controls", ID);
        const top = document.createElement("span");
        top.className = "pzp-ui-setting-home-item__top";
        const left = document.createElement("span");
        left.className = "pzp-ui-setting-home-item__left";
        const label = document.createElement("span");
        label.className = "pzp-ui-setting-home-item__label";
        left.append(label);
        top.append(left);
        settingsItem.append(top);
        updateSettingsItem();
        settingsItem.addEventListener("click", onSettingsItemClick);
        settingsItem.addEventListener("keydown", onSettingsItemKeyDown);
        settingsMenu.addEventListener("keydown", onSettingsNavigation, true);
        container.append(settingsItem);
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
            closePanel(true);
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
            ["bitrate", "비트레이트"],
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
        panel.append(header, list);
        player.append(panel);
        updateSettingsItem();
        startSampling();
        close.focus();
    }

    function unmount() {
        removeSettingsItem();
        closePanel();
        video?.removeEventListener("emptied", onSourceReset);
        video = player = null;
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
        if (!nextVideo || !nextPlayer?.contains(nextVideo)) {
            unmount();
            return;
        }
        if (video !== nextVideo || player !== nextPlayer || (panel && !panel.isConnected)) {
            unmount();
            video = nextVideo;
            player = nextPlayer;
            video.addEventListener("emptied", onSourceReset);
        }
        syncSettingsItem();
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
.pzp-ui-setting-home-item:where(#${ID}-settings-item){display:block;width:100%;border:0;background:transparent;text-align:left}
#${ID}{position:absolute;z-index:100;top:16px;right:16px;box-sizing:border-box;width:360px;max-width:calc(100% - 32px);max-height:calc(100% - 80px);overflow:auto;padding:16px;border:1px solid var(--Border-neutral-weak,#dadde3);border-radius:12px;background:var(--Surface-neutral-base,#fff);color:var(--Content-neutral-strong,#20242c);font:13px/1.5 sans-serif;box-shadow:0 8px 28px #0004;cursor:auto;user-select:text}
html.theme_dark #${ID}{background:var(--Surface-neutral-base,#202124);color:var(--Content-neutral-strong,#f1f3f5);border-color:var(--Border-neutral-weak,#454850)}
#${ID} header{display:flex;align-items:center;justify-content:space-between;gap:12px}#${ID} strong{font-size:16px}
#${ID} button{background:transparent;color:inherit;border:1px solid currentColor;border-radius:6px;min-height:32px;padding:4px 10px;cursor:pointer}
#${ID} button:focus-visible,#${ID}-settings-item:focus-visible{outline:2px solid #00d694;outline-offset:-2px}
#${ID} dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:9px 12px;margin:16px 0 0}#${ID} dt,#${ID} dd{margin:0;overflow-wrap:anywhere}#${ID} dd{text-align:right;font-variant-numeric:tabular-nums}
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
                    (panel && !panel.isConnected) ||
                    (settingsItem && !settingsItem.isConnected) ||
                    mutations.some((mutation) => mutationMatchesSelector(mutation, "video, .pzp-pc, .pzp-pc__settings"))
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
