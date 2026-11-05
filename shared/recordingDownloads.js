/**
 * shared/recordingDownloads.js — 플레이어 녹화 파일을 저장 폴더로 보내는 워커 쪽 경계 (globalThis.CheeseSpannerRecordingDownloads)
 *
 * 실행 컨텍스트: 서비스 워커(background.js의 importScripts). DOM을 쓰지 않아요.
 * 하는 일: 치지직 탭의 녹화 기능(features/videoRecorder.js)이 파일을 내려받기 직전에 보낸 blob 주소 하나를
 *   잠깐 기억했다가, 그 주소의 다운로드가 시작되면 chrome.downloads.onDeterminingFilename에서
 *   "<저장 폴더>/<파일 이름>"을 제안해요. 다른 다운로드에는 아무것도 제안하지 않아 Chrome이 원래대로 처리해요.
 *   - 저장 폴더는 메시지가 아니라 sync 옵션 videoRecorderFolder에서 읽고 normalizeDownloadFolder로 다시 검증해요.
 *   - 선택 권한 downloads가 없거나 폴더가 비어 있으면 기억하지 않아요. 그 파일은 Chrome 다운로드 폴더에 저장돼요.
 *   - 기억한 주소는 60초·최대 8개까지만 메모리에 두고, 워커가 다시 시작되면 사라져요(그때도 기본 폴더에 저장돼요).
 * 발신자: 같은 확장 ID, 탭의 최상위 프레임, 정확한 https://chzzk.naver.com 출처만 받아요.
 * 공개 API: MESSAGE_TYPE, MESSAGE_VERSION, DOWNLOADS_PERMISSION, isRecordingBlobUrl, isRecordingFileName,
 *   createController({ chrome, now }) → { handleMessage(message, sender), install(), onDeterminingFilename }.
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

    function createController({ chrome, now = () => Date.now() }) {
        const pending = new Map();
        let listeningEvent = null;

        function prune() {
            const current = now();
            for (const [url, entry] of pending) if (entry.expiresAt <= current) pending.delete(url);
        }

        function onDeterminingFilename(item, suggest) {
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
                return { ok: true, folder, downloads: held };
            }
            if (message.op === "prepare") return prepare(message);
            return { ok: false, error: "unknown-operation" };
        }

        function install() {
            // Registered at startup when the optional permission is already held, otherwise once it is granted.
            syncListener();
            chrome.permissions?.onAdded?.addListener(syncListener);
        }

        return { handleMessage, install, onDeterminingFilename };
    }

    globalThis.CheeseSpannerRecordingDownloads = Object.freeze({
        MESSAGE_TYPE,
        MESSAGE_VERSION,
        DOWNLOADS_PERMISSION,
        PENDING_TTL_MS,
        MAX_PENDING,
        isRecordingBlobUrl,
        isRecordingFileName,
        createController,
    });
})();
