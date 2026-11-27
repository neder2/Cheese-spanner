/** Save the main player's decoded frame from a trusted press in the isolated world. */
(() => {
    "use strict";
    const root = window.CheeseSpanner;
    if (root.videoScreenshot) return;
    const u = root.utils;
    const ID = "cheese-spanner-video-screenshot";
    const CONTROLS = ".pzp-pc__bottom-buttons-right";
    const LABEL = "화면 캡처";
    const ICON =
        '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" focusable="false"><path d="M3 7.5h4l1.7-3h6.6l1.7 3h4v12H3z"/><circle cx="12" cy="13" r="3.6"/></svg>';
    let options = {};
    let ready = false;
    let hidden = false;
    let observer = null;
    let stopRoutes = null;
    let binding = null;
    let activeCapture = null;
    let status = null;
    let statusTimer = 0;
    const MEDIA = "video.webplayer-internal-video";
    const MEDIA_EVENTS = ["loadstart", "emptied", "loadeddata"];
    const MAX_SOURCE_URLS = 32;
    const urlRoutes = new Map();
    const streamRoutes = new WeakMap();
    let loads = new WeakMap();
    const schedule = u.createThrottledDomSync(sync, 120);

    function clearStatus() {
        clearTimeout(statusTimer);
        status?.remove();
        status = null;
    }

    function report(text) {
        clearStatus();
        if (!binding) return;
        status = document.createElement("div");
        status.id = ID + "-status";
        status.setAttribute("role", "status");
        status.textContent = text;
        binding.player.append(status);
        statusTimer = setTimeout(clearStatus, 4500);
    }

    function cancel() {
        activeCapture?.abort();
        activeCapture = null;
    }

    function routeKey(path) {
        if (/^\/live\/[^/]+(?:\/simple)?\/?$/.test(path)) {
            const id = u.getLiveChannelIdFromPath(path);
            return id && "live/" + id;
        }
        const id = /^\/video\/[1-9]\d*\/?$/.test(path) && u.getVodVideoNoFromPath(path);
        return id && "video/" + id;
    }

    function nativeVideo(key) {
        if (!key) return null;
        const selector = key.startsWith("live/") ? ".chzzk_player.type_live" : "#player_layout.chzzk_player.type_vod";
        const hosts = document.querySelectorAll(selector);
        if (hosts.length !== 1 || hosts[0].matches(".pip_mode, .miniplayer")) return null;
        const players = hosts[0].querySelectorAll(":scope > .pzp-pc");
        if (players.length !== 1) return null;
        const videos = Array.from(players[0].querySelectorAll(MEDIA)).filter(
            (v) =>
                v.closest(".pzp-pc") === players[0] &&
                !v.closest(u.NATIVE_AD_MEDIA_SELECTOR) &&
                !u.isExtensionPreviewVideo(v)
        );
        return videos.length === 1 ? videos[0] : null;
    }

    function controlsFor(player) {
        const bars = Array.from(player.querySelectorAll(CONTROLS)).filter((bar) => bar.closest(".pzp-pc") === player);
        return bars.length === 1 ? bars[0] : null;
    }

    function claimSourceForRoute(video, key) {
        const stream = video.srcObject;
        const routes = stream ? streamRoutes : urlRoutes;
        const source = stream || video.currentSrc;
        if (routes.has(source)) return routes.get(source) === key;
        // Never evict an earlier owner: its URL can reappear on a different broadcast's replacement video.
        if (!stream && urlRoutes.size >= MAX_SOURCE_URLS) return false;
        routes.set(source, key);
        return true;
    }

    function markUnobservedSource(video) {
        if (
            !video ||
            loads.has(video) ||
            video.readyState < 2 ||
            !video.videoWidth ||
            !video.videoHeight ||
            (!video.currentSrc && !video.srcObject)
        )
            return;
        // Replaying a source first seen after activation does not establish which broadcast supplied it.
        claimSourceForRoute(video, null);
    }

    // A connected, drawable video can still be the previous broadcast. Observe a native
    // load and its first decoded frame under the same route and player rather than adopting it on click.
    function onMedia(event) {
        const video = event.target;
        if (!event.isTrusted || !(video instanceof HTMLVideoElement) || !video.matches(MEDIA)) return;
        const load = loads.get(video);
        if (event.type === "loadeddata" && (!load || load.ready)) return;
        loads.delete(video);
        if (event.type !== "loadeddata" && binding?.video === video) cancel();
        if (event.type === "emptied") return;
        const key = routeKey(location.pathname);
        if (nativeVideo(key) !== video) return;
        const player = video.closest(".pzp-pc");
        const src = video.currentSrc;
        const stream = video.srcObject;
        if (event.type === "loadstart") {
            loads.set(video, { key, player, host: player.parentElement, src, stream, ready: false });
            return;
        }
        if (
            load.key !== key ||
            load.player !== player ||
            load.host !== player.parentElement ||
            (load.src && load.src !== src) ||
            (load.stream && load.stream !== stream)
        )
            return;
        if ((!src && !stream) || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
        if (!claimSourceForRoute(video, key)) return;
        loads.set(video, { ...load, src, stream, ready: true });
    }

    function hasOwnedFrame(target) {
        const load = loads.get(target.video);
        return (
            load?.ready &&
            load.key === target.key &&
            load.player === target.player &&
            load.host === target.player.parentElement &&
            load.src === target.video.currentSrc &&
            load.stream === target.video.srcObject
        );
    }

    function unmount() {
        cancel();
        clearStatus();
        if (!binding) return;
        binding.button.removeEventListener("click", onClick);
        binding.button.remove();
        binding = null;
    }

    function sync() {
        const path = location.pathname;
        const key = routeKey(path);
        const video = nativeVideo(key);
        markUnobservedSource(video);
        const player = video?.closest(".pzp-pc");
        const controls = player && controlsFor(player);
        if (controls && binding?.video === video && binding.path === path && binding.button.parentElement === controls)
            return;
        unmount();
        if (!controls) return;
        const button = document.createElement("button");
        button.id = ID;
        button.type = "button";
        button.className = "pzp-button";
        button.setAttribute("aria-label", LABEL);
        button.innerHTML = ICON;
        u.syncPlayerButtonTooltip(button, LABEL);
        binding = { path, key, id: key.slice(key.indexOf("/") + 1), video, player, button };
        button.addEventListener("click", onClick);
        const recorder = controls.querySelector(":scope > #cheese-spanner-video-recorder-toggle");
        if (recorder) recorder.after(button);
        else controls.prepend(button);
    }

    function isCurrent(target) {
        return (
            binding === target &&
            target.path === location.pathname &&
            target.video === nativeVideo(target.key) &&
            target.player === target.video.closest(".pzp-pc") &&
            target.button.parentElement === controlsFor(target.player) &&
            target.button.isConnected
        );
    }

    function framePng(video) {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("canvas-unavailable");
        ctx.drawImage(video, 0, 0);
        // Some protected sources produce an empty or black frame without throwing. Read in strips
        // so checking a blank high-resolution frame does not allocate a second full-frame buffer.
        let hasColor = false;
        for (let y = 0; !hasColor && y < canvas.height; y += 128) {
            const { data } = ctx.getImageData(0, y, canvas.width, Math.min(128, canvas.height - y));
            for (let i = 0; i < data.length; i += 4) {
                if (data[i + 3] && (data[i] || data[i + 1] || data[i + 2])) {
                    hasColor = true;
                    break;
                }
            }
        }
        if (!hasColor) throw new Error("blank-frame");
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob?.size && blob.type === "image/png") resolve(blob);
                else reject(new Error("encode-failed"));
            }, "image/png");
        });
    }

    async function copyFrame(frame) {
        try {
            // Submit the write in the original click's activation, while native PNG encoding finishes.
            await navigator.clipboard.write([new ClipboardItem({ "image/png": frame })]);
            return true;
        } catch (_) {
            return false;
        }
    }

    function download(blob, name) {
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        try {
            link.href = url;
            link.download = name;
            link.click();
        } finally {
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
    }

    async function onClick(event) {
        if (!event.isTrusted || event.currentTarget !== binding?.button) return;
        event.stopPropagation();
        const target = binding;
        if (!isCurrent(target)) {
            sync();
            return;
        }
        const { video, path, id } = target;
        if (activeCapture) return;
        if (
            u.isLiveAdBreakActive() ||
            target.player.matches(".pzp-pc--adbreak") ||
            target.player.querySelector(".pzp-pc--adbreak")
        )
            return report("광고 재생 중에는 캡처할 수 없습니다.");
        if (video.mediaKeys) return report("보호된 영상은 캡처할 수 없습니다.");
        if (video.readyState < 2 || !video.videoWidth || !video.videoHeight)
            return report("영상이 준비되면 다시 눌러 주세요.");
        if (!hasOwnedFrame(target)) {
            if (
                !video.srcObject &&
                video.currentSrc &&
                urlRoutes.size >= MAX_SOURCE_URLS &&
                !urlRoutes.has(video.currentSrc)
            )
                return report(
                    "이 탭에서 확인할 수 있는 영상 주소 한도에 도달했습니다. 방송 페이지를 새로고침해 주세요."
                );
            return report(
                "이 방송의 영상이 새로 로드되면 캡처할 수 있습니다. 이미 재생 중이면 페이지를 새로고침해 주세요."
            );
        }
        const controller = new AbortController();
        activeCapture = controller;
        const current = () => !controller.signal.aborted && isCurrent(target) && hasOwnedFrame(target);
        const action = options.videoScreenshotAction;
        const time = Date.now();
        try {
            const frame = framePng(video).then((blob) => {
                if (!current()) throw new Error("source-changed");
                return blob;
            });
            const copying = action === "file" ? null : copyFrame(frame);
            const blob = await frame;
            if (!current()) return;
            let fileStatus = "";
            if (action !== "clipboard") {
                const label = await u.getMediaFileNameLabel({
                    live: u.isLiveRoute(path),
                    id,
                    signal: controller.signal,
                    credentials: "omit",
                });
                if (!current()) return;
                const clock = u.formatKstTime(time, { seconds: true }).replaceAll(":", "-");
                try {
                    download(blob, `${u.getKstDateKey(time)} ${label} (${clock}).png`);
                    fileStatus = "PNG 다운로드 요청";
                } catch (_) {
                    fileStatus = "PNG 다운로드 실패";
                }
            }
            const copyStatus = copying
                ? (await copying)
                    ? "클립보드에 복사했습니다."
                    : "클립보드 복사가 차단됐습니다."
                : "";
            if (current()) report([fileStatus, copyStatus].filter(Boolean).join(" · "));
        } catch (error) {
            if (!current()) return;
            if (error.name === "SecurityError") report("영상의 보안 정책으로 캡처할 수 없습니다.");
            else if (error.message === "blank-frame")
                report("검은색 또는 투명한 프레임입니다. 다른 장면에서 다시 눌러 주세요.");
            else report("현재 프레임을 PNG로 만들 수 없습니다.");
        } finally {
            if (activeCapture === controller) activeCapture = null;
        }
    }

    function update() {
        const enabled = !hidden && options.videoScreenshotEnabled;
        if (enabled && !observer) markUnobservedSource(nativeVideo(routeKey(location.pathname)));
        for (const type of MEDIA_EVENTS) {
            if (enabled) document.addEventListener(type, onMedia, true);
            else document.removeEventListener(type, onMedia, true);
        }
        if (!enabled) loads = new WeakMap();
        if (ready && enabled) {
            if (observer) return;
            u.ensureUiTheme?.();
            u.injectStyleOnce(
                ID + "-style",
                `
#${ID} { position:relative; display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; padding:6px; border:0; background:transparent; color:inherit; cursor:pointer; flex-shrink:0; }
#${ID}:focus-visible { outline:2px solid var(--bct-focus-ring); outline-offset:2px; }
.pzp-pc:not(.pzp-pc--controls) #${ID}:not(:focus-visible) { opacity:0; pointer-events:none; }
#${ID}-status { position:absolute; right:16px; bottom:64px; z-index:51; max-width:calc(100% - 32px); padding:6px 10px; border-radius:var(--bct-radius-md); background:rgba(0,0,0,.8); color:#fff; font:12px/1.5 var(--bct-font); pointer-events:none; }
`
            );
            observer = u.createMutationObserverSync({
                target: () => document.body,
                options: { subtree: true, childList: true },
                shouldSchedule: (rows) => rows.some((r) => u.mutationMatchesSelector(r, `video, ${CONTROLS}`)),
                schedule,
            });
            stopRoutes = u.startPageChangeDetection(sync);
            sync();
        } else if (observer) {
            observer.disconnectAll();
            observer = null;
            stopRoutes();
            stopRoutes = null;
            schedule.cancel();
            unmount();
            document.getElementById(ID + "-style")?.remove();
        }
    }

    root.videoScreenshot = {};
    window.addEventListener("pagehide", () => {
        hidden = true;
        update();
    });
    window.addEventListener("pageshow", () => {
        hidden = false;
        update();
    });
    u.bindFeatureOptions((next) => {
        options = next;
        update();
    });
    u.onReady(() => {
        ready = true;
        update();
    });
})();
