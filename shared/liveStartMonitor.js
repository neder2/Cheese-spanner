/* MV3 background only. One alarm and one serial queue own live-start actions. */
(() => {
    if (!globalThis.chrome?.alarms?.onAlarm) return;
    const { CHANNELS_KEY, STATE_KEY, STATUS_KEY, normalizeChannels, parseSnapshot } = globalThis.BetterChzzkLiveStart;
    const { storageGet, storageSet, fetchJson } = BetterChzzk.utils;
    const { normalizeOptions } = BetterChzzkSettings;
    const OPTION_KEYS = ["liveStartNotificationsEnabled", "liveStartAutoOpenEnabled"];
    const ALARM = "betterchzzk:live-start";
    const NOTIFICATION_PREFIX = "betterchzzk:live-start:";
    const PERIOD_MINUTES = 1;
    const MAX_SEEN = 16;
    let queue = Promise.resolve();
    let tabQueue = Promise.resolve();
    let generation = 0;
    let controller = null;
    let pollPending = false;
    let clickListenerBound = false;
    let resetAll = false;
    const resetActions = new Set();
    const resetRules = new Set();

    function enqueue(task) {
        const pending = queue.then(task);
        queue = pending.catch((error) => console.warn("[Cheese Spanner] 방송 시작 확인 실패", error));
        return pending;
    }

    async function readConfig() {
        const [rawOptions, local, permission] = await Promise.all([
            storageGet(chrome.storage.sync, OPTION_KEYS),
            storageGet(chrome.storage.local, [CHANNELS_KEY, STATE_KEY]),
            chrome.permissions.contains({ permissions: ["notifications"] }),
        ]);
        const options = normalizeOptions(rawOptions);
        const channels = normalizeChannels(local[CHANNELS_KEY])
            .map((channel) => ({
                ...channel,
                notify: channel.notify && options.liveStartNotificationsEnabled && permission,
                autoOpen: channel.autoOpen && options.liveStartAutoOpenEnabled,
            }))
            .filter((channel) => channel.notify || channel.autoOpen);
        const states = {};
        for (const channel of channels) {
            const saved = local[STATE_KEY]?.channels?.[channel.channelId];
            const state = {};
            for (const action of ["notify", "autoOpen"]) {
                if (channel[action] && Array.isArray(saved?.[action])) {
                    state[action] = saved[action]
                        .filter((id) => typeof id === "string" && /^\d{1,16}$/.test(id))
                        .slice(-MAX_SEEN);
                }
            }
            states[channel.channelId] = state;
        }
        return {
            channels,
            states,
            checkedAt: Number(local[STATE_KEY]?.checkedAt) || 0,
            permissionMissing: options.liveStartNotificationsEnabled && !permission,
        };
    }

    function saveStates(config, checkedAt = config.checkedAt) {
        return storageSet(chrome.storage.local, { [STATE_KEY]: { checkedAt, channels: config.states } });
    }

    function liveChannel(url) {
        try {
            const parsed = new URL(url);
            return parsed.origin === "https://chzzk.naver.com"
                ? parsed.pathname.match(/^\/live\/([a-f0-9]{32})\/?$/i)?.[1].toLowerCase() || ""
                : "";
        } catch (_) {
            return "";
        }
    }

    function openChannel(channelId, active, isCurrent = () => true) {
        const pending = tabQueue.then(async () => {
            if (!isCurrent()) return;
            const tabs = await chrome.tabs.query({ url: "https://chzzk.naver.com/*" });
            if (!isCurrent()) return;
            const existing = tabs.find((tab) => liveChannel(tab.pendingUrl || tab.url) === channelId);
            if (existing) {
                if (active) {
                    await chrome.tabs.update(existing.id, { active: true });
                    await chrome.windows.update(existing.windowId, { focused: true });
                }
                return;
            }
            await chrome.tabs.create({ url: `https://chzzk.naver.com/live/${channelId}`, active });
        });
        tabQueue = pending.catch(() => {});
        return pending;
    }

    async function checkChannels(config, token, baseline) {
        controller = new AbortController();
        const signal = controller.signal;
        const isCurrent = () => token === generation && !signal.aborted;
        let failed = false;
        let index = 0;
        // Two requests at a time; no burst proportional to the channel list size.
        async function worker() {
            while (isCurrent() && index < config.channels.length) {
                const channel = config.channels[index++];
                try {
                    const json = await fetchJson(
                        `https://api.chzzk.naver.com/service/v3/channels/${channel.channelId}/live-detail`,
                        {
                            signal,
                            timeoutMs: 8000,
                            cache: "no-store",
                        }
                    );
                    if (!isCurrent()) return;
                    const snapshot = parseSnapshot(json, channel.channelId);
                    if (!snapshot) throw new Error("Invalid live status");
                    const state = config.states[channel.channelId];
                    const actions = [];
                    for (const action of ["notify", "autoOpen"]) {
                        if (!channel[action]) continue;
                        const seen = state[action];
                        if (!baseline && seen && snapshot.open && !seen.includes(snapshot.liveId)) actions.push(action);
                        state[action] = [...(seen || []).filter((id) => id !== snapshot.liveId), snapshot.liveId].slice(
                            -MAX_SEEN
                        );
                    }
                    // Persist before side effects: a terminated worker must not repeat an action.
                    // A separate write queue avoids an older concurrent snapshot winning the race.
                    await persist();
                    if (!isCurrent()) return;
                    for (const action of actions) {
                        if (!isCurrent()) return;
                        try {
                            if (action === "notify") {
                                await chrome.notifications.create(
                                    `${NOTIFICATION_PREFIX}${channel.channelId}:${snapshot.liveId}`,
                                    {
                                        type: "basic",
                                        iconUrl: chrome.runtime.getURL("icons/cheese-spanner128.png"),
                                        title: `${snapshot.channelName || channel.channelName || channel.channelId} 방송 시작`,
                                        message: snapshot.title || "라이브 방송이 시작됐어요.",
                                    }
                                );
                            } else {
                                await openChannel(channel.channelId, false, isCurrent);
                            }
                        } catch (_) {
                            failed = true;
                        }
                    }
                } catch (_) {
                    if (isCurrent()) failed = true;
                }
            }
        }
        let writes = Promise.resolve();
        function persist() {
            const pending = writes.then(() => {
                if (isCurrent()) return saveStates(config);
            });
            writes = pending.catch(() => {});
            return pending;
        }
        try {
            await Promise.all([worker(), worker()]);
            if (!isCurrent()) return;
            const checkedAt = Date.now();
            await saveStates(config, checkedAt);
            if (!isCurrent()) return;
            await storageSet(chrome.storage.local, {
                [STATUS_KEY]: {
                    checkedAt,
                    error: failed
                        ? "일부 채널의 방송 확인·알림·탭 열기에 실패했어요. 네트워크와 알림 권한을 확인해 주세요."
                        : config.permissionMissing
                          ? "알림 권한이 없어 데스크톱 알림이 중지됐어요. 알림 권한 허용을 눌러 주세요."
                          : "",
                    activeChannels: config.channels.length,
                },
            });
        } finally {
            controller = null;
        }
    }

    async function reconcile(token, { force = false, baseline = false } = {}) {
        const config = await readConfig();
        if (token !== generation) return;
        for (const channel of config.channels) {
            for (const action of ["notify", "autoOpen"]) {
                if (resetAll || resetActions.has(action) || resetRules.has(`${channel.channelId}:${action}`)) {
                    delete config.states[channel.channelId][action];
                }
            }
        }
        await saveStates(config);
        if (token !== generation) return;
        resetAll = false;
        resetActions.clear();
        resetRules.clear();
        if (!config.channels.length) {
            await chrome.alarms.clear(ALARM);
            await storageSet(chrome.storage.local, {
                [STATUS_KEY]: {
                    checkedAt: 0,
                    activeChannels: 0,
                    error: config.permissionMissing
                        ? "알림 권한이 없어 데스크톱 알림이 중지됐어요. 알림 권한 허용을 눌러 주세요."
                        : "",
                },
            });
            return;
        }
        const alarm = await chrome.alarms.get(ALARM);
        if (token !== generation) return;
        if (!alarm || alarm.periodInMinutes !== PERIOD_MINUTES) {
            await chrome.alarms.create(ALARM, { delayInMinutes: PERIOD_MINUTES, periodInMinutes: PERIOD_MINUTES });
        }
        if (token !== generation) return;
        const elapsed = Date.now() - config.checkedAt;
        if (force || elapsed < 0 || elapsed >= 55000) await checkChannels(config, token, baseline);
    }

    function refresh(options) {
        if (options?.baseline) resetAll = true;
        generation++;
        controller?.abort();
        const token = generation;
        void enqueue(() => reconcile(token, { force: true, ...options })).catch(() => {});
    }

    chrome.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name !== ALARM || pollPending) return;
        pollPending = true;
        const token = generation;
        void enqueue(() => reconcile(token))
            .finally(() => {
                pollPending = false;
            })
            .catch(() => {});
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "sync") {
            for (const [key, action] of [
                ["liveStartNotificationsEnabled", "notify"],
                ["liveStartAutoOpenEnabled", "autoOpen"],
            ]) {
                if (Object.hasOwn(changes, key)) resetActions.add(action);
            }
        }
        if (area === "local" && Object.hasOwn(changes, CHANNELS_KEY)) {
            const change = changes[CHANNELS_KEY];
            const previous = new Map(normalizeChannels(change.oldValue).map((channel) => [channel.channelId, channel]));
            for (const channel of normalizeChannels(change.newValue)) {
                for (const action of ["notify", "autoOpen"]) {
                    if (previous.get(channel.channelId)?.[action] !== channel[action])
                        resetRules.add(`${channel.channelId}:${action}`);
                }
            }
        }
        if (
            (area === "sync" && OPTION_KEYS.some((key) => Object.hasOwn(changes, key))) ||
            (area === "local" && Object.hasOwn(changes, CHANNELS_KEY))
        )
            refresh();
    });
    chrome.permissions.onAdded?.addListener((change) => {
        if (!change.permissions?.includes("notifications")) return;
        resetActions.add("notify");
        bindNotificationClicks();
        refresh();
    });
    chrome.permissions.onRemoved?.addListener((change) => {
        if (!change.permissions?.includes("notifications")) return;
        resetActions.add("notify");
        refresh();
    });
    chrome.runtime.onStartup?.addListener(() => refresh({ baseline: true }));
    chrome.runtime.onInstalled.addListener(() => refresh({ baseline: true }));
    function registrationKey(kind) {
        return kind === "set-notify" ? "notify" : kind === "set-auto-open" ? "autoOpen" : null;
    }
    function isChannelRegistration(message, sender) {
        const key = registrationKey(message.kind);
        if (message.kind !== "remove" && (!key || typeof message.channel?.[key] !== "boolean")) return false;
        if (!Number.isInteger(sender?.tab?.id) || sender.tab.id < 0 || sender.frameId !== 0) return false;
        try {
            // Search registration can target any channel. The context URL can also
            // predate SPA navigation, so authorize the origin rather than its route.
            return new URL(sender.url).origin === "https://chzzk.naver.com";
        } catch {
            return false;
        }
    }
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message?.type !== "betterchzzk:live-start:channels") return undefined;
        const fromOptions = sender?.url === chrome.runtime.getURL("options.html");
        if (sender?.id !== chrome.runtime.id || (!fromOptions && !isChannelRegistration(message, sender))) {
            sendResponse({ ok: false, error: "알림 설정 요청의 출처를 확인하지 못했어요." });
            return false;
        }
        // Stop outstanding reads as soon as the user edits a channel rule.
        generation++;
        controller?.abort();
        void enqueue(async () => {
            const id = message.channel?.channelId;
            const key = registrationKey(message.kind);
            if (
                typeof id !== "string" ||
                !/^[a-f0-9]{32}$/.test(id) ||
                (!key && !["add", "update", "remove"].includes(message.kind)) ||
                (key && typeof message.channel[key] !== "boolean")
            )
                throw new Error("올바른 채널 설정이 아니에요.");
            const data = await storageGet(chrome.storage.local, CHANNELS_KEY);
            let channels = normalizeChannels(data[CHANNELS_KEY]);
            const existing = channels.find((channel) => channel.channelId === id);
            if (key) {
                if (existing) existing[key] = message.channel[key];
                else if (message.channel[key]) {
                    if (channels.length >= globalThis.BetterChzzkLiveStart.MAX_CHANNELS)
                        throw new Error("채널은 최대 32개까지 등록할 수 있어요.");
                    const json = await fetchJson(`https://api.chzzk.naver.com/service/v1/channels/${id}`, {
                        timeoutMs: 8000,
                    });
                    if (
                        json?.code !== 200 ||
                        json.content?.channelId !== id ||
                        typeof json.content.channelName !== "string" ||
                        !json.content.channelName.trim()
                    )
                        throw new Error("채널 정보를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.");
                    channels.push(
                        normalizeChannels([
                            {
                                channelId: id,
                                channelName: json.content.channelName,
                                channelImageUrl: json.content.channelImageUrl,
                                notify: false,
                                autoOpen: false,
                                [key]: true,
                            },
                        ])[0]
                    );
                }
            } else if (message.kind === "remove") {
                channels = channels.filter((channel) => channel.channelId !== id);
            } else if (message.kind === "add") {
                if (existing) throw new Error("이미 등록한 채널이에요.");
                if (channels.length >= globalThis.BetterChzzkLiveStart.MAX_CHANNELS)
                    throw new Error("채널은 최대 32개까지 등록할 수 있어요.");
                const channel = normalizeChannels([message.channel])[0];
                if (!channel.channelName) throw new Error("채널 이름을 확인하지 못했어요.");
                channels.push(channel);
            } else {
                if (!existing) throw new Error("삭제된 채널이에요. 목록을 다시 확인해 주세요.");
                for (const key of ["notify", "autoOpen"]) {
                    if (typeof message.channel[key] === "boolean") existing[key] = message.channel[key];
                }
            }
            await storageSet(chrome.storage.local, { [CHANNELS_KEY]: channels });
            return channels;
        }).then(
            (channels) => sendResponse({ ok: true, channels }),
            (error) => sendResponse({ ok: false, error: error.message || "채널 설정을 저장하지 못했어요." })
        );
        return true;
    });
    function bindNotificationClicks() {
        if (clickListenerBound || !chrome.notifications?.onClicked) return;
        clickListenerBound = true;
        chrome.notifications.onClicked.addListener((id) => {
            const channelId = id.startsWith(NOTIFICATION_PREFIX)
                ? id.slice(NOTIFICATION_PREFIX.length).match(/^([a-f0-9]{32}):\d{1,16}$/)?.[1]
                : "";
            if (!channelId) return;
            void openChannel(channelId, true)
                .then(() => chrome.notifications.clear(id))
                .catch((error) => {
                    console.warn("[Cheese Spanner] 알림 방송 열기 실패", error);
                });
        });
    }
    bindNotificationClicks();
    const token = generation;
    void enqueue(() => reconcile(token)).catch(() => {});
})();
