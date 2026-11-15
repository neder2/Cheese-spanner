/** Main-player recording (isolated world).
 * A record button sits at the start of the player's bottom-right buttons. Pressing it records the main
 * <video> through captureStream() + MediaRecorder (MP4 when Chrome can encode it, otherwise WebM) until the
 * button is pressed again. Each chunk is streamed through our worker to a chosen directory or Chrome download.
 * - There is no duration limit. Only pending chunks stay in memory; stalled delivery stops further capture.
 * - It stops and saves when the page route changes, the main video element or its source is replaced, the
 *   recorder fails, the option is turned off, or the page is hidden for good. Leaving the page while
 *   recording asks the browser's leave-page confirmation first.
 * - The gear menu gets a "녹화 저장 폴더" row that edits the synced videoRecorderFolder option through the
 *   worker's settings store, like the ambient slider does for ambientIntensity. The worker
 *   (shared/recordingDownloads.js) puts the file into that folder under Chrome's download folder only while
 *   the optional downloads permission is held; otherwise the file lands in the download folder itself.
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
        settingsStoreSet,
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
    const EDIT_ID = `${ID}-folder-edit`;
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
        menuRow = null,
        menuButton = null,
        menuValue = null,
        editRow = null,
        editInput = null,
        editSave = null,
        editNote = null,
        expanded = false,
        permission = null,
        selectedDirectory = null,
        permissionRevision = 0,
        folderOverride = null,
        saveRevision = 0;
    let recording = null;
    // A player-selected handle stays in this isolated world; never store it in the site's IndexedDB or DOM.
    let tabDirectory = null;
    let choosingDirectory = false;
    let directoryRevision = 0;
    const finishing = new Set();
    let discovery = null,
        routeCleanup = null,
        routeKey = "";
    const schedule = createThrottledDomSync(sync, 160);

    const enabled = () => options.videoRecorderEnabled === true;
    const currentFolder = () => folderOverride ?? settings.normalizeDownloadFolder(options.videoRecorderFolder, "");
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
            .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_")
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

    async function startRecording() {
        if (recording || finishing.size || !active || !video?.isConnected || !player?.contains(video)) return;
        const format = pickMimeType();
        if (!format || typeof video.captureStream !== "function") {
            showStatus("이 브라우저에서는 영상을 녹화할 수 없어요.");
            return;
        }
        if (video.readyState < HAVE_CURRENT_DATA) {
            showStatus("영상이 재생되기 시작하면 다시 눌러 주세요.");
            return;
        }
        let stream = null;
        let recorder = null;
        try {
            stream = video.captureStream();
            if (!stream.getVideoTracks().length) throw new Error("no video track");
            recorder = new MediaRecorder(stream, {
                mimeType: format.mimeType,
                videoBitsPerSecond: videoBitsPerSecond(video.videoHeight),
                audioBitsPerSecond: 160_000,
            });
        } catch (_) {
            for (const track of stream?.getTracks?.() || []) track.stop();
            showStatus("이 영상은 녹화할 수 없어요.");
            return;
        }
        const session = {
            video,
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
            directoryHandle: tabDirectory,
            fileWriter: null,
            fileFailed: false,
            fileClosed: false,
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
                        const result = await recordingCommand(session, {
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
        for (const name of SOURCE_EVENTS) video.addEventListener(name, onSourceChange);
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
            if (session.directoryHandle) {
                const opening = globalThis.CheeseSpannerRecordingDirectory.openFile(
                    session.directoryHandle,
                    fileName
                ).then(async (file) => {
                    if (session.stopping || session.fileFailed) {
                        await file.writer.abort().catch(() => {});
                        throw new Error("directory-cancelled");
                    }
                    session.fileWriter = file.writer;
                    return file;
                });
                const file = await fileOperation(session, opening);
                session.route = {
                    ok: true,
                    destination: "directory",
                    folder: session.directoryHandle.name,
                    fileName: file.fileName,
                };
            } else {
                session.route = await sendRecorderMessage({ op: "start", fileName }, true);
            }
            if (!session.route?.ok) throw new Error(session.route?.error || "download-unavailable");
            if (!session.stopping && recording === session) {
                if (session.route.destination !== "directory") {
                    const link = document.createElement("a");
                    link.href = session.route.url;
                    // An attachment navigation streams through our worker; a download attribute bypasses it.
                    link.hidden = true;
                    (document.body || document.documentElement).append(link);
                    link.click();
                    link.remove();
                }
                const opened = await recordingCommand(session, { op: "ready", id: session.route.id });
                if (!opened) throw new Error("download-unavailable");
            }
            if (session.stopping || recording !== session || !active || !session.video.isConnected) {
                await recordingCommand(session, { op: "abort", id: session.route.id });
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
                void recordingCommand(session, { op: "pulse", id: session.route.id }).then((result) => {
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
            if (session.route || session.fileWriter)
                void recordingCommand(session, { op: "abort", id: session.route?.id });
            stopRecording(session);
            showStatus(
                error.message.startsWith("directory-")
                    ? "저장 폴더에 접근하지 못했어요. ‘녹화 저장 폴더’를 눌러 다시 지정해 주세요."
                    : "녹화를 시작하지 못했어요."
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
                : await recordingCommand(session, {
                      op: "finish",
                      id: session.route.id,
                      sequence: session.sequence,
                  });
            if (!result) {
                void recordingCommand(session, { op: "abort", id: session.route.id });
                showStatus("저장이 중단되어 녹화 파일을 완성하지 못했어요.");
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
                    ? `${session.failed ? "녹화가 중단되어 그때까지의 파일을" : "녹화 파일을"} ${where}에 저장했어요.`
                    : session.failed
                      ? `녹화가 중단되어 그때까지의 파일 다운로드를 ${where}에서 마무리해요.`
                      : `녹화 파일 다운로드를 ${where}에서 마무리해요.`
            );
        } finally {
            finishing.delete(session);
            if (!recording && !finishing.size) window.removeEventListener("beforeunload", onBeforeUnload);
            renderRecording();
        }
    }

    async function fileOperation(session, operation) {
        let timer;
        try {
            return await Promise.race([
                operation,
                new Promise((_, reject) => {
                    timer = window.setTimeout(() => reject(new Error("directory-timeout")), 10_000);
                }),
            ]);
        } catch (error) {
            session.fileFailed = true;
            if (session.fileWriter && !session.fileClosed) void session.fileWriter.abort().catch(() => {});
            throw error;
        } finally {
            window.clearTimeout(timer);
        }
    }

    async function recordingCommand(session, message) {
        if (!session.directoryHandle) return sendRecorderMessage(message);
        if (message.op === "abort") {
            session.fileFailed = true;
            if (session.fileWriter && !session.fileClosed) void session.fileWriter.abort().catch(() => {});
            return { ok: true };
        }
        if (!session.fileWriter || session.fileFailed || session.fileClosed) return null;
        try {
            if (message.op === "write") {
                const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
                await fileOperation(session, session.fileWriter.write(bytes));
            } else if (message.op === "finish") {
                await fileOperation(session, session.fileWriter.close());
                session.fileClosed = true;
            }
            return { ok: true };
        } catch (_) {
            return null;
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
        if (!event.isTrusted || event.currentTarget !== button) return;
        if (recording) stopRecording();
        else void startRecording();
    }

    // ── Player UI ──

    function styles() {
        ensureUiTheme?.();
        injectStyleOnce(
            STYLE_ID,
            `
#${BUTTON_ID} { position:relative; display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; padding:6px; border:0; background:transparent; color:inherit; cursor:pointer; flex-shrink:0; }
#${BUTTON_ID}[aria-pressed="true"] { color:#ff4d4d; }
#${BUTTON_ID}:focus-visible { outline:2px solid var(--bct-focus-ring); outline-offset:2px; }
.pzp-pc:not(.pzp-pc--controls) #${BUTTON_ID}:not(:focus-visible) { opacity:0; pointer-events:none; }
#${BADGE_ID} { position:absolute; top:12px; left:12px; z-index:40; display:inline-flex; align-items:center; gap:6px; padding:3px 8px; border-radius:12px; background:rgba(0,0,0,.6); color:#fff; font-family:var(--bct-font); font-size:12px; font-weight:600; line-height:1.5; font-variant-numeric:tabular-nums; pointer-events:none; }
#${BADGE_ID}::before { content:""; width:8px; height:8px; border-radius:50%; background:#ff4d4d; }
#${BADGE_ID}[hidden], #${STATUS_ID}[hidden] { display:none; }
#${STATUS_ID} { position:absolute; right:16px; bottom:64px; z-index:51; max-width:calc(100% - 32px); box-sizing:border-box; padding:6px 10px; border-radius:var(--bct-radius-md); background:rgba(0,0,0,.75); color:#fff; font-family:var(--bct-font); font-size:12px; line-height:1.5; pointer-events:none; }
.chzzk_player:is(.miniplayer, .pip_mode) #${STATUS_ID} { display:none; }
#${EDIT_ID} { display:block; }
#${EDIT_ID}[hidden] { display:none; }
#${ROW_ID} { cursor:pointer; }
#${EDIT_ID} .${ID}-field { display:flex; gap:6px; align-items:center; }
#${EDIT_ID} input { flex:1 1 auto; min-width:0; box-sizing:border-box; height:28px; padding:0 8px; border:1px solid rgba(255,255,255,.25); border-radius:4px; background:rgba(255,255,255,.08); color:inherit; font:inherit; font-size:12px; }
#${EDIT_ID} input:focus-visible, #${EDIT_ID} button:focus-visible { outline:2px solid var(--bct-focus-ring); outline-offset:1px; }
#${EDIT_ID} button { flex:none; height:28px; padding:0 10px; border:0; border-radius:4px; background:rgba(255,255,255,.16); color:inherit; font:inherit; font-size:12px; cursor:pointer; }
#${EDIT_ID} button:disabled { opacity:.5; cursor:default; }
#${EDIT_ID} .${ID}-note { margin:6px 0 0; font-size:11px; line-height:1.5; opacity:.8; white-space:normal; word-break:keep-all; overflow-wrap:anywhere; }
`
        );
    }

    function showStatus(text) {
        if (statusTimer) window.clearTimeout(statusTimer);
        statusTimer = 0;
        const host = player?.isConnected ? player : null;
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
        if (button) {
            button.disabled = !on && finishing.size > 0;
            const label = on ? (recording.preparing ? "녹화 시작 취소" : `녹화 중지 (${elapsed})`) : "녹화 시작";
            if (button.getAttribute("aria-pressed") !== String(on)) {
                button.setAttribute("aria-pressed", String(on));
                button.innerHTML = on ? STOP_ICON : RECORD_ICON;
            }
            if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
            syncPlayerButtonTooltip(button, label);
        }
        const host = on && player?.contains(recording.video) ? player : null;
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

    // ── Gear menu: save folder ──

    function folderLabel(folder) {
        return folder || "다운로드 폴더";
    }

    function renderMenu() {
        if (!menuRow) return;
        const folder = currentFolder();
        menuValue.textContent = choosingDirectory
            ? "폴더 선택 중…"
            : tabDirectory?.name || selectedDirectory?.directory || folderLabel(folder);
        editInput.hidden = editSave.hidden = Boolean(selectedDirectory?.directory);
        editRow.hidden = !expanded;
        if (!expanded) return;
        let note;
        if (selectedDirectory?.directory)
            note = selectedDirectory.directoryGranted
                ? `‘${selectedDirectory.directory}’ 폴더에 저장해요. ‘폴더 선택’에서 바꿀 수 있어요.`
                : "폴더 접근 권한이 필요해요. ‘폴더 선택’에서 다시 지정해 주세요.";
        else if (!folder) note = "비워 두면 Chrome 다운로드 폴더에 바로 저장해요.";
        else if (permission === false)
            note = `하위 폴더에 저장하려면 확장 옵션에서 다운로드 권한을 허용해 주세요. 지금은 다운로드 폴더에 저장해요.`;
        else note = `다운로드 폴더 안의 ${folder} 폴더에 저장해요.`;
        if (editNote.textContent !== note) editNote.textContent = note;
    }

    function refreshPermission() {
        const revision = ++permissionRevision;
        void sendRecorderMessage({ op: "status" }).then((response) => {
            if (revision !== permissionRevision) return;
            permission = response ? response.downloads === true : null;
            selectedDirectory = response;
            renderMenu();
        });
    }

    function validMenuRow() {
        return active && menuRow?.isConnected && player?.isConnected && menuRow.parentElement === menu;
    }

    function refreshFolderOnFocus() {
        if (validMenuRow()) refreshPermission();
    }

    function onMenuRowClick(event) {
        event.stopPropagation();
        if (!event.isTrusted || !validMenuRow()) return;
        void choosePlayerDirectory();
    }

    function onMenuButtonKeyDown(event) {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        if (event.isTrusted && !event.repeat && validMenuRow()) void choosePlayerDirectory();
    }

    async function choosePlayerDirectory() {
        if (choosingDirectory || !validMenuRow()) return;
        if (typeof window.showDirectoryPicker !== "function") {
            showStatus("이 브라우저는 탐색기 폴더 선택을 지원하지 않아요. 확장 설정에서 저장 위치를 지정해 주세요.");
            return;
        }
        const revision = ++directoryRevision;
        choosingDirectory = true;
        renderMenu();
        try {
            // Keep the picker in this actual click, before any asynchronous work consumes user activation.
            const handle = await window.showDirectoryPicker({
                id: "cheese-spanner-recording",
                mode: "readwrite",
                startIn: tabDirectory || "downloads",
            });
            if (revision !== directoryRevision || !active || hidden || disposed) return;
            if ((await handle.queryPermission({ mode: "readwrite" })) !== "granted")
                throw new Error("directory-permission");
            if (revision !== directoryRevision || !active || hidden || disposed) return;
            tabDirectory = handle;
            renderMenu();
            showStatus(`이 탭의 다음 녹화부터 ‘${handle.name}’ 폴더에 저장해요.`);
        } catch (error) {
            if (revision === directoryRevision && error.name !== "AbortError")
                showStatus("폴더를 선택하지 못했어요. 폴더 접근을 허용한 뒤 다시 눌러 주세요.");
        } finally {
            if (revision === directoryRevision) {
                choosingDirectory = false;
                renderMenu();
            }
        }
    }

    function saveFolder(event) {
        // The synced option is only written from a real press or key in this row.
        if (!event.isTrusted || !validMenuRow() || editRow.hidden) return;
        const next = settings.normalizeDownloadFolder(editInput.value, "");
        editInput.value = next;
        if (next === currentFolder()) {
            renderMenu();
            return;
        }
        const revision = ++saveRevision;
        folderOverride = next;
        editSave.disabled = true;
        renderMenu();
        settingsStoreSet("sync", { videoRecorderFolder: next }).then(
            () => {
                if (revision !== saveRevision) return;
                options = { ...options, videoRecorderFolder: next };
                folderOverride = null;
                editSave.disabled = false;
                refreshPermission();
            },
            () => {
                if (revision !== saveRevision) return;
                folderOverride = null;
                editSave.disabled = false;
                editInput.value = currentFolder();
                renderMenu();
                editNote.textContent = "저장 폴더를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.";
            }
        );
    }

    function onSaveClick(event) {
        event.stopPropagation();
        saveFolder(event);
    }

    function onInputKeyDown(event) {
        // Typing belongs to the field; the native menu and player shortcuts must not react to it.
        if (event.key === "Escape") return;
        event.stopPropagation();
        if (event.key === "Enter" && !event.isComposing) {
            event.preventDefault();
            saveFolder(event);
        }
    }

    function stopInside(event) {
        event.stopPropagation();
    }

    function onMenuNavigation(event) {
        // Another feature's bridge may already have moved focus for this key.
        if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !menuRow?.isConnected) return;
        if (!(event.target instanceof Element) || event.target.closest(`#${EDIT_ID}`)) return;
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
        menuButton.setAttribute("aria-haspopup", "dialog");
        const label = document.createElement("span");
        label.className = "pzp-ui-setting-home-item__label";
        label.textContent = "녹화 저장 폴더";
        menuButton.append(label);
        parts.left.append(menuButton);
        menuValue = document.createElement("span");
        menuValue.className = "pzp-ui-setting-home-item__value";
        parts.right.append(menuValue);

        editRow = document.createElement("div");
        editRow.id = EDIT_ID;
        editRow.className = "pzp-ui-setting-home-item";
        editRow.setAttribute("role", "group");
        editRow.setAttribute("aria-label", "녹화 저장 폴더");
        const field = document.createElement("div");
        field.className = `${ID}-field`;
        editInput = document.createElement("input");
        editInput.type = "text";
        editInput.id = `${EDIT_ID}-input`;
        editInput.maxLength = settings.DOWNLOAD_FOLDER_MAX_LENGTH;
        editInput.placeholder = "예: 치지직 녹화";
        editInput.autocomplete = "off";
        editInput.spellcheck = false;
        editInput.setAttribute("aria-label", "다운로드 폴더 안의 녹화 저장 폴더 이름");
        editSave = document.createElement("button");
        editSave.type = "button";
        editSave.textContent = "저장";
        field.append(editInput, editSave);
        const chooseDirectory = document.createElement("button");
        chooseDirectory.type = "button";
        chooseDirectory.textContent = "폴더 선택…";
        chooseDirectory.title = "탐색기에서 이 탭의 저장 폴더 선택";
        chooseDirectory.addEventListener("click", (event) => {
            event.stopPropagation();
            if (!event.isTrusted || !validMenuRow() || editRow.hidden) return;
            void choosePlayerDirectory();
        });
        field.append(chooseDirectory);
        editNote = document.createElement("p");
        editNote.className = `${ID}-note`;
        editNote.id = `${EDIT_ID}-note`;
        editInput.setAttribute("aria-describedby", editNote.id);
        editRow.append(field, editNote);

        menuRow.addEventListener("click", onMenuRowClick);
        menuButton.addEventListener("keydown", onMenuButtonKeyDown);
        editSave.addEventListener("click", onSaveClick);
        editInput.addEventListener("keydown", onInputKeyDown);
        for (const type of ["keyup", "keypress"]) editInput.addEventListener(type, stopInside);
        for (const type of ["click", "pointerdown", "mousedown", "dblclick", "wheel"]) {
            menuRow.addEventListener(type, stopInside);
            editRow.addEventListener(type, stopInside);
        }
        menu.addEventListener("keydown", onMenuNavigation, true);
        container.append(menuRow, editRow);
        renderMenu();
        refreshPermission();
    }

    function removeMenu() {
        directoryRevision++;
        choosingDirectory = false;
        menu?.removeEventListener("keydown", onMenuNavigation, true);
        menuRow?.remove();
        editRow?.remove();
        menu = menuRow = menuButton = menuValue = editRow = editInput = editSave = editNote = null;
        expanded = false;
        permissionRevision++;
        // The storage write can finish, but its response no longer owns this menu.
        saveRevision++;
        folderOverride = null;
    }

    function syncMenu() {
        const container = player?.querySelector(SETTINGS_MENU) || null;
        if (menuRow && menu === container && menuRow.parentElement === container) {
            if (menuRow.nextElementSibling !== editRow) menuRow.after(editRow);
            return;
        }
        removeMenu();
        if (container) buildMenu(container);
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
        if (recording && (!recording.video.isConnected || recording.video !== nextVideo)) stopRecording();
        if (nextPlayer !== player) {
            removeButton();
            removeMenu();
            status?.remove();
            status = null;
        }
        player = nextPlayer;
        video = nextVideo;
        mountButton();
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
        const owned = [button, badge, status, menuRow, editRow];
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
        sync();
    }

    function stopUI() {
        if (!active) return;
        if (recording) stopRecording();
        active = false;
        directoryRevision++;
        choosingDirectory = false;
        window.removeEventListener("focus", refreshFolderOnFocus);
        schedule.cancel();
        discovery?.disconnectAll();
        discovery = null;
        routeCleanup?.();
        routeCleanup = null;
        removeButton();
        removeMenu();
        hideStatus();
        badge?.remove();
        status?.remove();
        badge = status = null;
        player = video = null;
        folderOverride = null;
        saveRevision++;
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
