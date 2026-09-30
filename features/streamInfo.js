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
    const AD_VIDEO = '[data-role="imaAdContainerEl"], [data-role="gvAdContainerEl"], #midAdPlayerWrapper';
    const PREVIEW_VIDEO = "[data-bcfp-player-mount], .bcfp-player, [data-bcfp-tooltip], [data-bcmv-video]";
    const UNKNOWN = "측정 불가";
    const WAITING = "측정 대기";
    const MEDIA_EVENTS = [
        "waiting",
        "stalled",
        "playing",
        "pause",
        "seeking",
        "seeked",
        "emptied",
        "loadedmetadata",
        "error",
        "ended",
        "ratechange",
    ];
    const MODE_LABELS = { "low-latency": "저지연", standard: "일반", unknown: "확인 불가" };
    const STATE_LABELS = {
        waiting: "측정 준비 중",
        measuring: "측정 중",
        buffering: "버퍼 대기",
        hidden: "탭 숨김",
        paused: "일시정지",
        seeking: "탐색 중",
        ad: "광고 재생 중",
        transition: "영상 전환 중",
        error: "재생 오류",
        ended: "재생 종료",
        "invalid-rate": "배속 확인 불가",
    };
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
    let metadataNeeded = true;
    let livePanel = false;
    let panelRoute = "";
    let liveId = null;
    let pendingIdentity = null;
    let transitioning = false;
    let model = null;
    let view = null;
    let lastSource = null;
    let sourceSequence = 0;
    let sourceToken = "";
    let requestSequence = 0;
    let currentNative = null;
    let lastNativeIdentity = null;
    let lastInput = null;
    const values = new Map();
    const isLiveRoute = () => /^\/live\/[^/]+\/?$/.test(location.pathname);

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
        if (request) metadataNeeded = true;
        request?.abort();
        request = null;
    }

    function closePanel(focus = false) {
        stopSampling();
        panel?.remove();
        panel = null;
        model = view = lastSource = currentNative = pendingIdentity = lastNativeIdentity = lastInput = null;
        liveId = null;
        transitioning = livePanel = false;
        tracks = [];
        metadataState = "";
        metadataNeeded = true;
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
        if (!channel || !panel || document.hidden || !video?.isConnected || request || !metadataNeeded) return;
        const target = video;
        const source = target.currentSrc;
        const route = location.pathname;
        const controller = new AbortController();
        request = controller;
        metadataNeeded = false;
        metadataState = "불러오는 중";
        render();
        try {
            const json = await fetchJson(
                `https://api.chzzk.naver.com/service/v3/channels/${encodeURIComponent(channel)}/live-detail`,
                { signal: controller.signal }
            );
            if (controller.signal.aborted || request !== controller || !panel) return;
            if (video !== target || target.currentSrc !== source || location.pathname !== route || document.hidden) {
                metadataNeeded = true;
                return;
            }
            const verifiedBroadcast =
                json?.code === 200 && json.content?.status === "OPEN" && json.content.channel?.channelId === channel;
            const id = verifiedBroadcast ? json.content.liveId : null;
            const nextId = Number.isSafeInteger(id) && id > 0 ? String(id) : null;
            if (
                (pendingIdentity && (!nextId || nextId !== pendingIdentity.liveId)) ||
                (liveId && nextId && liveId !== nextId)
            )
                model?.reset();
            liveId = nextId;
            pendingIdentity = null;
            transitioning = false;
            tracks = verifiedBroadcast ? readTracks(json.content) : [];
            metadataState = verifiedBroadcast ? "" : "방송 정보 확인 불가";
        } catch {
            if (controller.signal.aborted || request !== controller) return;
            if (pendingIdentity) model?.reset();
            pendingIdentity = null;
            liveId = null;
            transitioning = false;
            metadataState = "정보 조회 실패";
        } finally {
            if (request === controller) request = null;
        }
        if (model) view = model.read(performance.now());
        render();
    }

    function beginSourceTransition() {
        if (!panel || !livePanel) return;
        pendingIdentity ||= { liveId };
        transitioning = true;
        request?.abort();
        request = null;
        metadataNeeded = true;
        tracks = [];
        currentNative = null;
        lastNativeIdentity = null;
        lastSource = {
            video: video?.isConnected ? video : null,
            src: video?.isConnected ? video.currentSrc : null,
            token: null,
        };
        sourceToken = `stream-${++sourceSequence}`;
        view = model.switchSource(performance.now());
        void loadMetadata();
    }

    function readCurrentNative(target) {
        const requestId = `stream-info-${++requestSequence}`;
        const route = location.pathname;
        try {
            target.removeAttribute("data-bcsi-result");
            target.setAttribute("data-bcsi-request", JSON.stringify({ version: 1, requestId }));
            target.dispatchEvent(new Event("betterchzzk:stream-info:read"));
            const raw = target.getAttribute("data-bcsi-result");
            if (!raw || raw.length > 4096) return null;
            const result = JSON.parse(raw);
            const dimension = (value) => value === null || (Number.isFinite(value) && value > 0);
            if (
                !result ||
                result.version !== 1 ||
                result.requestId !== requestId ||
                result.route !== route ||
                location.pathname !== route ||
                video !== target ||
                !target.isConnected ||
                result.status !== "ready" ||
                result.reason !== "ok" ||
                !Object.hasOwn(MODE_LABELS, result.mode) ||
                !(result.trackId === null || typeof result.trackId === "string") ||
                !(
                    result.sourceToken === null ||
                    (typeof result.sourceToken === "string" && result.sourceToken.length <= 128)
                ) ||
                !dimension(result.trackWidth) ||
                !dimension(result.trackHeight) ||
                !(result.onLive === null || typeof result.onLive === "boolean")
            )
                return null;
            return result;
        } catch {
            return null;
        } finally {
            target.removeAttribute("data-bcsi-request");
            target.removeAttribute("data-bcsi-result");
        }
    }

    function readRanges(ranges) {
        try {
            return Array.from({ length: ranges.length }, (_, index) => ({
                start: ranges.start(index),
                end: ranges.end(index),
            }));
        } catch {
            return null;
        }
    }

    function isAdvertisement() {
        return Boolean(
            video?.closest(AD_VIDEO) ||
            player?.matches(".pzp-pc--adbreak") ||
            Array.from(player?.querySelectorAll(".pzp-pc--adbreak") || []).some(
                (node) => !node.closest(PREVIEW_VIDEO) && node.closest(".pzp-pc") === player
            )
        );
    }

    function snapshot(readNative = false) {
        const target = video?.isConnected && !video.closest(`${AD_VIDEO}, ${PREVIEW_VIDEO}`) ? video : null;
        const ad = isAdvertisement();
        let native = target && !ad ? (readNative ? readCurrentNative(target) : currentNative) : null;
        const src = target?.currentSrc ?? null;
        let token = native?.sourceToken ?? null;
        if (
            lastSource &&
            (lastSource.video !== target ||
                lastSource.src !== src ||
                (readNative && token && lastNativeIdentity?.video === target && lastNativeIdentity.token !== token))
        ) {
            lastSource = { video: target, src, token };
            beginSourceTransition();
            if (!readNative) native = token = null;
        }
        if (!lastSource || (readNative && lastSource.token !== token)) sourceToken = `stream-${++sourceSequence}`;
        lastSource = { video: target, src, token };
        if (readNative && token) lastNativeIdentity = { video: target, token };
        currentNative = native;
        let frames = null;
        const framesSupported = typeof target?.getVideoPlaybackQuality === "function";
        try {
            frames = framesSupported ? target.getVideoPlaybackQuality() : null;
        } catch {
            /* Unreadable counters remain missing. */
        }
        return {
            now: performance.now(),
            sourceToken,
            currentTime: target?.currentTime ?? null,
            seekable: target ? readRanges(target.seekable) : null,
            buffered: target ? readRanges(target.buffered) : null,
            readyState: target?.readyState ?? 0,
            paused: target?.paused ?? false,
            seeking: target?.seeking ?? false,
            ended: target?.ended ?? false,
            error: target?.error ?? null,
            ad,
            transitioning: transitioning || !target,
            hidden: document.hidden,
            playbackRate: target?.playbackRate ?? null,
            framesSupported,
            frames,
            mode: ad ? "unknown" : (native?.mode ?? "unknown"),
            onLive: ad ? null : (native?.onLive ?? null),
        };
    }

    function collect(type = null) {
        if (!panel || document.hidden) return;
        if (livePanel) {
            const input = snapshot(!type);
            if (!panel || !model || panelRoute !== location.pathname) return;
            lastInput = input;
            view = type ? model.event(type, input) : model.sample(input);
        }
        if (metadataNeeded) void loadMetadata();
        render();
    }

    function render() {
        if (!panel || document.hidden) return;
        if (!video?.isConnected) {
            for (const key of ["quality", "bitrate", "speed", "fps"]) setValue(key, WAITING);
            if (livePanel) renderLive();
            return;
        }
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
        if (!livePanel) {
            let buffered = null;
            for (let i = 0; i < video.buffered.length; i++) {
                if (video.buffered.start(i) <= video.currentTime && video.currentTime <= video.buffered.end(i)) {
                    buffered = video.buffered.end(i) - video.currentTime;
                    break;
                }
            }
            setValue("buffer", buffered === null ? "현재 위치에 버퍼 없음" : `${buffered.toFixed(2)}초`);
        }
        const media = livePanel ? lastInput : video;
        setValue(
            "state",
            media?.error
                ? "재생 오류"
                : media?.ended
                  ? "재생 종료"
                  : media?.paused
                    ? "일시정지"
                    : media?.readyState < 3
                      ? "버퍼 대기"
                      : "재생 중"
        );
        setValue("speed", Number.isFinite(media?.playbackRate) ? `${media.playbackRate.toFixed(2)}배` : UNKNOWN);
        if (livePanel) {
            renderLive();
            return;
        }
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

    function renderLive() {
        if (!view) return;
        const seconds = (value) => (Number.isFinite(value) ? `${value.toFixed(1)}초` : WAITING);
        setValue("mode", MODE_LABELS[view.current.state === "ad" ? "unknown" : (currentNative?.mode ?? "unknown")]);
        setValue("delay", seconds(view.current.delay));
        setValue("buffer", seconds(view.current.buffer));
        setValue(
            "stalls",
            view.observedSeconds > 0
                ? `${view.stalls.count}회 · ${view.stalls.seconds.toFixed(1)}초${view.stalls.ongoing ? " (대기 중)" : ""}`
                : WAITING
        );
        setValue(
            "drops",
            view.frames.state === "unsupported"
                ? UNKNOWN
                : view.frames.state === "ready"
                  ? `${view.frames.dropped}개 · ${view.frames.percent.toFixed(1)}%`
                  : WAITING
        );
        setValue(
            "fps",
            view.frames.state === "unsupported"
                ? UNKNOWN
                : Number.isFinite(view.frames.fps)
                  ? `${view.frames.fps.toFixed(1)} FPS`
                  : WAITING
        );
        if (["ad", "transition"].includes(view.current.state)) setValue("state", STATE_LABELS[view.current.state]);
        setValue(
            "observation",
            `최근 60초 중 ${view.observedSeconds.toFixed(1)}초 관측 · ${STATE_LABELS[view.current.state] || WAITING}${currentNative?.onLive === false && view.current.state !== "ad" ? " · 되감기 시청 중" : ""}`
        );
        renderGraph();
    }

    function svgElement(name, attributes = {}) {
        const element = document.createElementNS("http://www.w3.org/2000/svg", name);
        for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
        return element;
    }

    function renderGraph() {
        const graph = panel.querySelector("svg");
        if (!graph || !view) return;
        const maximum = Math.max(
            1,
            ...view.samples.flatMap((point) => [point.delay, point.buffer]).filter(Number.isFinite)
        );
        const top = Math.ceil(maximum);
        const x = (at) => 30 + 262 * Math.max(0, Math.min(1, (at - view.now + view.windowMs) / view.windowMs));
        const y = (value) => 92 - (80 * value) / top;
        const nodes = [];
        const axis = svgElement("path", { d: "M30 12V92H292", class: "bcsi-axis" });
        nodes.push(axis);
        for (const [label, atX, atY, anchor] of [
            [`${top}초`, 26, 16, "end"],
            ["0", 26, 95, "end"],
            ["60초 전", 30, 112, "start"],
            ["현재", 292, 112, "end"],
        ]) {
            const text = svgElement("text", { x: atX, y: atY, "text-anchor": anchor });
            text.textContent = label;
            nodes.push(text);
        }
        for (const key of ["delay", "buffer"]) {
            let previousPoint = null;
            const commands = [];
            for (const point of view.samples) {
                if (!Number.isFinite(point[key])) {
                    previousPoint = null;
                    continue;
                }
                const connected = previousPoint && !point.gap && point.segment === previousPoint.segment;
                commands.push(`${connected ? "L" : "M"}${x(point.at).toFixed(1)} ${y(point[key]).toFixed(1)}`);
                previousPoint = point;
            }
            nodes.push(svgElement("path", { "data-series": key, d: commands.join(" "), class: `bcsi-${key}` }));
        }
        let previousMode = null;
        for (const point of view.samples) {
            if (point.mode === "unknown") continue;
            if (previousMode && point.mode !== previousMode) {
                const marker = svgElement("line", {
                    x1: x(point.at),
                    x2: x(point.at),
                    y1: 12,
                    y2: 92,
                    "data-mode-change": point.mode,
                    class: "bcsi-mode-marker",
                });
                const title = svgElement("title");
                title.textContent = `${MODE_LABELS[point.mode]}으로 변경`;
                marker.append(title);
                nodes.push(marker);
            }
            previousMode = point.mode;
        }
        graph.replaceChildren(...nodes);
        setValue(
            "graph-description",
            `가로축은 60초 전부터 현재까지, 세로축은 0~${top}초예요. 현재 실선은 라이브 지연(추정) ${values.get("delay").textContent}, 점선은 재생 버퍼 ${values.get("buffer").textContent}예요. ${view.observedSeconds.toFixed(1)}초를 관측했고 측정하지 않은 구간은 연결하지 않아요.`
        );
    }

    function startSampling() {
        if (!panel || document.hidden || timer) return;
        collect();
        void loadMetadata();
        timer = setInterval(collect, 1000);
    }

    function togglePanel(event) {
        event.stopPropagation();
        if (panel) {
            closePanel(true);
            return;
        }
        panel = document.createElement("section");
        panelRoute = location.pathname;
        livePanel = isLiveRoute();
        model = livePanel
            ? BetterChzzk.streamInfoModel.create({ sampleIntervalMs: 1000, stallThresholdMs: 500 })
            : null;
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
        panel.append(header);
        const appendList = (items, className = "") => {
            const list = document.createElement("dl");
            list.className = className;
            for (const [key, label] of items) {
                const term = document.createElement("dt");
                term.textContent = label;
                const value = document.createElement("dd");
                value.textContent = UNKNOWN;
                value.dataset.bcsiValue = key;
                values.set(key, value);
                list.append(term, value);
            }
            panel.append(list);
        };
        if (livePanel) {
            appendList(
                [
                    ["mode", "현재 재생 방식"],
                    ["delay", "라이브 지연(추정)"],
                ],
                "bcsi-current"
            );
            values.get("delay").title =
                "네이티브 라이브 끝 기준의 추정치이며, 촬영부터 화면까지의 전체 지연이 아니에요.";
            const figure = document.createElement("figure");
            const legend = document.createElement("div");
            legend.className = "bcsi-legend";
            for (const [key, label] of [
                ["delay", "라이브 지연(추정) · 실선"],
                ["buffer", "재생 버퍼 · 점선"],
            ]) {
                const item = document.createElement("span");
                item.className = `bcsi-${key}`;
                item.textContent = label;
                legend.append(item);
            }
            const graph = svgElement("svg", {
                viewBox: "0 0 300 120",
                role: "img",
                "aria-label": "최근 60초의 라이브 지연과 재생 버퍼",
                "aria-describedby": `${ID}-graph-description`,
            });
            const caption = document.createElement("figcaption");
            caption.id = `${ID}-graph-description`;
            values.set("graph-description", caption);
            figure.append(legend, graph, caption);
            const markerLegend = document.createElement("span");
            markerLegend.textContent = "세로 점선: 재생 방식 변경";
            legend.append(markerLegend);
            panel.append(figure);
            const observation = document.createElement("p");
            observation.className = "bcsi-observation";
            values.set("observation", observation);
            panel.append(observation);
            appendList([
                ["buffer", "남은 재생 버퍼"],
                ["stalls", "관측 끊김"],
                ["drops", "프레임 누락"],
                ["fps", "FPS"],
            ]);
        }
        appendList([
            ["quality", "현재 해상도"],
            ["bitrate", livePanel ? "비트레이트 (API 설정값)" : "비트레이트"],
            ...(!livePanel
                ? [
                      ["buffer", "남은 재생 버퍼"],
                      ["fps", "FPS"],
                  ]
                : []),
            ["hardware", "하드웨어 가속"],
            ["state", "재생 상태"],
            ["speed", "재생 속도"],
        ]);
        setValue("hardware", inspectGraphicsAcceleration());
        values.get("hardware").title = "WebGL 렌더러 기준이며 현재 영상의 하드웨어 디코딩 여부와 다를 수 있어요.";
        player.append(panel);
        updateSettingsItem();
        startSampling();
        close.focus();
    }

    function unmount() {
        removeSettingsItem();
        closePanel();
        for (const type of MEDIA_EVENTS) video?.removeEventListener(type, onMediaEvent);
        video = player = null;
    }

    function onMediaEvent(event) {
        if (event.currentTarget !== video || !panel) return;
        if (!livePanel) {
            if (event.type === "emptied") closePanel();
            return;
        }
        if (event.type === "emptied") beginSourceTransition();
        collect(event.type);
    }

    function sync() {
        if (!enabled || suspended || !isPlaybackRoute()) {
            unmount();
            return;
        }
        const nextVideo = getMainVideoElement();
        const nextPlayer = getPlayerRoot(nextVideo);
        if (!nextVideo || !nextPlayer?.contains(nextVideo)) {
            if (panel && livePanel && panelRoute === location.pathname) {
                if (video) {
                    for (const type of MEDIA_EVENTS) video.removeEventListener(type, onMediaEvent);
                    video = null;
                    beginSourceTransition();
                }
                removeSettingsItem();
                view = model.suspend(performance.now(), isAdvertisement() ? "ad" : "transition");
                render();
                return;
            }
            unmount();
            return;
        }
        if (video !== nextVideo || player !== nextPlayer || (panel && !panel.isConnected)) {
            const changedVideo = video !== nextVideo;
            if (!(panel && livePanel && panelRoute === location.pathname)) unmount();
            else {
                removeSettingsItem();
                for (const type of MEDIA_EVENTS) video?.removeEventListener(type, onMediaEvent);
            }
            video = nextVideo;
            player = nextPlayer;
            for (const type of MEDIA_EVENTS) video.addEventListener(type, onMediaEvent);
            if (panel) {
                if (panel.parentElement !== player) player.append(panel);
                if (changedVideo) {
                    lastNativeIdentity = null;
                    lastSource = { video, src: video.currentSrc, token: null };
                    beginSourceTransition();
                }
            }
        }
        syncSettingsItem();
    }

    function routeChanged() {
        unmount();
        sync();
    }
    function visibilityChanged() {
        if (document.hidden) {
            stopSampling();
            if (model) view = model.suspend(performance.now());
        } else startSampling();
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
.pzp-ui-setting-home-item:where(#${ID}-settings-item){display:block;width:100%;border:0;background:transparent;text-align:start}
#${ID}{position:absolute;z-index:100;inset-block-start:8px;inset-inline-end:8px;box-sizing:border-box;inline-size:400px;max-inline-size:calc(100% - 16px);max-block-size:calc(100% - 64px);overflow:auto;overscroll-behavior:contain;padding:0 16px 16px;border:1px solid var(--Border-neutral-weak,#dadde3);border-radius:12px;background:var(--Surface-neutral-base,#fff);color:var(--Content-neutral-strong,#20242c);font:13px/1.5 sans-serif;box-shadow:0 8px 28px #0004;cursor:auto;user-select:text;--bcsi-delay:#007d59;--bcsi-buffer:#405bd8}
html.theme_dark #${ID}{background:var(--Surface-neutral-base,#202124);color:var(--Content-neutral-strong,#f1f3f5);border-color:var(--Border-neutral-weak,#454850)}
#${ID} header{position:sticky;inset-block-start:0;z-index:1;background:inherit;display:flex;align-items:center;justify-content:space-between;gap:12px;padding-block:12px}#${ID} strong{font-size:16px}
#${ID} button{background:transparent;color:inherit;border:1px solid currentColor;border-radius:6px;min-height:32px;padding:4px 10px;cursor:pointer}
#${ID} button:focus-visible,#${ID}-settings-item:focus-visible{outline:2px solid #00d694;outline-offset:-2px}
#${ID} dl{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px 12px;margin:16px 0 0}#${ID} dt,#${ID} dd{margin:0;overflow-wrap:anywhere}#${ID} dd{text-align:end;font-variant-numeric:tabular-nums}
#${ID} .bcsi-current{margin-block-start:8px}#${ID} .bcsi-current dd{font-weight:700}
#${ID} figure{margin:16px 0 0}#${ID} .bcsi-legend{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12px}
#${ID} .bcsi-legend span:before{content:"";display:inline-block;inline-size:18px;border-block-start:2px solid;vertical-align:middle;margin-inline-end:4px}
#${ID} .bcsi-delay{color:var(--bcsi-delay);stroke:var(--bcsi-delay)}#${ID} .bcsi-buffer{color:var(--bcsi-buffer);stroke:var(--bcsi-buffer);stroke-dasharray:5 4}
#${ID} .bcsi-legend .bcsi-buffer:before{border-block-start-style:dashed}
#${ID} svg{display:block;inline-size:100%;block-size:auto;overflow:visible;pointer-events:none;margin-block-start:8px}
#${ID} svg path{fill:none;stroke-width:2;vector-effect:non-scaling-stroke}#${ID} svg text{fill:currentColor;font-size:10px;font-variant-numeric:tabular-nums}
#${ID} .bcsi-axis,#${ID} .bcsi-mode-marker{stroke:currentColor;opacity:.35;stroke-width:1}#${ID} .bcsi-mode-marker{opacity:.75;stroke-dasharray:2 3}
#${ID} figcaption{font-size:12px;overflow-wrap:anywhere}#${ID} .bcsi-observation{margin:16px 0 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
html.theme_dark #${ID}{--bcsi-delay:#3ce5b1;--bcsi-buffer:#9baeff}
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
