(() => {
    "use strict";

    const TOKEN_TTL_MS = 30_000;
    const SETTINGS_TARGETS = new Set(["panels", "history", "stream"]);
    const idle = () => ({ ok: true, show: false });
    const failed = () => ({ ok: false, show: false });

    function parseVersion(value) {
        if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value)) return null;
        const parts = value.split(".").map(Number);
        return parts.every((part) => Number.isInteger(part) && part <= 65535) ? parts : null;
    }

    function compareVersions(left, right) {
        for (let index = 0; index < 4; index++) {
            const difference = (left[index] || 0) - (right[index] || 0);
            if (difference) return Math.sign(difference);
        }
        return 0;
    }

    function validIdentity(value) {
        return (
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= 200 &&
            Array.from(value).every((character) => character.charCodeAt(0) >= 32)
        );
    }

    function senderIdentity(sender, runtime, clientId) {
        if (sender?.id !== runtime.id || !Number.isInteger(sender.tab?.id) || sender.tab.id < 0 || sender.frameId !== 0)
            return null;
        try {
            const url = new URL(sender.url);
            if (url.origin !== "https://chzzk.naver.com" || url.username || url.password) return null;
            if (sender.documentId !== undefined) {
                return validIdentity(sender.documentId) ? JSON.stringify([sender.tab.id, sender.documentId]) : null;
            }
            return validIdentity(clientId) ? JSON.stringify([sender.tab.id, sender.frameId, url.href, clientId]) : null;
        } catch {
            return null;
        }
    }

    function createController({ chrome, catalog }) {
        let queue = Promise.resolve();
        let reservation = null;
        let optionEpoch = 0;
        let optionOverride;
        let automaticSuppressed = false;

        function enqueue(task) {
            const result = queue.then(task).catch(failed);
            queue = result.then(() => undefined);
            return result;
        }

        function callApi(invoke) {
            return new Promise((resolve, reject) => {
                invoke((value) => {
                    const error = chrome.runtime.lastError;
                    if (error) reject(new Error(error.message || "Extension operation failed"));
                    else resolve(value);
                });
            });
        }

        function installedVersion() {
            const version = chrome.runtime.getManifest().version;
            if (!parseVersion(version)) throw new Error("Invalid installed version");
            return version;
        }

        async function readState() {
            const values = await callApi((done) => chrome.storage.local.get(catalog.STORAGE_KEY, done));
            if (!values || typeof values !== "object" || Array.isArray(values))
                throw new Error("Invalid storage result");
            if (!Object.hasOwn(values, catalog.STORAGE_KEY)) return null;
            const value = values[catalog.STORAGE_KEY];
            if (
                !value ||
                typeof value !== "object" ||
                Array.isArray(value) ||
                value.schemaVersion !== 1 ||
                !parseVersion(value.version) ||
                !["pending", "seen", "suppressed"].includes(value.status) ||
                Object.keys(value).some((key) => !["schemaVersion", "version", "status"].includes(key))
            )
                throw new Error("Invalid guide state");
            return value;
        }

        async function writeState(version, status) {
            await callApi((done) =>
                chrome.storage.local.set(
                    {
                        [catalog.STORAGE_KEY]: { schemaVersion: 1, version, status },
                    },
                    done
                )
            );
        }

        async function readEnabled() {
            const epoch = optionEpoch;
            const values = await callApi((done) => chrome.storage.sync.get(catalog.OPTION_KEY, done));
            if (!values || typeof values !== "object" || Array.isArray(values))
                throw new Error("Invalid options result");
            const value = values[catalog.OPTION_KEY];
            if (value !== undefined && typeof value !== "boolean") throw new Error("Invalid guide option");
            return epoch !== optionEpoch ? optionOverride !== false : value !== false;
        }

        async function suppressPending(state) {
            automaticSuppressed = true;
            reservation = null;
            if (state?.status === "pending") await writeState(state.version, "suppressed");
        }

        function pruneReservation() {
            if (reservation && reservation.expiresAt <= Date.now()) reservation = null;
        }

        function validRequest(message, version) {
            if (
                !message ||
                typeof message !== "object" ||
                Array.isArray(message) ||
                message.type !== catalog.MESSAGE_TYPE ||
                message.protocol !== catalog.PROTOCOL ||
                message.guideVersion !== version ||
                !catalog.getGuide(version) ||
                !["claim", "commit", "release", "open-settings"].includes(message.action)
            )
                return false;
            const allowed = ["type", "protocol", "action", "guideVersion", "clientId"];
            if (message.action === "commit" || message.action === "release") allowed.push("token");
            if (message.action === "open-settings") allowed.push("target");
            if (Object.keys(message).some((key) => !allowed.includes(key))) return false;
            if (message.clientId !== undefined && !validIdentity(message.clientId)) return false;
            if ((message.action === "commit" || message.action === "release") && !validIdentity(message.token))
                return false;
            return message.action !== "open-settings" || SETTINGS_TARGETS.has(message.target);
        }

        function onInstalled(details) {
            reservation = null;
            return enqueue(async () => {
                const version = installedVersion();
                const state = await readState();
                // Keep the newest durable record, including a legitimate pending update after a reload.
                if (state && compareVersions(parseVersion(state.version), parseVersion(version)) >= 0) return idle();
                const previous = parseVersion(details?.previousVersion);
                const upgraded =
                    details?.reason === "update" && previous && compareVersions(parseVersion(version), previous) > 0;
                const enabled = await readEnabled();
                await writeState(
                    version,
                    upgraded && catalog.getGuide(version) && enabled && !automaticSuppressed ? "pending" : "suppressed"
                );
                return idle();
            });
        }

        function handleMessage(message, sender) {
            return enqueue(async () => {
                const version = installedVersion();
                if (!validRequest(message, version)) return failed();
                const owner = senderIdentity(sender, chrome.runtime, message.clientId);
                if (!owner) return failed();
                const action = message.action;
                if (action === "open-settings") {
                    await callApi((done) =>
                        chrome.tabs.create(
                            {
                                url: chrome.runtime.getURL("options.html") + "#update-guide-" + message.target,
                            },
                            done
                        )
                    );
                    return idle();
                }
                pruneReservation();
                if (action === "release") {
                    if (reservation?.token === message.token && reservation.owner === owner) reservation = null;
                    return idle();
                }
                if (
                    sender.tab.active !== true ||
                    (sender.documentLifecycle !== undefined && sender.documentLifecycle !== "active")
                )
                    return idle();
                const epoch = optionEpoch;
                const pending = reservation;
                if (
                    action === "commit" &&
                    (!pending ||
                        pending.owner !== owner ||
                        pending.token !== message.token ||
                        pending.version !== version)
                )
                    return idle();
                const state = await readState();
                const enabled = await readEnabled();
                if (!enabled || optionOverride === false || automaticSuppressed) {
                    await suppressPending(state);
                    return idle();
                }
                if (epoch !== optionEpoch || state?.version !== version || state.status !== "pending") return idle();
                pruneReservation();
                if (action === "claim") {
                    // At most one tab can hold the preparation token. The token itself cannot authorize display.
                    if (reservation) return idle();
                    const token = globalThis.crypto.randomUUID();
                    reservation = { token, owner, version, expiresAt: Date.now() + TOKEN_TTL_MS };
                    return { ...idle(), token };
                }
                if (reservation !== pending) return idle();
                reservation = null;
                // Store consumption before responding, even if the document disappears before it can paint.
                await writeState(version, "seen");
                if (
                    epoch !== optionEpoch ||
                    optionOverride === false ||
                    pending.expiresAt <= Date.now() ||
                    installedVersion() !== version
                )
                    return idle();
                return { ok: true, show: true };
            });
        }

        function onOptionsChanged(changes, area) {
            if (area !== "sync" || !changes || !Object.hasOwn(changes, catalog.OPTION_KEY))
                return Promise.resolve(idle());
            const change = changes[catalog.OPTION_KEY];
            const value = change?.newValue;
            optionEpoch++;
            optionOverride = value === undefined || value === true;
            if (optionOverride && !automaticSuppressed && change?.oldValue !== false) return Promise.resolve(idle());
            // Revoke immediately; ON also retries a failed OFF write, including after a worker restart.
            automaticSuppressed = true;
            reservation = null;
            return enqueue(async () => {
                await suppressPending(await readState());
                return idle();
            });
        }

        return { onInstalled, handleMessage, onOptionsChanged };
    }

    globalThis.BetterChzzkUpdateGuideController = Object.freeze({ createController });
})();
