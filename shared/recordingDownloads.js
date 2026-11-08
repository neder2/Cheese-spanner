/**
 * shared/recordingDownloads.js — 녹화 조각을 Chrome 다운로드로 흘려보내는 워커 경계 (globalThis.CheeseSpannerRecordingDownloads)
 *
 * 실행 컨텍스트: 서비스 워커(background.js의 importScripts). DOM을 쓰지 않아요.
 * 하는 일: 시작한 탭·문서에 묶인 일회용 attachment URL을 열고, 순서가 맞는 64KiB 이하 조각을
 *   ReadableStream에 전달해요. 다운로드가 느리면 다음 쓰기를 기다리며, 중지 때 마지막 조각 뒤에 닫아요.
 *   선택 권한이 있으면 onDeterminingFilename에서 그 다운로드에만 "<저장 폴더>/<파일 이름>"을 제안해요.
 *   - 저장 폴더는 메시지가 아니라 sync 옵션 videoRecorderFolder에서 읽고 normalizeDownloadFolder로 다시 검증해요.
 *   - downloads 권한이 없거나 폴더가 비어 있으면 기본 다운로드 폴더에 저장돼요. 영상은 저장소·외부로 보내지 않아요.
 *   - 세션은 최대 8개이며 취소·실패·마무리 때 정리해요. 재시작 뒤 미완성 다운로드를 이어받지 않아요.
 *   - 이전에 열린 콘텐츠의 prepare/blob 경로도 60초·8개 한도로 호환해요.
 * 발신자: 같은 확장 ID, 탭의 최상위 프레임, 정확한 https://chzzk.naver.com 출처만 받아요.
 * 공개 API: MESSAGE_TYPE, MESSAGE_VERSION, DOWNLOADS_PERMISSION, isRecordingBlobUrl, isRecordingFileName,
 *   createController({ chrome, now }) → { handleMessage(message, sender), handleFetch(event), install(), onDeterminingFilename }.
 */
