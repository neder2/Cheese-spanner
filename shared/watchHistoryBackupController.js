/** Background-only request coordination; queue and storage capabilities are injected by the single writer. */
(() => {
    "use strict";
    const MESSAGE_TYPE = "betterchzzk:watch-history-backup";
    const TOKEN_TTL_MS = 5 * 60 * 1000;
    const MAX_TOKENS = 8;
    const messages = {
        UNTRUSTED_SENDER: "시청 기록 페이지에서 다시 시도해 주세요.",
        INVALID_REQUEST: "백업 요청을 확인할 수 없어요. 시청 기록 페이지를 다시 열어 주세요.",
        INVALID_FILE: "백업 파일의 형식이나 기록 내용이 올바르지 않아요.",
        UNSUPPORTED_VERSION: "지원하지 않는 백업 파일 버전이에요.",
        LIMIT_EXCEEDED: "합친 기록이 파일 크기나 보관 한도를 넘어요. 기존 기록은 변경하지 않았어요.",
        STORAGE_READ_FAILED: "기존 시청 기록을 읽지 못했어요. 잠시 후 다시 시도해 주세요.",
        STORAGE_WRITE_FAILED: "시청 기록을 저장하지 못했어요. 기존 기록은 유지돼요. 저장 공간을 확인해 주세요.",
    };

    function fail(code) {
        const error = new Error(messages[code]);
        error.code = code;
        throw error;
    }
    function trustedPage(sender, runtime) {
        if (
            sender?.id !== runtime.id ||
            typeof sender.documentId !== "string" ||
            !sender.documentId ||
            sender.documentId.length > 200 ||
            (sender.frameId !== undefined && sender.frameId !== 0)
        )
            return null;
        try {
            const actual = new URL(sender.url);
            const expected = new URL(runtime.getURL("history.html"));
            if (
                actual.protocol !== expected.protocol ||
                actual.hostname !== expected.hostname ||
                actual.pathname !== expected.pathname ||
                actual.username ||
                actual.password ||
                actual.port ||
                actual.search ||
                actual.hash
            )
                return null;
            return `${actual.href}|${sender.documentId}`;
        } catch {
            return null;
        }
    }

    function validateRequest(value) {
        if (
            !value ||
            typeof value !== "object" ||
            Array.isArray(value) ||
            value.version !== 1 ||
            !["export", "preview", "import"].includes(value.action)
        )
            fail("INVALID_REQUEST");
        const allowed = [
            "type",
            "version",
            "action",
            ...(value.action === "export" ? [] : ["backup"]),
            ...(value.action === "import" ? ["confirmationToken"] : []),
        ];
        if (Object.keys(value).some((key) => !allowed.includes(key))) fail("INVALID_REQUEST");
        if (
            value.confirmationToken !== undefined &&
            (typeof value.confirmationToken !== "string" || value.confirmationToken.length > 200)
        )
            fail("INVALID_REQUEST");
    }

    async function fingerprint(backup) {
        const bytes = new TextEncoder().encode(JSON.stringify(backup));
        const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    function createController({ runtime, enqueue, readHistory, writeHistory, now = Date.now, maxStorageBytes }) {
        const tokens = new Map();
        const fileApi = globalThis.BetterChzzkWatchHistoryBackup;
        const merger = globalThis.BetterChzzkWatchHistoryBackupMerge;
        function pruneTokens(at) {
            for (const [token, saved] of tokens) if (saved.expiresAt <= at) tokens.delete(token);
        }
        function previewResult(status, outcome, page, hash, at) {
            pruneTokens(at);
            while (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
            const confirmationToken = globalThis.crypto.randomUUID();
            tokens.set(confirmationToken, {
                page,
                hash,
                meaning: outcome.confirmationMeaning,
                expiresAt: at + TOKEN_TTL_MS,
            });
            return { status, confirmationToken, summary: outcome.summary, items: outcome.items };
        }
        async function execute(message, page) {
            let history;
            try {
                history = await readHistory();
            } catch {
                fail("STORAGE_READ_FAILED");
            }
            const at = now();
            if (message.action === "export")
                return {
                    status: "exported",
                    backup: fileApi.createBackup(history, {
                        extensionVersion: runtime.getManifest?.().version || "0",
                        now: at,
                    }),
                };
            const file = fileApi.validateBackup(message.backup, { now: at });
            const outcome = merger.mergeBackup(history, file, { now: at, maxStorageBytes });
            const hash = await fingerprint(file);
            if (message.action === "preview") return previewResult("preview", outcome, page, hash, at);
            pruneTokens(at);
            const saved = tokens.get(message.confirmationToken);
            if (message.confirmationToken) tokens.delete(message.confirmationToken);
            if (!saved || saved.page !== page || saved.hash !== hash || saved.meaning !== outcome.confirmationMeaning) {
                return previewResult("reconfirm", outcome, page, hash, at);
            }
            if (outcome.changed) {
                try {
                    await writeHistory(outcome.history);
                } catch {
                    fail("STORAGE_WRITE_FAILED");
                }
            }
            return {
                status: outcome.changed ? "applied" : "unchanged",
                summary: outcome.summary,
                items: outcome.items,
            };
        }
        async function handle(message, sender) {
            try {
                const page = trustedPage(sender, runtime);
                if (!page) fail("UNTRUSTED_SENDER");
                validateRequest(message);
                return { ok: true, result: await enqueue(() => execute(message, page)) };
            } catch (error) {
                const code = Object.hasOwn(messages, error?.code) ? error.code : "INVALID_REQUEST";
                return { ok: false, error: { code, message: messages[code] } };
            }
        }
        return Object.freeze({ handle });
    }
    globalThis.BetterChzzkWatchHistoryBackupController = Object.freeze({ MESSAGE_TYPE, createController });
})();
