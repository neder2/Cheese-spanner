/**
 * shared/settingsBackup.js — 설정 저장 경계와 설정 파일이 공유하는 대상 키 목록·엄격 검증·파일 형식·적용 계획.
 *
 * 실행 컨텍스트: 서비스 워커(importScripts)와 옵션 페이지. DOM·chrome API를 쓰지 않아요.
 * 의존: BetterChzzkSettings(옵션 스키마), BetterChzzkLiveStart(방송 대상 상한), BetterChzzk.utils의
 *   normalizeChzzkImageUrl(있으면), 위임 모델 BetterChzzkFollowingFolders·BetterChzzkChatMultiview(있으면).
 * 공개 API: globalThis.BetterChzzkSettingsBackup — 상수, validateStoreEntry, createBackup, parseBackup,
 *   targetKeys, fingerprint, planImport, sameValue.
 * 저장 자체는 shared/settingsStore.js(워커)가 설정 저장 잠금 안에서 수행해요.
 */
(() => {
    "use strict";

    const FILE_KIND = "cheese-spanner.settings-backup";
    const FORMAT_VERSION = 1;
    const MAX_FILE_BYTES = 1024 * 1024;
    const STORE_MESSAGE_TYPE = "betterchzzk:settings-store";
    const BACKUP_MESSAGE_TYPE = "betterchzzk:settings-backup";
    const PINS_KEY = "betterchzzkPinnedFollowingChannelIds";
    const MAX_PINS = 64;
    const FOLDERS_KEY = "betterchzzk:following-folders:v1";
    const CHAT_MULTIVIEW_KEY = "betterchzzk:chat-multiview:v1";
    const PANEL_KEYS = Object.freeze({
        sidebarWidth: "betterchzzk:panel-resize:sidebar-width:v1",
        chatWidth: "betterchzzk:panel-resize:chat-width:v1",
        chatHeight: "betterchzzk:panel-resize:chat-height:v1",
    });
    const LIVE_START_CHANNELS_KEY = "betterchzzk:live-start-channels";
    const MULTIVIEW_DELAY_PREFIX = "betterChzzkMultiviewDelay:";
    const MULTIVIEW_QUALITY_PREFIX = "betterChzzkMultiviewQuality:";
    // Channels with a saved multiview delay, and separately with a saved quality. Storage keeps one key per
    // channel without a cap, so the bound comes from the file: both sections full with the longest valid values,
    // as written by the options page (2-space indent), take about 0.8 MiB and leave room within MAX_FILE_BYTES.
    // Export and import share it; export leaves out a larger section and reports it in `omitted`.
    const MAX_MULTIVIEW_CHANNELS = 4000;
    const MULTIVIEW_CHANNEL = /^[a-f0-9]{32}$/;
    const LIVE_START_CHANNEL = /^[a-f0-9]{32}$/;
    // Same identity rule as BetterChzzk.utils.normalizeChzzkChannelId used by the pin feature.
    const PIN_CHANNEL = /^[A-Za-z0-9_-]{1,100}$/;
    // Options a chzzk page can change through its own controls; everything else is written by options pages.
    const CONTENT_SYNC_OPTION_KEYS = Object.freeze(["skipSeconds", "ambientIntensity", "followingPreviewSoundEnabled"]);
    // Turning these on can produce actions that cannot be undone (notifications, tabs, claims, reloads, records).
    const EFFECT_OPTION_KEYS = Object.freeze([
        "liveStartNotificationsEnabled",
        "liveStartAutoOpenEnabled",
        "rewardAutoCollectEnabled",
        "offlineLiveReloadEnabled",
        "liveWatchHistoryEnabled",
        "liveWatchHistoryChatEnabled",
        "liveWatchHistoryDonationEnabled",
    ]);
    const PERMISSION_OPTION_KEYS = Object.freeze({
        notifications: Object.freeze(["liveStartNotificationsEnabled"]),
        previewHosts: Object.freeze(["followingPreviewTooltipEnabled", "liveMultiviewEnabled"]),
    });
    const SYNC_SECTIONS = Object.freeze(["options", "pinnedChannelIds", "followingFolders"]);
    const LOCAL_SECTIONS = Object.freeze([
        "panelSizes",
        "liveStartChannels",
        "multiviewDelays",
        "multiviewQualities",
        "chatMultiview",
    ]);

    const ok = (value) => ({ ok: true, value });
    const fail = (error) => ({ ok: false, error });
    const settings = () => globalThis.BetterChzzkSettings;

    // Values can come from another realm (structured clone, page tests), so avoid instanceof checks.
    function isPlainObject(value) {
        if (!value || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]")
            return false;
        const proto = Object.getPrototypeOf(value);
        return proto === null || Object.getPrototypeOf(proto) === null;
    }
    function hasOnly(value, allowed) {
        return Object.keys(value).every((key) => allowed.includes(key));
    }
    function stableStringify(value) {
        if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
        if (value && typeof value === "object") {
            return `{${Object.keys(value)
                .sort()
                .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
                .join(",")}}`;
        }
        return value === undefined ? "undefined" : JSON.stringify(value);
    }
    function sameValue(left, right) {
        return stableStringify(left) === stableStringify(right);
    }
    function clone(value) {
        return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    }

    function validateOptionValue(key, value) {
        const schema = settings();
        if (!schema?.OPTION_KEYS.includes(key)) return fail("unknown-option");
        if (schema.OPTION_SPEC[key].kind === "shortcutCode")
            return schema.isPlaybackSpeedShortcutCode(value) ? ok(value) : fail("invalid-option");
        return Object.is(schema.normalizeOptions({ [key]: value })[key], value) ? ok(value) : fail("invalid-option");
    }
    function validatePins(value) {
        if (!Array.isArray(value) || value.length > MAX_PINS) return fail("invalid-pins");
        const seen = new Set();
        for (const id of value) {
            if (typeof id !== "string" || !PIN_CHANNEL.test(id) || seen.has(id)) return fail("invalid-pins");
            seen.add(id);
        }
        return ok([...value]);
    }
    function validateFolders(value) {
        const model = globalThis.BetterChzzkFollowingFolders;
        if (typeof model?.parseState !== "function") return fail("unsupported-folders");
        const result = model.parseState(value);
        return result?.ok ? ok(result.state) : fail("invalid-folders");
    }
    function validateChatMultiview(value) {
        const model = globalThis.BetterChzzkChatMultiview;
        if (typeof model?.parseConfig !== "function") return fail("unsupported-chat-multiview");
        const result = model.parseConfig(value);
        return result?.ok ? ok(result.config) : fail("invalid-chat-multiview");
    }
    function validatePanelSize(value) {
        return value === null || (Number.isInteger(value) && value >= 1 && value <= 8192)
            ? ok(value)
            : fail("invalid-panel-size");
    }
    function validDelaySeconds(value) {
        return (
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= 0 &&
            Number.isSafeInteger(Math.round(value * 10))
        );
    }
    function validateMultiviewDelay(value) {
        if (!isPlainObject(value) || !validDelaySeconds(value.delaySeconds)) return fail("invalid-multiview-delay");
        if (value.version === 1 && hasOnly(value, ["version", "delaySeconds"]))
            return ok({ version: 1, delaySeconds: value.delaySeconds });
        if (
            value.version === 2 &&
            value.basis === "live-edge-clock" &&
            hasOnly(value, ["version", "basis", "delaySeconds"])
        )
            return ok({ version: 2, basis: "live-edge-clock", delaySeconds: value.delaySeconds });
        return fail("invalid-multiview-delay");
    }
    function validateMultiviewQuality(value) {
        return Number.isInteger(value) && value >= 0 && value <= 8640 ? ok(value) : fail("invalid-multiview-quality");
    }
    function validateLiveStartChannels(value) {
        const max = globalThis.BetterChzzkLiveStart?.MAX_CHANNELS ?? 32;
        if (!Array.isArray(value) || value.length > max) return fail("invalid-live-start-channels");
        const normalizeImage = globalThis.BetterChzzk?.utils?.normalizeChzzkImageUrl;
        const seen = new Set();
        const channels = [];
        for (const item of value) {
            if (
                !isPlainObject(item) ||
                !hasOnly(item, ["channelId", "channelName", "channelImageUrl", "notify", "autoOpen"]) ||
                typeof item.channelId !== "string" ||
                !LIVE_START_CHANNEL.test(item.channelId) ||
                seen.has(item.channelId) ||
                typeof item.channelName !== "string" ||
                item.channelName !== item.channelName.trim() ||
                item.channelName.length > 100 ||
                typeof item.notify !== "boolean" ||
                typeof item.autoOpen !== "boolean"
            )
                return fail("invalid-live-start-channels");
            const channel = {
                channelId: item.channelId,
                channelName: item.channelName,
                notify: item.notify,
                autoOpen: item.autoOpen,
            };
            if (Object.hasOwn(item, "channelImageUrl")) {
                if (
                    typeof item.channelImageUrl !== "string" ||
                    typeof normalizeImage !== "function" ||
                    normalizeImage(item.channelImageUrl) !== item.channelImageUrl
                )
                    return fail("invalid-live-start-channels");
                channel.channelImageUrl = item.channelImageUrl;
            }
            seen.add(item.channelId);
            channels.push(channel);
        }
        return ok(channels);
    }
    function multiviewChannel(key, prefix) {
        if (typeof key !== "string" || !key.startsWith(prefix)) return null;
        const id = key.slice(prefix.length);
        return MULTIVIEW_CHANNEL.test(id) ? id : null;
    }

    /** Checks one write request from a chzzk page. Options pages and the worker use their own paths. */
    function validateStoreEntry(area, key, value) {
        if (area === "sync") {
            if (key === PINS_KEY) return validatePins(value);
            if (key === FOLDERS_KEY) return validateFolders(value);
            if (CONTENT_SYNC_OPTION_KEYS.includes(key)) return validateOptionValue(key, value);
        } else if (area === "local") {
            if (Object.values(PANEL_KEYS).includes(key)) return validatePanelSize(value);
            if (key === CHAT_MULTIVIEW_KEY) return validateChatMultiview(value);
            if (multiviewChannel(key, MULTIVIEW_DELAY_PREFIX)) return validateMultiviewDelay(value);
            if (multiviewChannel(key, MULTIVIEW_QUALITY_PREFIX)) return validateMultiviewQuality(value);
        }
        return fail("key-not-allowed");
    }

    /** Maps an "area:key" id from a restore result to the file section the user sees. */
    function sectionOf(id) {
        const [area, ...rest] = String(id).split(":");
        const key = rest.join(":");
        if (area === "sync") {
            if (key === PINS_KEY) return "pinnedChannelIds";
            if (key === FOLDERS_KEY) return "followingFolders";
            return "options";
        }
        if (Object.values(PANEL_KEYS).includes(key)) return "panelSizes";
        if (key === LIVE_START_CHANNELS_KEY) return "liveStartChannels";
        if (key === CHAT_MULTIVIEW_KEY) return "chatMultiview";
        return "multiview";
    }

    /** True when a chzzk page may write or expect this key through the settings store. */
    function isStoreKey(area, key) {
        if (area === "sync") return key === PINS_KEY || key === FOLDERS_KEY || CONTENT_SYNC_OPTION_KEYS.includes(key);
        if (area === "local")
            return (
                Object.values(PANEL_KEYS).includes(key) ||
                key === CHAT_MULTIVIEW_KEY ||
                Boolean(
                    multiviewChannel(key, MULTIVIEW_DELAY_PREFIX) || multiviewChannel(key, MULTIVIEW_QUALITY_PREFIX)
                )
            );
        return false;
    }

    function readValid(validator, value) {
        const result = validator(value);
        return result.ok ? result.value : undefined;
    }

    /** Builds a file from raw sync/local snapshots. Invalid stored sections are left out and reported. */
    function createBackup({ syncData = {}, localData = {}, extensionVersion = "", now = Date.now() } = {}) {
        const schema = settings();
        const omitted = [];
        const sync = { options: schema.normalizeOptions(syncData) };
        sync.pinnedChannelIds = Object.hasOwn(syncData, PINS_KEY) ? readValid(validatePins, syncData[PINS_KEY]) : [];
        if (!sync.pinnedChannelIds) {
            delete sync.pinnedChannelIds;
            omitted.push("pinnedChannelIds");
        }
        const folders = globalThis.BetterChzzkFollowingFolders;
        if (typeof folders?.parseState === "function") {
            const state = Object.hasOwn(syncData, FOLDERS_KEY)
                ? readValid(validateFolders, syncData[FOLDERS_KEY])
                : clone(folders.EMPTY_STATE);
            if (state) sync.followingFolders = state;
            else omitted.push("followingFolders");
        }
        const local = { panelSizes: {} };
        for (const [name, key] of Object.entries(PANEL_KEYS)) {
            local.panelSizes[name] = readValid(validatePanelSize, localData[key] ?? null) ?? null;
        }
        if (Object.hasOwn(localData, LIVE_START_CHANNELS_KEY)) {
            const normalize = globalThis.BetterChzzkLiveStart?.normalizeChannels;
            const channels =
                typeof normalize === "function"
                    ? readValid(validateLiveStartChannels, normalize(localData[LIVE_START_CHANNELS_KEY]))
                    : undefined;
            if (channels) local.liveStartChannels = channels;
            else omitted.push("liveStartChannels");
        } else local.liveStartChannels = [];
        local.multiviewDelays = {};
        local.multiviewQualities = {};
        for (const key of Object.keys(localData).sort()) {
            const delayId = multiviewChannel(key, MULTIVIEW_DELAY_PREFIX);
            const qualityId = multiviewChannel(key, MULTIVIEW_QUALITY_PREFIX);
            if (delayId) {
                const value = readValid(validateMultiviewDelay, localData[key]);
                if (value) local.multiviewDelays[delayId] = value;
            } else if (qualityId) {
                const value = readValid(validateMultiviewQuality, localData[key]);
                if (value !== undefined) local.multiviewQualities[qualityId] = value;
            }
        }
        for (const name of ["multiviewDelays", "multiviewQualities"]) {
            // A section the file check would reject is left out whole and reported, never cut short.
            if (Object.keys(local[name]).length <= MAX_MULTIVIEW_CHANNELS) continue;
            delete local[name];
            omitted.push(name);
        }
        const chat = globalThis.BetterChzzkChatMultiview;
        if (typeof chat?.normalizeConfig === "function") {
            const config = Object.hasOwn(localData, CHAT_MULTIVIEW_KEY)
                ? readValid(validateChatMultiview, localData[CHAT_MULTIVIEW_KEY])
                : readValid(validateChatMultiview, chat.normalizeConfig(undefined));
            if (config) local.chatMultiview = config;
            else omitted.push("chatMultiview");
        }
        return {
            backup: {
                kind: FILE_KIND,
                formatVersion: FORMAT_VERSION,
                extensionVersion: String(extensionVersion || "").slice(0, 32),
                createdAt: Math.max(1, Math.floor(now)),
                sync,
                local,
            },
            omitted,
        };
    }

    function byteLength(text) {
        if (typeof TextEncoder === "function") return new TextEncoder().encode(text).length;
        return unescape(encodeURIComponent(text)).length;
    }

    /** Strictly validates a parsed or textual file. Unknown option keys are reported, never written. */
    function parseBackup(input) {
        let value = input;
        if (typeof input === "string") {
            if (byteLength(input) > MAX_FILE_BYTES) return fail("too-large");
            try {
                value = JSON.parse(input);
            } catch {
                return fail("invalid-json");
            }
        } else {
            let text;
            try {
                text = JSON.stringify(input);
            } catch {
                return fail("invalid-file");
            }
            if (typeof text !== "string" || byteLength(text) > MAX_FILE_BYTES) return fail("too-large");
        }
        if (!isPlainObject(value) || value.kind !== FILE_KIND) return fail("invalid-kind");
        if (value.formatVersion !== FORMAT_VERSION) return fail("unsupported-version");
        if (!hasOnly(value, ["kind", "formatVersion", "extensionVersion", "createdAt", "sync", "local"]))
            return fail("invalid-file");
        if (
            typeof value.extensionVersion !== "string" ||
            value.extensionVersion.length > 32 ||
            !Number.isSafeInteger(value.createdAt) ||
            value.createdAt <= 0 ||
            !isPlainObject(value.sync) ||
            !isPlainObject(value.local) ||
            !hasOnly(value.sync, SYNC_SECTIONS) ||
            !hasOnly(value.local, LOCAL_SECTIONS)
        )
            return fail("invalid-file");
        const backup = {
            kind: FILE_KIND,
            formatVersion: FORMAT_VERSION,
            extensionVersion: value.extensionVersion,
            createdAt: value.createdAt,
            sync: {},
            local: {},
        };
        const ignoredOptionKeys = [];
        const schema = settings();
        if (Object.hasOwn(value.sync, "options")) {
            const options = value.sync.options;
            if (!isPlainObject(options) || Object.keys(options).length > 1000) return fail("invalid-options");
            backup.sync.options = {};
            for (const [key, option] of Object.entries(options)) {
                if (!schema.OPTION_KEYS.includes(key)) {
                    ignoredOptionKeys.push(key.slice(0, 80));
                    continue;
                }
                const result = validateOptionValue(key, option);
                if (!result.ok) return fail("invalid-options");
                backup.sync.options[key] = result.value;
            }
        }
        const sections = [
            ["sync", "pinnedChannelIds", validatePins],
            ["sync", "followingFolders", validateFolders],
            ["local", "liveStartChannels", validateLiveStartChannels],
            ["local", "chatMultiview", validateChatMultiview],
        ];
        for (const [area, name, validator] of sections) {
            if (!Object.hasOwn(value[area], name)) continue;
            const result = validator(value[area][name]);
            if (!result.ok) return fail(result.error);
            backup[area][name] = result.value;
        }
        if (Object.hasOwn(value.local, "panelSizes")) {
            const sizes = value.local.panelSizes;
            if (!isPlainObject(sizes) || !hasOnly(sizes, Object.keys(PANEL_KEYS))) return fail("invalid-panel-size");
            backup.local.panelSizes = {};
            for (const [name, size] of Object.entries(sizes)) {
                const result = validatePanelSize(size);
                if (!result.ok) return fail(result.error);
                backup.local.panelSizes[name] = result.value;
            }
        }
        for (const [name, validator] of [
            ["multiviewDelays", validateMultiviewDelay],
            ["multiviewQualities", validateMultiviewQuality],
        ]) {
            if (!Object.hasOwn(value.local, name)) continue;
            const entries = value.local[name];
            if (!isPlainObject(entries) || Object.keys(entries).length > MAX_MULTIVIEW_CHANNELS)
                return fail(`invalid-${name}`);
            backup.local[name] = {};
            for (const [id, entry] of Object.entries(entries)) {
                const result = MULTIVIEW_CHANNEL.test(id) ? validator(entry) : fail(`invalid-${name}`);
                if (!result.ok) return fail(result.error);
                backup.local[name][id] = result.value;
            }
        }
        return { ok: true, backup, ignoredOptionKeys };
    }

    /** Lists every storage key the file would touch, so reads and the fingerprint cover exactly them. */
    function targetKeys(backup) {
        const sync = [];
        const local = [];
        if (backup.sync.options) sync.push(...settings().OPTION_KEYS);
        if (backup.sync.pinnedChannelIds) sync.push(PINS_KEY);
        if (backup.sync.followingFolders) sync.push(FOLDERS_KEY);
        if (backup.local.panelSizes) {
            for (const name of Object.keys(backup.local.panelSizes)) local.push(PANEL_KEYS[name]);
        }
        if (backup.local.liveStartChannels) local.push(LIVE_START_CHANNELS_KEY);
        for (const id of Object.keys(backup.local.multiviewDelays || {})) local.push(MULTIVIEW_DELAY_PREFIX + id);
        for (const id of Object.keys(backup.local.multiviewQualities || {})) local.push(MULTIVIEW_QUALITY_PREFIX + id);
        if (backup.local.chatMultiview) local.push(CHAT_MULTIVIEW_KEY);
        return { sync, local };
    }

    function fingerprint(current, backup) {
        const keys = targetKeys(backup);
        const rows = [];
        for (const area of ["sync", "local"]) {
            for (const key of [...keys[area]].sort()) {
                const data = current[area] || {};
                rows.push([area, key, Object.hasOwn(data, key), Object.hasOwn(data, key) ? data[key] : null]);
            }
        }
        const text = stableStringify(rows);
        // FNV-1a keeps the token short; a collision only skips one re-confirmation of an identical-looking state.
        let hash = 0x811c9dc5;
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193) >>> 0;
        }
        return `${text.length.toString(36)}-${hash.toString(36)}`;
    }

    /**
     * Compares the file with the current snapshot. Stages are written in order: effects the file turns off,
     * other sync values, local layout values, live-start targets, then effects the file turns on.
     */
    function planImport(current, backup, { disabledOptionKeys = [] } = {}) {
        const schema = settings();
        const syncData = current.sync || {};
        const localData = current.local || {};
        const currentOptions = schema.normalizeOptions(syncData);
        const stages = {
            "effects-off": {},
            sync: {},
            local: {},
            "live-start": {},
            "effects-on": {},
        };
        const summary = {
            options: { changed: 0, total: 0 },
            pinnedChannelIds: null,
            followingFolders: null,
            panelSizes: null,
            liveStartChannels: null,
            multiview: null,
            chatMultiview: null,
            permissions: { notifications: false, previewHosts: false },
            // Permission options this file turns on, and those it would turn on but the caller keeps off.
            permissionOptionKeys: [],
            keptOffOptionKeys: [],
        };
        if (backup.sync.options) {
            const desired = { ...currentOptions, ...backup.sync.options };
            // Only a feature the file itself turns on can need a permission or be kept off; features the file
            // leaves alone or already finds on keep their current value.
            const turnsOn = (key) => backup.sync.options[key] === true && currentOptions[key] !== true;
            for (const key of new Set(disabledOptionKeys)) {
                if (!schema.OPTION_KEYS.includes(key) || !turnsOn(key)) continue;
                desired[key] = currentOptions[key];
                summary.keptOffOptionKeys.push(key);
            }
            const normalized = schema.normalizeOptions(desired);
            for (const key of Object.keys(backup.sync.options)) {
                if (!Object.is(normalized[key], desired[key])) return fail("option-combination");
            }
            for (const key of schema.OPTION_KEYS) {
                if (!Object.hasOwn(backup.sync.options, key)) continue;
                summary.options.total += 1;
                const value = desired[key];
                const stored = Object.hasOwn(syncData, key);
                if (Object.is(currentOptions[key], value) && stored) continue;
                if (Object.is(currentOptions[key], value) && !stored) {
                    // Writing the default explicitly is harmless and keeps the file's choice durable.
                    stages.sync[key] = value;
                    continue;
                }
                summary.options.changed += 1;
                if (EFFECT_OPTION_KEYS.includes(key)) stages[value ? "effects-on" : "effects-off"][key] = value;
                else stages.sync[key] = value;
            }
            // Keys the file leaves out keep their stored values, so a partial file is checked as the stored state
            // after these writes: the speed shortcut trio falls back to its defaults as a whole on a duplicate,
            // which would change keys the file never named while the preview reports only the file's keys.
            const written = { ...stages["effects-off"], ...stages.sync, ...stages["effects-on"] };
            const effective = schema.normalizeOptions({ ...syncData, ...written });
            for (const key of schema.OPTION_KEYS) {
                if (!Object.is(effective[key], desired[key])) return fail("option-combination");
            }
            for (const [permission, keys] of Object.entries(PERMISSION_OPTION_KEYS)) {
                const enabled = keys.filter((key) => turnsOn(key) && desired[key] === true);
                summary.permissionOptionKeys.push(...enabled);
                summary.permissions[permission] = enabled.length > 0;
            }
        }
        const compare = (area, key, value, stage, name, count) => {
            const data = area === "sync" ? syncData : localData;
            const changed = !Object.hasOwn(data, key) || !sameValue(data[key], value);
            if (changed) stages[stage][key] = clone(value);
            summary[name] = { changed: changed || Boolean(summary[name]?.changed), count };
        };
        if (backup.sync.pinnedChannelIds)
            compare(
                "sync",
                PINS_KEY,
                backup.sync.pinnedChannelIds,
                "sync",
                "pinnedChannelIds",
                backup.sync.pinnedChannelIds.length
            );
        if (backup.sync.followingFolders)
            compare(
                "sync",
                FOLDERS_KEY,
                backup.sync.followingFolders,
                "sync",
                "followingFolders",
                backup.sync.followingFolders.folders?.length || 0
            );
        if (backup.local.panelSizes) {
            summary.panelSizes = { changed: false, count: Object.keys(backup.local.panelSizes).length };
            for (const [name, size] of Object.entries(backup.local.panelSizes)) {
                const key = PANEL_KEYS[name];
                const stored = Object.hasOwn(localData, key) ? localData[key] : null;
                if (!sameValue(stored, size) || (!Object.hasOwn(localData, key) && size !== null)) {
                    stages.local[key] = size;
                    summary.panelSizes.changed = true;
                }
            }
        }
        if (backup.local.liveStartChannels)
            compare(
                "local",
                LIVE_START_CHANNELS_KEY,
                backup.local.liveStartChannels,
                "live-start",
                "liveStartChannels",
                backup.local.liveStartChannels.length
            );
        const delays = Object.entries(backup.local.multiviewDelays || {});
        const qualities = Object.entries(backup.local.multiviewQualities || {});
        if (backup.local.multiviewDelays || backup.local.multiviewQualities) {
            summary.multiview = { changed: false, count: new Set([...delays, ...qualities].map(([id]) => id)).size };
            for (const [id, value] of delays) {
                const key = MULTIVIEW_DELAY_PREFIX + id;
                if (!Object.hasOwn(localData, key) || !sameValue(localData[key], value)) {
                    stages.local[key] = clone(value);
                    summary.multiview.changed = true;
                }
            }
            for (const [id, value] of qualities) {
                const key = MULTIVIEW_QUALITY_PREFIX + id;
                if (!Object.hasOwn(localData, key) || !sameValue(localData[key], value)) {
                    stages.local[key] = value;
                    summary.multiview.changed = true;
                }
            }
        }
        if (backup.local.chatMultiview)
            compare(
                "local",
                CHAT_MULTIVIEW_KEY,
                backup.local.chatMultiview,
                "local",
                "chatMultiview",
                backup.local.chatMultiview.channels?.length || 0
            );
        const order = [
            ["effects-off", "sync"],
            ["sync", "sync"],
            ["local", "local"],
            ["live-start", "local"],
            ["effects-on", "sync"],
        ];
        const plannedStages = order
            .filter(([name]) => Object.keys(stages[name]).length)
            .map(([name, area]) => ({ name, area, values: stages[name] }));
        return { ok: true, stages: plannedStages, summary };
    }

    globalThis.BetterChzzkSettingsBackup = Object.freeze({
        FILE_KIND,
        FORMAT_VERSION,
        MAX_FILE_BYTES,
        STORE_MESSAGE_TYPE,
        BACKUP_MESSAGE_TYPE,
        PINS_KEY,
        FOLDERS_KEY,
        CHAT_MULTIVIEW_KEY,
        PANEL_KEYS,
        LIVE_START_CHANNELS_KEY,
        MULTIVIEW_DELAY_PREFIX,
        MULTIVIEW_QUALITY_PREFIX,
        MAX_MULTIVIEW_CHANNELS,
        CONTENT_SYNC_OPTION_KEYS,
        EFFECT_OPTION_KEYS,
        PERMISSION_OPTION_KEYS,
        isPlainObject,
        isStoreKey,
        sectionOf,
        validateStoreEntry,
        createBackup,
        parseBackup,
        targetKeys,
        fingerprint,
        planImport,
        sameValue,
    });
})();