(() => {
    "use strict";

    const MESSAGE_TYPE = "cheese-spanner:video-recorder";
    const MESSAGE_VERSION = 1;
    const CHZZK_ORIGIN = "https://chzzk.naver.com";
    const FOLDER_KEY = "videoRecorderFolder";
    const DOWNLOADS_PERMISSION = Object.freeze({ permissions: Object.freeze(["downloads"]) });
    const PENDING_TTL_MS = 60 * 1000;
    const MAX_PENDING = 8;
    const STREAM_PATH = "recording-download.txt";
    const STREAM_TIMEOUT_MS = 10_000;
    const MAX_CHUNK_BYTES = 64 * 1024;
    const BLOB_URL = /^blob:https:\/\/chzzk\.naver\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    // The page builds the name; the worker only accepts a plain file name with the two recorder containers.
    // eslint-disable-next-line no-control-regex -- control characters are exactly what a file name must not hold.
    const FILE_NAME = /^[^\\/:*?"<>|\u0000-\u001f\u007f]{1,150}\.(?:mp4|webm)$/;

    function isRecordingBlobUrl(value) {
        return typeof value === "string" && BLOB_URL.test(value);
    }

    function isRecordingFileName(value) {
        return (
            typeof value === "string" &&
            FILE_NAME.test(value) &&
            !value.startsWith(".") &&
            !value.startsWith(" ") &&
            value.trim() === value
        );
    }

    function isRecorderSender(sender, runtimeId) {
        if (!sender || sender.id !== runtimeId || !sender.tab || sender.frameId !== 0 || !sender.url) return false;
        if (sender.origin !== undefined && sender.origin !== CHZZK_ORIGIN) return false;
        try {
            const url = new URL(sender.url);
            return url.origin === CHZZK_ORIGIN && !url.username && !url.password;
        } catch (_) {
            return false;
        }
    }

    function createController({ chrome, now = () => Date.now(), directory = globalThis.CheeseSpannerRecordingDirectory }) {
        const pending = new Map();
        const sessions = new Map();
        let installed = false;

        function dispose(session, error) {
            if (!sessions.delete(session.id)) return;
            session.closed = true;
            if (session.writer && error) void session.writer.abort().catch(() => {});
            if (error) session.controller?.error(new Error(error));
            else session.controller?.close();
            session.wake?.();
        }

        async function fileOperation(session, operation) {
            let timer;
            try {
                return await Promise.race([
                    operation,
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error("directory-timeout")), STREAM_TIMEOUT_MS);
                    }),
                ]);
            } catch (error) {
                dispose(session, "directory-write-failed");
                throw error;
            } finally {
                clearTimeout(timer);
            }
        }

        function waitFor(session, predicate) {
            if (predicate()) return Promise.resolve();
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    session.wake = null;
                    dispose(session, "download-timeout");
                    reject(new Error("download-timeout"));
                }, STREAM_TIMEOUT_MS);
                session.wake = () => {
                    if (!session.closed && !predicate()) return;
                    clearTimeout(timer);
                    session.wake = null;
                    if (session.closed) reject(new Error("download-closed"));
                    else resolve();
                };
            });
        }

        async function startStream(message, sender) {
            if (!isRecordingFileName(message.fileName)) return { ok: false, error: "invalid-request" };
            for (const session of sessions.values()) {
                if (now() - session.updatedAt > STREAM_TIMEOUT_MS * 3) dispose(session, "recording-expired");
            }
            if (sessions.size >= MAX_PENDING) return { ok: false, error: "too-many-recordings" };
            const [folder, held] = await Promise.all([readFolder(), hasDownloadsPermission()]);
            // Recheck after async reads; simultaneous starts cannot exceed the bound.
            if (sessions.size >= MAX_PENDING) return { ok: false, error: "too-many-recordings" };
            syncListener();
            const id = crypto.randomUUID();
            const url = `${chrome.runtime.getURL(STREAM_PATH)}?id=${id}`;
            const session = {
                id,
                url,
                tabId: sender.tab.id,
                documentId: sender.documentId,
                fileName: message.fileName,
                folder: held && listeningEvent ? folder : "",
                updatedAt: now(),
                next: 0,
                opened: false,
                closed: false,
                writing: false,
            };
            sessions.set(id, session);
            try {
                const selected = await fileOperation(session, directory?.get() ?? Promise.resolve(null));
                if (selected) {
                    const opening = directory.openFile(selected, message.fileName).then((file) => {
                        if (session.closed) {
                            void file.writer.abort().catch(() => {});
                            throw new Error("directory-timeout");
                        }
                        session.writer = file.writer;
                        return file;
                    });
                    const file = await fileOperation(session, opening);
                    session.opened = true;
                    session.folder = "";
                    return { ok: true, id, destination: "directory", folder: selected.name, fileName: file.fileName };
                }
            } catch (error) {
                dispose(session, "directory-unavailable");
                return { ok: false, error: error.message === "directory-permission" ? "directory-permission" : "directory-unavailable" };
            }
            return { ok: true, id, url, folder: session.folder, routed: Boolean(session.folder) };
        }

        async function streamMessage(message, sender) {
            const session = sessions.get(message.id);
            if (!session || session.tabId !== sender.tab.id || session.documentId !== sender.documentId)
                return { ok: false, error: "unknown-recording" };
            session.updatedAt = now();
            if (message.op === "pulse") return { ok: true };
            if (message.op === "abort") {
                dispose(session, "recording-cancelled");
                return { ok: true };
            }
            if (session.writing) return { ok: false, error: "write-pending" };
            if (message.op === "finish") {
                if (!session.opened || message.sequence !== session.next)
                    return { ok: false, error: "invalid-sequence" };
                if (session.writer) {
                    session.writing = true;
                    try {
                        await fileOperation(session, session.writer.close());
                        if (session.closed) return { ok: false, error: "download-closed" };
                    } catch (_) {
                        return { ok: false, error: "directory-write-failed" };
                    }
                }
                dispose(session);
                return { ok: true };
            }
            if (message.op !== "ready" && message.op !== "write") return { ok: false, error: "unknown-operation" };
            let bytes;
            if (message.op === "write") {
                if (
                    message.sequence !== session.next ||
                    !Number.isSafeInteger(message.sequence) ||
                    typeof message.data !== "string" ||
                    !message.data.length ||
                    message.data.length > 87384 ||
                    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.data)
                )
                    return { ok: false, error: "invalid-chunk" };
                bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0));
                if (bytes.length > MAX_CHUNK_BYTES) return { ok: false, error: "invalid-chunk" };
            }
            session.writing = true;
            try {
                if (session.writer) {
                    if (bytes) {
                        await fileOperation(session, session.writer.write(bytes));
                        if (session.closed) return { ok: false, error: "download-closed" };
                        session.next += 1;
                    }
                    session.updatedAt = now();
                    return { ok: true };
                }
                await waitFor(session, () => session.opened && (!bytes || session.controller.desiredSize > 0));
                if (bytes) {
                    session.controller.enqueue(bytes);
                    session.next += 1;
                }
                session.updatedAt = now();
                return { ok: true };
            } catch (_) {
                return { ok: false, error: "download-closed" };
            } finally {
                session.writing = false;
            }
        }

        function handleFetch(event) {
            const request = event.request;
            const url = new URL(request.url);
            const endpoint = new URL(chrome.runtime.getURL(STREAM_PATH));
            if (url.protocol !== endpoint.protocol || url.host !== endpoint.host || url.pathname !== endpoint.pathname)
                return;
            const session = sessions.get(url.searchParams.get("id"));
            // Only an explicit navigation consumes the one-use download. Page fetches cannot read recordings.
            if (
                !session ||
                session.opened ||
                request.method !== "GET" ||
                request.mode !== "navigate" ||
                request.destination !== "document" ||
                request.url !== session.url
            ) {
                event.respondWith(new Response(null, { status: 204 }));
                return;
            }
            const stream = new ReadableStream({
                start(controller) {
                    session.controller = controller;
                },
                pull() {
                    session.wake?.();
                },
                cancel() {
                    sessions.delete(session.id);
                    session.closed = true;
                    session.wake?.();
                },
            });
            session.opened = true;
            session.updatedAt = now();
            event.respondWith(
                new Response(stream, {
                    headers: {
                        "Content-Type": session.fileName.endsWith(".mp4") ? "video/mp4" : "video/webm",
                        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(session.fileName)}`,
                        "Cache-Control": "no-store",
                        "X-Content-Type-Options": "nosniff",
                    },
                })
            );
            session.wake?.();
        }
        let listeningEvent = null;

        function prune() {
            const current = now();
            for (const [url, entry] of pending) if (entry.expiresAt <= current) pending.delete(url);
        }

        function onDeterminingFilename(item, suggest) {
            for (const session of sessions.values()) {
                if (session.folder && !session.named && (item?.url === session.url || item?.finalUrl === session.url)) {
                    session.named = true;
                    suggest({ filename: `${session.folder}/${session.fileName}`, conflictAction: "uniquify" });
                    return;
                }
            }
            prune();
            const url = pending.has(item?.url) ? item.url : pending.has(item?.finalUrl) ? item.finalUrl : "";
            // Not ours: return without suggesting, so Chrome (or another extension) keeps deciding.
            if (!url) return;
            const entry = pending.get(url);
            pending.delete(url);
            suggest({ filename: entry.path, conflictAction: "uniquify" });
        }

        function syncListener() {
            const event = chrome.downloads?.onDeterminingFilename;
            if (!event || listeningEvent === event) return;
            listeningEvent = event;
            event.addListener(onDeterminingFilename);
        }

        function hasDownloadsPermission() {
            return new Promise((resolve) => {
                const permissions = chrome.permissions;
                if (typeof permissions?.contains !== "function") {
                    resolve(false);
                    return;
                }
                try {
                    permissions.contains(DOWNLOADS_PERMISSION, (held) => {
                        resolve(!chrome.runtime?.lastError && held === true);
                    });
                } catch (_) {
                    resolve(false);
                }
            });
        }

        function readFolder() {
            return new Promise((resolve) => {
                const sync = chrome.storage?.sync;
                if (typeof sync?.get !== "function") {
                    resolve("");
                    return;
                }
                sync.get([FOLDER_KEY], (data) => {
                    if (chrome.runtime?.lastError) {
                        resolve("");
                        return;
                    }
                    resolve(globalThis.CheeseSpannerSettings.normalizeDownloadFolder(data?.[FOLDER_KEY], ""));
                });
            });
        }

        async function prepare(message) {
            if (!isRecordingBlobUrl(message.url) || !isRecordingFileName(message.fileName)) {
                return { ok: false, error: "invalid-request" };
            }
            const [folder, held] = await Promise.all([readFolder(), hasDownloadsPermission()]);
            if (!folder) return { ok: true, routed: false, reason: "no-folder" };
            syncListener();
            if (!held || !listeningEvent) return { ok: true, routed: false, reason: "no-permission", folder };
            prune();
            pending.delete(message.url);
            while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
            pending.set(message.url, { path: `${folder}/${message.fileName}`, expiresAt: now() + PENDING_TTL_MS });
            return { ok: true, routed: true, folder };
        }

        async function handleMessage(message, sender) {
            if (!isRecorderSender(sender, chrome.runtime?.id)) return { ok: false, error: "untrusted-sender" };
            if (message?.version !== MESSAGE_VERSION) return { ok: false, error: "unsupported-version" };
            if (message.op === "status") {
                const [folder, held] = await Promise.all([readFolder(), hasDownloadsPermission()]);
                try {
                    const selected = await directory?.get();
                    return { ok: true, folder, downloads: held, ...(selected ? { directory: selected.name, directoryGranted: await selected.queryPermission({ mode: "readwrite" }) === "granted" } : {}) };
                } catch (_) {
                    return { ok: false, error: "directory-unavailable" };
                }
            }
            if (message.op === "folder-settings") {
                try {
                    await chrome.tabs.create({ url: chrome.runtime.getURL("options.html#recording-folder") });
                    return { ok: true };
                } catch (_) {
                    return { ok: false, error: "settings-unavailable" };
                }
            }
            if (message.op === "prepare") return prepare(message);
            if (message.op === "start") return startStream(message, sender);
            if (["ready", "write", "finish", "abort", "pulse"].includes(message.op))
                return streamMessage(message, sender);
            return { ok: false, error: "unknown-operation" };
        }

        function install() {
            if (installed) return;
            installed = true;
            globalThis.addEventListener?.("fetch", handleFetch);
            // Registered at startup when the optional permission is already held, otherwise once it is granted.
            syncListener();
            chrome.permissions?.onAdded?.addListener(syncListener);
        }

        return { handleMessage, handleFetch, install, onDeterminingFilename };
    }

    globalThis.CheeseSpannerRecordingDownloads = Object.freeze({
        MESSAGE_TYPE,
        MESSAGE_VERSION,
        DOWNLOADS_PERMISSION,
        PENDING_TTL_MS,
        MAX_PENDING,
        STREAM_PATH,
        MAX_CHUNK_BYTES,
        isRecordingBlobUrl,
        isRecordingFileName,
        createController,
    });
})();
