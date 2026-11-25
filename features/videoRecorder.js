/** Main-player recording (isolated world).
 * A record button sits at the start of the player's bottom-right buttons. Pressing it records the main
 * <video> through captureStream() + MediaRecorder (MP4 when Chrome can encode it, otherwise WebM) until the
 * button is pressed again. Each chunk is streamed through our worker to a chosen directory or Chrome download.
 * - There is no duration limit. Only pending chunks stay in memory; stalled delivery stops further capture.
 * - It stops and saves when the page route changes, the main video element or its source is replaced, the
 *   recorder fails, the option is turned off, or the page is hidden for good. Leaving the page while
 *   recording asks the browser's leave-page confirmation first.
 * - A trusted press on the gear menu's folder row opens the extension's recording folder settings.
 *   The worker writes to that extension-owned directory or delivers the recording to Chrome Downloads.
 * - Encoded chunks pass to the extension worker and the user's own download, never to a remote server.
 */
(() => {
    "use strict";
    const root = window.CheeseSpanner;
    if (root.videoRecorder) return;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        createThrottledDomSync,
        ensureUiTheme,
        fetchJson,
        getKstDateKey,
        getLiveChannelIdFromPath,
        getMainVideoElement,
        getPlayerRoot,
        getVodVideoNoFromPath,
        injectStyleOnce,
        isLiveRoute,
        isPlaybackRoute,
        onReady,
        startPageChangeDetection,
        syncPlayerButtonTooltip,
    } = root.utils;
    const settings = globalThis.CheeseSpannerSettings;

    const ID = "cheese-spanner-video-recorder";
    const BUTTON_ID = `${ID}-toggle`;
    const BADGE_ID = `${ID}-badge`;
    const STATUS_ID = `${ID}-status`;
    const STYLE_ID = `${ID}-style`;
    const ROW_ID = `${ID}-folder-row`;
    const MESSAGE_TYPE = "cheese-spanner:video-recorder";
    const CONTROLS = ".pzp-pc__bottom-buttons-right";
    // Same native home menu that ambient glow and stream info extend.
    const SETTINGS_MENU = ':scope > .pzp-pc__settings[role="menu"]';
    const MENU_ENTRY_ATTR = "data-cheese-spanner-menu-entry";
    const MENU_ITEM = '[role="menuitem"], [role="menuitemcheckbox"]';
    const PLAYER_TARGETS = `video, ${CONTROLS}, .pzp-pc__settings`;
    const MIME_TYPES = [
        ["video/mp4;codecs=avc1.640028,mp4a.40.2", "mp4"],
        ["video/mp4;codecs=avc1,mp4a.40.2", "mp4"],
        ["video/mp4", "mp4"],
        ["video/webm;codecs=vp9,opus", "webm"],
        ["video/webm;codecs=vp8,opus", "webm"],
        ["video/webm", "webm"],
    ];
    const HAVE_CURRENT_DATA = 2;
    const TIMESLICE_MS = 1000;
    const PREPARE_TIMEOUT_MS = 12_000;
    const CHUNK_BYTES = 64 * 1024;
    const MAX_QUEUED_BYTES = 16 * 1024 * 1024;
    const STATUS_MS = 5000;
    const SOURCE_EVENTS = ["emptied", "loadstart"];
    const RECORD_ICON =
        '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4" fill="currentColor"/></svg>';
    const STOP_ICON =
        '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/></svg>';

    let options = {};
    let ready = false,
        active = false,
        hidden = false,
        disposed = false;
    let player = null,
        video = null,
        button = null,
        badge = null,
        status = null,
        statusTimer = 0;
    let menu = null,
        menuPlayer = null,
        menuRow = null,
        menuButton = null,
        menuValue = null,
        selectedDirectory = null,
        permissionRevision = 0;
    let recording = null;
    const finishing = new Set();
    const auxiliaryButtons = new Map();
    const AUXILIARY = "cheese-spanner:vod-multiview:auxiliary";
    let discovery = null,
        routeCleanup = null,
        routeKey = "";
    const schedule = createThrottledDomSync(sync, 160);

    const enabled = () => options.videoRecorderEnabled === true;
    const currentFolder = () => settings.normalizeDownloadFolder(options.videoRecorderFolder, "");
    const pathKey = () => location.pathname.replace(/\/+$/, "");

    // ── Recording ──

    function pickMimeType() {
        const recorder = globalThis.MediaRecorder;
        if (typeof recorder?.isTypeSupported !== "function") return null;
        for (const [mimeType, extension] of MIME_TYPES) {
            if (recorder.isTypeSupported(mimeType)) return { mimeType, extension };
        }
        return null;
    }

    function videoBitsPerSecond(height) {
        if (height >= 1440) return 12_000_000;
        if (height >= 1080) return 8_000_000;
        if (height >= 720) return 5_000_000;
        return 2_500_000;
    }

    function pad(value) {
        return String(value).padStart(2, "0");
    }

    function formatElapsed(ms) {
        const total = Math.max(0, Math.floor(ms / 1000));
        const hours = Math.floor(total / 3600);
        const rest = `${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
        return hours ? `${hours}:${rest}` : rest;
    }

    function filePart(value, maxLength, maxBytes, fallback) {
        const clean = String(value || "")
            // eslint-disable-next-line no-control-regex -- strip characters disallowed in local file names.
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "_")
            .replace(/\s+/g, " ")
            .trim();
        let result = "";
        let bytes = 0;
        for (const char of clean) {
            const code = char.codePointAt(0);
            const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
            if (result.length + char.length > maxLength || bytes + size > maxBytes) break;
            result += char;
            bytes += size;
        }
        return result.replace(/[. ]+$/, "") || fallback;
    }

    async function recordingFileName(session) {
        if (session.auxiliary) {
            const { media, title, channelName } = session.auxiliary;
            const safeTitle = filePart(title, 90, 150, `다시보기 ${media.videoNo}`);
            const safeChannel = filePart(channelName, 40, 60, "스트리머 정보 없음");
            return `${getKstDateKey(session.startedAt)} ${safeTitle} - ${safeChannel}.${session.format.extension}`;
        }
        const live = isLiveRoute(session.path);
        const id = live ? getLiveChannelIdFromPath(session.path) : getVodVideoNoFromPath(session.path);
        let title = `${live ? "라이브" : "다시보기"} ${id}`;
        let channelName = "스트리머 정보 없음";
        try {
            const endpoint = live
                ? `service/v3/channels/${encodeURIComponent(id)}/live-detail`
                : `service/v2/videos/${encodeURIComponent(id)}`;
            const json = await fetchJson(`https://api.chzzk.naver.com/${endpoint}`, {
                signal: session.metadataAbort.signal,
                timeoutMs: 3500,
            });
            const detail = json?.content;
            const verified =
                json?.code === 200 &&
                (live
                    ? detail?.channel?.channelId === id && detail.status === "OPEN"
                    : String(detail?.videoNo) === String(id));
            if (verified) {
                title = filePart(live ? detail.liveTitle : detail.videoTitle, 90, 150, title);
                channelName = filePart(detail.channel?.channelName, 40, 60, channelName);
            }
        } catch (_) {
            // Unverified DOM titles can belong to the previous SPA route; retain the current ID instead.
        }
        return `${getKstDateKey(session.startedAt)} ${title} - ${channelName}.${session.format.extension}`;
    }

    async function startRecording(auxiliary) {
        const targetVideo = auxiliary?.video || video;
        const targetPlayer = auxiliary?.player || player;
        if (recording || finishing.size || !active || !targetVideo?.isConnected || !targetPlayer?.contains(targetVideo))
            return;
        const format = pickMimeType();
        if (!format || typeof targetVideo.captureStream !== "function") {
            showStatus("이 브라우저에서 녹화 불가", targetPlayer);
            return;
        }
        if (targetVideo.readyState < HAVE_CURRENT_DATA) {
            showStatus("영상 재생 후 녹화 버튼 다시 누르기", targetPlayer);
            return;
        }
        let stream = null;
        let recorder = null;
        try {
            stream = targetVideo.captureStream();
            if (!stream.getVideoTracks().length) throw new Error("no video track");
            recorder = new MediaRecorder(stream, {
                mimeType: format.mimeType,
                videoBitsPerSecond: videoBitsPerSecond(targetVideo.videoHeight),
                audioBitsPerSecond: 160_000,
            });
        } catch (_) {
            for (const track of stream?.getTracks?.() || []) track.stop();
            showStatus("녹화할 수 없는 영상", targetPlayer);
            return;
        }
        const session = {
            video: targetVideo,
            player: targetPlayer,
            auxiliary: auxiliary
                ? { media: auxiliary.media, title: auxiliary.title, channelName: auxiliary.channelName }
                : null,
            stream,
            recorder,
            format,
            pending: Promise.resolve(),
            queuedBytes: 0,
            largeChunk: null,
            sequence: 0,
            preparing: true,
            route: null,
            writeFailed: false,
            startedAt: Date.now(),
            path: location.pathname,
            failed: false,
            stopping: false,
            timer: 0,
            metadataAbort: new AbortController(),
        };
        recorder.addEventListener("dataavailable", (event) => {
            if (!event.data?.size || session.writeFailed) return;
            // Chrome may flush one large Blob after paused/hidden capture. Keep it as a Blob and
            // read only 64KiB at a time; the rest of the queue still has the ordinary backlog bound.
            const largeChunk = event.data.size > MAX_QUEUED_BYTES && !session.largeChunk;
            if (largeChunk) session.largeChunk = event.data;
            else session.queuedBytes += event.data.size;
            session.pending = session.pending
                .then(async () => {
                    if (session.writeFailed) return;
                    for (let offset = 0; offset < event.data.size; offset += CHUNK_BYTES) {
                        const bytes = new Uint8Array(
                            await event.data.slice(offset, offset + CHUNK_BYTES).arrayBuffer()
                        );
                        const result = await sendRecorderMessage({
                            op: "write",
                            id: session.route.id,
                            sequence: session.sequence,
                            data: btoa(String.fromCharCode(...bytes)),
                        });
                        if (!result) throw new Error("download-interrupted");
                        session.sequence += 1;
                    }
                })
                .catch(() => {
                    session.writeFailed = true;
                    stopRecording(session);
                })
                .finally(() => {
                    if (largeChunk) session.largeChunk = null;
                    else session.queuedBytes -= event.data.size;
                });
            // Stop collecting if disk delivery stalls; drain what we already have instead of growing forever.
            if (session.queuedBytes > MAX_QUEUED_BYTES) {
                session.failed = true;
                stopRecording(session);
            }
        });
        recorder.addEventListener("error", () => {
            session.failed = true;
        });
        recorder.addEventListener("stop", () => finishRecording(session), { once: true });
        for (const track of stream.getTracks()) track.addEventListener("ended", () => stopRecording(session));
        for (const name of SOURCE_EVENTS) targetVideo.addEventListener(name, onSourceChange);
        recording = session;
        renderRecording();
        try {
            const fileName = await recordingFileName(session);
            if (
                session.stopping ||
                recording !== session ||
                !active ||
                session.path !== location.pathname ||
                !session.video.isConnected
            ) {
                stopRecording(session);
                return;
            }
            session.route = await sendRecorderMessage({ op: "start", fileName }, true);
            if (!session.route?.ok) throw new Error(session.route?.error || "download-unavailable");
            if (!session.stopping && recording === session) {
                if (session.route.destination !== "directory") {
                    const link = document.createElement("a");
                    link.href = session.route.url;
                    // An attachment navigation streams through our worker; a download attribute bypasses it.
                    link.click();
                }
                const opened = await sendRecorderMessage({ op: "ready", id: session.route.id });
                if (!opened) throw new Error("download-unavailable");
            }
            if (session.stopping || recording !== session || !active || !session.video.isConnected) {
                await sendRecorderMessage({ op: "abort", id: session.route.id });
                return;
            }
            recorder.start(TIMESLICE_MS);
            session.preparing = false;
            session.startedAt = Date.now();
            window.addEventListener("beforeunload", onBeforeUnload);
            session.lastPulse = Date.now();
            session.timer = window.setInterval(() => {
                renderRecording();
                if (Date.now() - session.lastPulse < 10_000) return;
                session.lastPulse = Date.now();
                void sendRecorderMessage({ op: "pulse", id: session.route.id }).then((result) => {
                    if (!result && recording === session) {
                        session.writeFailed = true;
                        stopRecording(session);
                    }
                });
            }, 1000);
            hideStatus();
            renderRecording();
        } catch (error) {
            session.writeFailed = true;
            if (session.route) void sendRecorderMessage({ op: "abort", id: session.route?.id });
            stopRecording(session);
            showStatus(
                error.message.startsWith("directory-")
                    ? "저장 폴더 접근 실패. ‘녹화 저장 폴더’에서 다시 지정"
                    : "녹화 시작 실패"
            );
        } finally {
            if (session.preparing) {
                for (const name of SOURCE_EVENTS) session.video.removeEventListener(name, onSourceChange);
                for (const track of stream.getTracks()) track.stop();
            }
        }
    }

    function stopRecording(session = recording) {
        if (!session || session.stopping) return;
        session.stopping = true;
        session.metadataAbort.abort();
        window.clearInterval(session.timer);
        for (const name of SOURCE_EVENTS) session.video.removeEventListener(name, onSourceChange);
        if (recording === session) {
            recording = null;
            if (session.preparing && !finishing.size) window.removeEventListener("beforeunload", onBeforeUnload);
        }
        if (session.preparing) {
            for (const track of session.stream.getTracks()) track.stop();
            renderRecording();
            return;
        }
        finishing.add(session);
        try {
            if (session.recorder.state !== "inactive") session.recorder.stop();
            else finishRecording(session);
        } catch (_) {
            finishRecording(session);
        }
        renderRecording();
    }

    async function finishRecording(session) {
        if (session.finished) return;
        session.finished = true;
        session.stopping = true;
        finishing.add(session);
        if (recording === session) recording = null;
        window.clearInterval(session.timer);
        for (const name of SOURCE_EVENTS) session.video.removeEventListener(name, onSourceChange);
        for (const track of session.stream.getTracks()) track.stop();
        renderRecording();
        try {
            await session.pending;
            const result = session.writeFailed
                ? null
                : await sendRecorderMessage({
                      op: "finish",
                      id: session.route.id,
                      sequence: session.sequence,
                  });
            if (!result) {
                void sendRecorderMessage({ op: "abort", id: session.route.id });
                showStatus("저장이 중단되어 녹화 파일 완성 실패");
                return;
            }
            const where =
                session.route.destination === "directory"
                    ? `‘${session.route.folder}’ 폴더`
                    : session.route.routed
                      ? `다운로드 폴더의 ${session.route.folder}`
                      : "다운로드 폴더";
            showStatus(
                session.route.destination === "directory"
                    ? `${session.failed ? "중단 시점까지의 녹화 파일" : "녹화 파일"} ${where}에 저장 완료`
                    : session.failed
                      ? `중단 시점까지의 녹화 파일 다운로드 마무리 중 (${where})`
                      : `녹화 파일 다운로드 마무리 중 (${where})`
            );
        } finally {
            finishing.delete(session);
            if (!recording && !finishing.size) window.removeEventListener("beforeunload", onBeforeUnload);
            renderRecording();
        }
    }

    function sendRecorderMessage(message, includeError = false) {
        return new Promise((resolve) => {
            const runtime = globalThis.chrome?.runtime;
            if (typeof runtime?.sendMessage !== "function") {
                resolve(null);
                return;
            }
            const timer = window.setTimeout(() => resolve(null), PREPARE_TIMEOUT_MS);
            try {
                runtime.sendMessage({ type: MESSAGE_TYPE, version: 1, ...message }, (response) => {
                    void runtime.lastError;
                    window.clearTimeout(timer);
                    resolve(response?.ok || includeError ? response : null);
                });
            } catch (_) {
                window.clearTimeout(timer);
                resolve(null);
            }
        });
    }

    function onSourceChange(event) {
        // A new source on the element ends what this recording was capturing.
        if (recording && event.currentTarget === recording.video) stopRecording();
    }

    function onBeforeUnload(event) {
        if (!recording && !finishing.size) return;
        event.preventDefault();
        event.returnValue = "";
    }

    function onButtonClick(event) {
        event.stopPropagation();
        // Only a real press may start capturing; a page script could otherwise start a recording.
        if (!event.isTrusted) return;
        const auxiliary =
            event.currentTarget === button
                ? null
                : (CheeseSpanner.vodMultiview?.getAuxiliaries() || []).find(
                      (target) => auxiliaryButtons.get(target.video) === event.currentTarget
                  );
        if (event.currentTarget !== button && !auxiliary) return;
        if (recording) {
            if (recording.video === (auxiliary?.video || video)) stopRecording();
        } else void startRecording(auxiliary);
    }

    // ── Player UI ──

    function styles() {
        ensureUiTheme?.();
        injectStyleOnce(
            STYLE_ID,
            `
:is(#${BUTTON_ID}, [data-bcvm-recorder]) { position:relative; display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; padding:6px; border:0; background:transparent; color:inherit; cursor:pointer; flex-shrink:0; }
:is(#${BUTTON_ID}, [data-bcvm-recorder])[aria-pressed="true"] { color:var(--bct-status-live); }
:is(#${BUTTON_ID}, [data-bcvm-recorder]):focus-visible { outline:2px solid var(--bct-focus-ring); outline-offset:2px; }
.pzp-pc:not(.pzp-pc--controls) :is(#${BUTTON_ID}, [data-bcvm-recorder]):not(:focus-visible) { opacity:0; pointer-events:none; }
#${BADGE_ID} { position:absolute; top:12px; left:12px; z-index:40; display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:var(--bct-radius-lg); background:rgba(0,0,0,.6); color:#fff; font-family:var(--bct-font); font-size:12px; font-weight:600; line-height:1.5; font-variant-numeric:tabular-nums; pointer-events:none; }
#${BADGE_ID}::before { content:""; width:8px; height:8px; border-radius:50%; background:var(--bct-status-live); }
#${BADGE_ID}[hidden], #${STATUS_ID}[hidden] { display:none; }
#${STATUS_ID} { position:absolute; right:16px; bottom:64px; z-index:51; max-width:calc(100% - 32px); box-sizing:border-box; padding:6px 10px; border-radius:var(--bct-radius-md); background:rgba(0,0,0,.75); color:#fff; font-family:var(--bct-font); font-size:12px; line-height:1.5; pointer-events:none; }
.chzzk_player:is(.miniplayer, .pip_mode) #${STATUS_ID} { display:none; }
#${ROW_ID} { cursor:pointer; }
`
        );
    }

    function showStatus(text, target = player) {
        if (statusTimer) window.clearTimeout(statusTimer);
        statusTimer = 0;
        const host = target?.isConnected ? target : null;
        if (!host) return;
        if (!status || status.parentElement !== host) {
            status?.remove();
            status = document.createElement("div");
            status.id = STATUS_ID;
            status.setAttribute("role", "status");
            host.append(status);
        }
        status.textContent = text;
        status.hidden = false;
        statusTimer = window.setTimeout(hideStatus, STATUS_MS);
    }

    function hideStatus() {
        if (statusTimer) window.clearTimeout(statusTimer);
        statusTimer = 0;
        if (status) status.hidden = true;
    }

    function renderRecording() {
        const on = Boolean(recording);
        const elapsed = on ? formatElapsed(Date.now() - recording.startedAt) : "";
        const buttons = [...auxiliaryButtons];
        if (button) buttons.unshift([video, button]);
        for (const [target, control] of buttons) {
            const ownRecording = on && recording.video === target;
            control.disabled = !ownRecording && (on || finishing.size > 0);
            const label = ownRecording
                ? recording.preparing
                    ? "녹화 시작 취소"
                    : `녹화 중지 (${elapsed})`
                : "녹화 시작";
            if (control.getAttribute("aria-pressed") !== String(ownRecording)) {
                control.setAttribute("aria-pressed", String(ownRecording));
                control.innerHTML = ownRecording ? STOP_ICON : RECORD_ICON;
            }
            if (control.getAttribute("aria-label") !== label) control.setAttribute("aria-label", label);
            syncPlayerButtonTooltip(control, label);
        }
        const host = on && recording.player?.contains(recording.video) ? recording.player : null;
        if (!host) {
            badge?.remove();
            badge = null;
            return;
        }
        if (!badge || badge.parentElement !== host) {
            badge?.remove();
            badge = document.createElement("div");
            badge.id = BADGE_ID;
            badge.setAttribute("aria-hidden", "true");
            host.append(badge);
        }
        const text = recording.preparing ? "녹화 준비 중" : `녹화 ${elapsed}`;
        if (badge.textContent !== text) badge.textContent = text;
    }

    function mountButton() {
        const container = player?.querySelector(CONTROLS) || null;
        if (button && button.parentElement === container) return;
        removeButton();
        if (!container) return;
        button = document.createElement("button");
        button.id = BUTTON_ID;
        button.type = "button";
        button.className = "pzp-button";
        button.addEventListener("click", onButtonClick);
        container.prepend(button);
        renderRecording();
    }

    function removeButton() {
        button?.removeEventListener("click", onButtonClick);
        button?.remove();
        button = null;
    }

    function syncAuxiliaryButtons(targets) {
        for (const [video, control] of auxiliaryButtons) {
            const target = targets.find((item) => item.video === video);
            const container = target?.player.querySelector(CONTROLS);
            if (container && control.parentElement === container) continue;
            control.removeEventListener("click", onButtonClick);
            control.remove();
            auxiliaryButtons.delete(video);
        }
        for (const { video, player } of targets) {
            if (auxiliaryButtons.has(video)) continue;
            const container = player.querySelector(CONTROLS);
            if (!container) continue;
            const control = document.createElement("button");
            control.type = "button";
            control.className = "pzp-button";
            control.dataset.bcvmRecorder = "";
            control.addEventListener("click", onButtonClick);
            auxiliaryButtons.set(video, control);
            container.prepend(control);
        }
    }

    // ── Gear menu: save folder ──

    function folderLabel(folder) {
        return folder || "다운로드 폴더";
    }

    function renderMenu() {
        if (!menuRow) return;
        const folder = currentFolder();
        menuValue.textContent = selectedDirectory?.directory || folderLabel(folder);
    }

    function refreshPermission() {
        const revision = ++permissionRevision;
        void sendRecorderMessage({ op: "status" }).then((response) => {
            if (revision !== permissionRevision) return;
            selectedDirectory = response;
            renderMenu();
        });
    }

    function validMenuRow() {
        const host = menuPlayer || player;
        return (
            active && menuRow?.isConnected && host?.isConnected && host.contains(menu) && menuRow.parentElement === menu
        );
    }

    function refreshFolderOnFocus() {
        if (validMenuRow()) refreshPermission();
    }

    function onMenuRowClick(event) {
        event.stopPropagation();
        if (!event.isTrusted || !validMenuRow()) return;
        void openFolderSettings();
    }

    function onMenuButtonKeyDown(event) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.isTrusted && !event.repeat && validMenuRow()) void openFolderSettings();
    }

    let openingFolderSettings = false;
    async function openFolderSettings() {
        if (openingFolderSettings) return;
        openingFolderSettings = true;
        const row = menuRow;
        try {
            const opened = await sendRecorderMessage({ op: "folder-settings" });
            if (!opened && menuRow === row && validMenuRow()) showStatus("녹화 저장 폴더 설정 열기 실패");
        } finally {
            openingFolderSettings = false;
        }
    }

    function stopInside(event) {
        event.stopPropagation();
    }

    function onMenuNavigation(event) {
        // Another feature's bridge may already have moved focus for this key.
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !menuRow?.isConnected) return;
        if (!(event.target instanceof Element)) return;
        const entry = event.target.closest(`[${MENU_ENTRY_ATTR}]`);
        const current = entry?.parentElement === menu ? entry : event.target;
        if (current.parentElement !== menu) return;
        const rows = Array.from(menu.children).filter(
            (row) =>
                (row.hasAttribute(MENU_ENTRY_ATTR) ||
                    ["menuitem", "menuitemcheckbox"].includes(row.getAttribute("role"))) &&
                row.getClientRects().length &&
                getComputedStyle(row).visibility !== "hidden"
        );
        const index = rows.indexOf(current);
        if (index < 0) return;
        const next =
            event.key === "Home"
                ? rows[0]
                : event.key === "End"
                  ? rows[rows.length - 1]
                  : rows[(index + (event.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length];
        // The native keyboard list excludes injected rows; bridge only moves into or out of an injected entry.
        if (!current.hasAttribute(MENU_ENTRY_ATTR) && !next.hasAttribute(MENU_ENTRY_ATTR)) return;
        event.preventDefault();
        event.stopPropagation();
        const target = next.matches(MENU_ITEM) ? next : next.querySelector(MENU_ITEM) || next;
        target.focus();
    }

    function createRowShell(element, id) {
        element.id = id;
        element.className = "pzp-ui-setting-home-item";
        const top = document.createElement("span");
        top.className = "pzp-ui-setting-home-item__top";
        const left = document.createElement("span");
        left.className = "pzp-ui-setting-home-item__left";
        const right = document.createElement("span");
        right.className = "pzp-ui-setting-home-item__right";
        top.append(left, right);
        element.append(top);
        return { left, right };
    }

    function buildMenu(container) {
        menu = container;
        menuRow = document.createElement("div");
        menuRow.setAttribute("role", "none");
        menuRow.setAttribute(MENU_ENTRY_ATTR, "");
        const parts = createRowShell(menuRow, ROW_ID);
        menuButton = document.createElement("button");
        menuButton.type = "button";
        menuButton.id = `${ROW_ID}-button`;
        menuButton.setAttribute("role", "menuitem");
        menuButton.title = "확장 설정에서 녹화 저장 폴더 선택";
        const label = document.createElement("span");
        label.className = "pzp-ui-setting-home-item__label";
        label.textContent = "녹화 저장 폴더";
        menuButton.append(label);
        parts.left.append(menuButton);
        menuValue = document.createElement("span");
        menuValue.className = "pzp-ui-setting-home-item__value";
        parts.right.append(menuValue);

        menuRow.addEventListener("click", onMenuRowClick);
        menuButton.addEventListener("keydown", onMenuButtonKeyDown);
        for (const type of ["click", "pointerdown", "mousedown", "dblclick", "wheel"]) {
            menuRow.addEventListener(type, stopInside);
        }
        menu.addEventListener("keydown", onMenuNavigation, true);
        container.append(menuRow);
        renderMenu();
        refreshPermission();
    }

    function removeMenu() {
        menu?.removeEventListener("keydown", onMenuNavigation, true);
        menuRow?.remove();
        menu = menuRow = menuButton = menuValue = null;
        permissionRevision++;
    }

    function syncMenu() {
        const container = (menuPlayer || player)?.querySelector(SETTINGS_MENU) || null;
        if (menuRow && menu === container && menuRow.parentElement === container) return;
        removeMenu();
        if (container) buildMenu(container);
    }

    function onSettingsClick(event) {
        if (!(event.target instanceof Element) || !event.target.closest(".pzp-setting-button")) return;
        const owner = event.target.closest(".pzp-pc");
        if (owner === player) menuPlayer = null;
        else {
            const auxiliary = CheeseSpanner.vodMultiview?.getAuxiliaries() || [];
            if (!auxiliary.some((item) => item.player === owner)) return;
            menuPlayer = owner;
        }
        schedule();
    }

    // ── Lifecycle ──

    function sync() {
        if (!active) return;
        let nextVideo = null,
            nextPlayer = null;
        if (isPlaybackRoute()) {
            const candidate = getMainVideoElement();
            const candidatePlayer = candidate ? getPlayerRoot(candidate) : null;
            if (candidatePlayer?.contains(candidate)) {
                nextVideo = candidate;
                nextPlayer = candidatePlayer;
            }
        }
        // The element being recorded was removed or replaced: keep what was captured.
        const auxiliary = CheeseSpanner.vodMultiview?.getAuxiliaries() || [];
        if (menuPlayer && !auxiliary.some((item) => item.player === menuPlayer)) menuPlayer = null;
        if (recording) {
            const expected = recording.auxiliary
                ? auxiliary.find((item) => item.media.videoNo === recording.auxiliary.media.videoNo)?.video
                : nextVideo;
            if (!recording.video.isConnected || recording.video !== expected) stopRecording();
        }
        if (nextPlayer !== player) {
            removeButton();
            removeMenu();
            status?.remove();
            status = null;
        }
        player = nextPlayer;
        video = nextVideo;
        mountButton();
        syncAuxiliaryButtons(auxiliary);
        syncMenu();
        renderRecording();
    }

    function onRouteChange() {
        const key = pathKey();
        if (key === routeKey) return;
        routeKey = key;
        if (recording) stopRecording();
        hideStatus();
        schedule();
    }

    function relevantMutations(rows) {
        const owned = [button, badge, status, menuRow];
        return rows.some((row) => {
            if (!(row.target instanceof Node)) return false;
            if (owned.some((node) => node && (node === row.target || node.contains(row.target)))) return false;
            return [...row.addedNodes, ...row.removedNodes].some(
                (node) =>
                    node instanceof Element &&
                    !owned.includes(node) &&
                    (node.matches(PLAYER_TARGETS) || !!node.querySelector(PLAYER_TARGETS))
            );
        });
    }

    function start() {
        if (!ready || !enabled() || active || hidden || disposed) return;
        active = true;
        styles();
        routeKey = pathKey();
        discovery = createMutationObserverSync({
            target: () => document.body,
            options: { childList: true, subtree: true },
            shouldSchedule: relevantMutations,
            schedule,
        });
        routeCleanup = startPageChangeDetection(onRouteChange);
        window.addEventListener("focus", refreshFolderOnFocus);
        document.addEventListener(AUXILIARY, sync);
        document.addEventListener("click", onSettingsClick, true);
        sync();
    }

    function stopUI() {
        if (!active) return;
        if (recording) stopRecording();
        active = false;
        window.removeEventListener("focus", refreshFolderOnFocus);
        document.removeEventListener(AUXILIARY, sync);
        document.removeEventListener("click", onSettingsClick, true);
        schedule.cancel();
        discovery?.disconnectAll();
        discovery = null;
        routeCleanup?.();
        routeCleanup = null;
        removeButton();
        syncAuxiliaryButtons([]);
        removeMenu();
        menuPlayer = null;
        hideStatus();
        badge?.remove();
        status?.remove();
        badge = status = null;
        player = video = null;
        document.getElementById(STYLE_ID)?.remove();
    }

    root.videoRecorder = {
        stop() {
            disposed = true;
            stopUI();
        },
        isRecording: () => Boolean(recording),
    };
    window.addEventListener("pagehide", () => {
        // Leaving or freezing the page ends the recording; what was captured is handed to the download first.
        hidden = true;
        stopUI();
    });
    window.addEventListener("pageshow", () => {
        if (!hidden) return;
        hidden = false;
        start();
    });
    bindFeatureOptions((next) => {
        if (disposed) return;
        options = next;
        if (!enabled()) stopUI();
        else if (active) renderMenu();
        else start();
    });
    onReady(() => {
        ready = true;
        start();
    });
})();
