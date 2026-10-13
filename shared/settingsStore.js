/**
 * shared/settingsStore.js — 서비스 워커의 설정 저장 큐와 설정 파일 적용.
 *
 * 실행 컨텍스트: background.js(importScripts)만. DOM을 쓰지 않아요.
 * 하는 일: 치지직 콘텐츠가 요청한 설정 쓰기(betterchzzk:settings-store)를 발신자·키·값·기대값으로 검증하고,
 *   옵션 페이지가 요청한 설정 파일 내보내기·미리보기·적용(betterchzzk:settings-backup)을 처리해요.
 *   모든 쓰기는 옵션 페이지·설치 정규화·방송 대상 쓰기와 같은 설정 저장 잠금(withOptionsStorageLock) 안에서
 *   최신 값을 읽은 뒤 실행되므로 서로 끼어들지 않아요. 시청 기록·카테고리 제외·안내 큐와 분리돼요.
 * 의존: BetterChzzkSettings(잠금·옵션 발신자 검증), BetterChzzkSettingsBackup(대상 키·검증·계획).
 */
(() => {
    "use strict";

    const MAX_STORE_KEYS = 8;
    const AREAS = ["sync", "local"];

    function failure(code, current) {
        const error = new Error(code);
        error.code = code;
        if (current) error.current = current;
        return error;
    }

    function createController({
        chrome,
        withLock = globalThis.BetterChzzkSettings.withOptionsStorageLock,
        isOptionsPageSender = globalThis.BetterChzzkSettings.isOptionsPageSender,
        catalog = globalThis.BetterChzzkSettingsBackup,
        now = () => Date.now(),
    }) {
        let queue = Promise.resolve();

        // Arrival order inside the worker, then the shared Web Lock against options pages.
        function enqueue(task) {
            const run = queue.then(() => withLock(task));
            queue = run.catch(() => {});
            return run;
        }

        function call(area, method, argument) {
            return new Promise((resolve, reject) => {
                const target = chrome.storage?.[area];
                const readFailure = method === "get" || method === "getKeys";
                if (typeof target?.[method] !== "function") {
                    reject(failure(readFailure ? "storage-read-failed" : "storage-write-failed"));
                    return;
                }
                const done = (result) => {
                    if (chrome.runtime?.lastError)
                        reject(failure(readFailure ? "storage-read-failed" : "storage-write-failed"));
                    else resolve(result);
                };
                try {
                    if (method === "getKeys") target.getKeys(done);
                    else target[method](argument, done);
                } catch {
                    reject(failure(readFailure ? "storage-read-failed" : "storage-write-failed"));
                }
            });
        }

        async function read(area, keys) {
            if (!keys.length) return {};
            return (await call(area, "get", keys)) || {};
        }

        function isContentSender(sender) {
            if (sender?.id !== chrome.runtime?.id || sender.frameId !== 0) return false;
            if (!Number.isInteger(sender?.tab?.id) || sender.tab.id < 0) return false;
            try {
                const url = new URL(sender.url);
                return url.origin === "https://chzzk.naver.com" && !url.username && !url.password;
            } catch {
                return false;
            }
        }

        function readExpectation(entry) {
            if (!catalog.isPlainObject(entry)) return null;
            const keys = Object.keys(entry);
            if (keys.length === 1 && entry.absent === true) return { absent: true };
            if (keys.length === 1 && keys[0] === "value") return { value: entry.value };
            return null;
        }

        function parseStoreRequest(message) {
            const allowed = ["type", "version", "area", "values", "expected"];
            if (!catalog.isPlainObject(message) || Object.keys(message).some((key) => !allowed.includes(key)))
                throw failure("invalid-request");
            if (message.version !== 1 || !AREAS.includes(message.area)) throw failure("invalid-request");
            const entries = catalog.isPlainObject(message.values) ? Object.entries(message.values) : [];
            if (!entries.length || entries.length > MAX_STORE_KEYS) throw failure("invalid-request");
            const values = {};
            for (const [key, value] of entries) {
                if (!catalog.isStoreKey(message.area, key)) throw failure("key-not-allowed");
                const result = catalog.validateStoreEntry(message.area, key, value);
                if (!result.ok) throw failure("invalid-value");
                values[key] = result.value;
            }
            let expected = null;
            if (Object.hasOwn(message, "expected")) {
                const rows = catalog.isPlainObject(message.expected) ? Object.entries(message.expected) : [];
                if (!rows.length || rows.length > MAX_STORE_KEYS) throw failure("invalid-request");
                expected = {};
                for (const [key, entry] of rows) {
                    if (!catalog.isStoreKey(message.area, key)) throw failure("key-not-allowed");
                    const expectation = readExpectation(entry);
                    if (!expectation) throw failure("invalid-request");
                    expected[key] = expectation;
                }
            }
            return { area: message.area, values, expected };
        }

        function store(request) {
            return enqueue(async () => {
                if (request.expected) {
                    const keys = Object.keys(request.expected);
                    const data = await read(request.area, keys);
                    const current = {};
                    let conflict = false;
                    for (const key of keys) {
                        const exists = Object.hasOwn(data, key);
                        current[key] = exists ? { value: data[key] } : { absent: true };
                        const expectation = request.expected[key];
                        if (expectation.absent ? exists : !exists || !catalog.sameValue(data[key], expectation.value))
                            conflict = true;
                    }
                    if (conflict) throw failure("conflict", current);
                }
                await call(request.area, "set", request.values);
            });
        }

        async function readAllLocal() {
            const local = chrome.storage?.local;
            if (typeof local?.getKeys === "function") {
                const keys = await call("local", "getKeys");
                const wanted = (Array.isArray(keys) ? keys : []).filter(
                    (key) =>
                        Object.values(catalog.PANEL_KEYS).includes(key) ||
                        key === catalog.LIVE_START_CHANNELS_KEY ||
                        key === catalog.CHAT_MULTIVIEW_KEY ||
                        key.startsWith(catalog.MULTIVIEW_DELAY_PREFIX) ||
                        key.startsWith(catalog.MULTIVIEW_QUALITY_PREFIX)
                );
                return read("local", wanted);
            }
            return (await call("local", "get", null)) || {};
        }

        async function readTargets(backup) {
            const keys = catalog.targetKeys(backup);
            const [sync, local] = await Promise.all([read("sync", keys.sync), read("local", keys.local)]);
            return { sync, local };
        }

        function exportBackup() {
            return enqueue(async () => {
                const syncKeys = [...globalThis.BetterChzzkSettings.OPTION_KEYS, catalog.PINS_KEY, catalog.FOLDERS_KEY];
                const [syncData, localData] = await Promise.all([read("sync", syncKeys), readAllLocal()]);
                return catalog.createBackup({
                    syncData,
                    localData,
                    extensionVersion: chrome.runtime?.getManifest?.()?.version || "",
                    now: now(),
                });
            });
        }

        function parse(backupValue) {
            const parsed = catalog.parseBackup(backupValue);
            if (!parsed.ok)
                throw failure(parsed.error === "unsupported-version" ? "unsupported-version" : "invalid-file");
            return parsed;
        }

        function readDisabledKeys(value) {
            if (value === undefined) return [];
            const keys = globalThis.BetterChzzkSettings.OPTION_KEYS;
            if (!Array.isArray(value) || value.length > 16 || value.some((key) => !keys.includes(key)))
                throw failure("invalid-request");
            return [...new Set(value)];
        }

        function preview(backupValue, disabledOptionKeys) {
            const parsed = parse(backupValue);
            return enqueue(async () => {
                const current = await readTargets(parsed.backup);
                const plan = catalog.planImport(current, parsed.backup, { disabledOptionKeys });
                if (!plan.ok) throw failure("invalid-file");
                return {
                    fingerprint: catalog.fingerprint(current, parsed.backup),
                    summary: plan.summary,
                    ignoredOptionKeys: parsed.ignoredOptionKeys,
                    changes: countChanges(plan),
                };
            });
        }

        // Keys the plan would write; the options page offers to apply only while this is above zero.
        function countChanges(plan) {
            return plan.stages.reduce((sum, stage) => sum + Object.keys(stage.values).length, 0);
        }

        // Restores keys this restore wrote. Keys changed by another writer are reported as conflicts and left
        // untouched; keys whose read or write failed are reported separately as failures.
        async function rollback(applied, current, written, foreign) {
            const conflicted = [];
            const failed = [];
            for (const stage of [...applied].reverse()) {
                const keys = Object.keys(stage.values);
                let stored;
                try {
                    stored = await read(stage.area, keys);
                } catch {
                    failed.push(...keys.map((key) => `${stage.area}:${key}`));
                    continue;
                }
                const restore = {};
                const remove = [];
                for (const key of keys) {
                    const id = `${stage.area}:${key}`;
                    if (foreign.has(id) || !catalog.sameValue(stored[key], written.get(id))) {
                        conflicted.push(id);
                        continue;
                    }
                    const previous = current[stage.area];
                    if (Object.hasOwn(previous, key)) restore[key] = previous[key];
                    else remove.push(key);
                }
                try {
                    if (Object.keys(restore).length) await call(stage.area, "set", restore);
                } catch {
                    failed.push(...Object.keys(restore).map((key) => `${stage.area}:${key}`));
                }
                try {
                    if (remove.length) await call(stage.area, "remove", remove);
                } catch {
                    failed.push(...remove.map((key) => `${stage.area}:${key}`));
                }
            }
            return { conflicted, failed };
        }

        function apply(backupValue, expectedFingerprint, disabledOptionKeys) {
            const parsed = parse(backupValue);
            return enqueue(async () => {
                const current = await readTargets(parsed.backup);
                const plan = catalog.planImport(current, parsed.backup, { disabledOptionKeys });
                if (!plan.ok) throw failure("invalid-file");
                const print = catalog.fingerprint(current, parsed.backup);
                if (print !== expectedFingerprint)
                    return {
                        status: "reconfirm",
                        fingerprint: print,
                        summary: plan.summary,
                        changes: countChanges(plan),
                    };
                if (!plan.stages.length) return { status: "unchanged", summary: plan.summary };
                const written = new Map();
                const foreign = new Set();
                const targets = catalog.targetKeys(parsed.backup);
                const watched = new Set([
                    ...targets.sync.map((key) => `sync:${key}`),
                    ...targets.local.map((key) => `local:${key}`),
                ]);
                // Under the shared lock only Chrome sync from another device (or a writer outside the boundary)
                // can still change these keys. Such keys are never written again by later stages.
                const listener = (changes, areaName) => {
                    for (const key of Object.keys(changes || {})) {
                        const id = `${areaName}:${key}`;
                        if (!watched.has(id)) continue;
                        if (!written.has(id) || !catalog.sameValue(changes[key].newValue, written.get(id)))
                            foreign.add(id);
                    }
                };
                chrome.storage?.onChanged?.addListener?.(listener);
                const applied = [];
                const skipped = [];
                try {
                    for (const stage of plan.stages) {
                        const values = {};
                        for (const [key, value] of Object.entries(stage.values)) {
                            const id = `${stage.area}:${key}`;
                            if (foreign.has(id)) skipped.push(id);
                            else values[key] = value;
                        }
                        if (!Object.keys(values).length) continue;
                        const step = { ...stage, values };
                        for (const [key, value] of Object.entries(values)) written.set(`${stage.area}:${key}`, value);
                        try {
                            await call(stage.area, "set", values);
                        } catch {
                            const { conflicted, failed } = await rollback(applied, current, written, foreign);
                            return {
                                status: "failed",
                                stage: stage.name,
                                rolledBack: conflicted.length === 0 && failed.length === 0,
                                conflicted,
                                failed,
                                summary: plan.summary,
                            };
                        }
                        applied.push(step);
                    }
                    // Report every key an outside change touched during the restore; callers ask the user to check.
                    return {
                        status: "applied",
                        summary: plan.summary,
                        conflicts: [...new Set([...skipped, ...foreign])],
                    };
                } finally {
                    chrome.storage?.onChanged?.removeListener?.(listener);
                }
            });
        }

        function respond(promise, sendResponse, map) {
            promise.then(
                (value) => sendResponse({ ok: true, ...map(value) }),
                (error) =>
                    sendResponse({
                        ok: false,
                        error: typeof error?.code === "string" ? error.code : "unexpected-error",
                        ...(error?.current ? { current: error.current } : {}),
                    })
            );
            return true;
        }

        function handleMessage(message, sender, sendResponse) {
            if (message?.type === catalog.STORE_MESSAGE_TYPE) {
                if (!isContentSender(sender)) {
                    sendResponse({ ok: false, error: "untrusted-sender" });
                    return false;
                }
                let request;
                try {
                    request = parseStoreRequest(message);
                } catch (error) {
                    sendResponse({ ok: false, error: error.code || "invalid-request" });
                    return false;
                }
                return respond(store(request), sendResponse, () => ({}));
            }
            if (message?.type !== catalog.BACKUP_MESSAGE_TYPE) return undefined;
            if (sender?.id !== chrome.runtime?.id || !isOptionsPageSender(sender)) {
                sendResponse({ ok: false, error: "untrusted-sender" });
                return false;
            }
            const allowed = ["type", "version", "action", "backup", "fingerprint", "disabledOptionKeys"];
            if (
                !catalog.isPlainObject(message) ||
                message.version !== 1 ||
                Object.keys(message).some((key) => !allowed.includes(key))
            ) {
                sendResponse({ ok: false, error: "invalid-request" });
                return false;
            }
            try {
                if (message.action === "export") return respond(exportBackup(), sendResponse, (value) => value);
                const disabled = readDisabledKeys(message.disabledOptionKeys);
                if (message.action === "preview")
                    return respond(preview(message.backup, disabled), sendResponse, (value) => value);
                if (message.action === "apply" && typeof message.fingerprint === "string")
                    return respond(apply(message.backup, message.fingerprint, disabled), sendResponse, (result) => ({
                        result,
                    }));
                throw failure("invalid-request");
            } catch (error) {
                sendResponse({ ok: false, error: error.code || "invalid-request" });
                return false;
            }
        }

        return { handleMessage, store, exportBackup, preview, apply, enqueue };
    }

    globalThis.BetterChzzkSettingsStore = Object.freeze({ createController });
})();
