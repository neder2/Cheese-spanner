/**
 * shared/followingFolders.js — 팔로잉 폴더 저장값의 엄격 검증과 개별 변경 명령을 계산한다.
 *
 * 동작 위치: DOM·chrome 비의존 IIFE. isolated 콘텐츠, 옵션 페이지, 서비스 워커에서 각각 로드할 수 있다.
 * 하는 일: chrome.storage.sync `betterchzzk:following-folders:v1` 값의 정확한 형식·상한·sync 항목 크기를
 *   검증하고, 만들기(채널과 함께 만들기 포함)·이름 변경·삭제·순서 이동(한 칸·지정 위치)·채널 지정/해제·
 *   접기·되돌리기·손상 초기화 명령을 최신 저장 원본값에 적용한 다음 값을 계산한다. 실제 저장은 콘텐츠가 settingsStoreSet의 기대값 비교와 함께 요청하며,
 *   이 모듈은 그 기대값 형식({value}/{absent:true})의 변환만 제공한다.
 * 노출: globalThis.CheeseSpannerFollowingFolders.
 */
(() => {
    "use strict";

    const STORAGE_KEY = "betterchzzk:following-folders:v1";
    const VERSION = 1;
    const MAX_FOLDERS = 10;
    const MAX_NAME_LENGTH = 20;
    const MAX_ASSIGNMENTS = 150;
    // chrome.storage.sync.QUOTA_BYTES_PER_ITEM(8,192, 키 길이 포함)보다 여유를 둔 상한이다.
    const MAX_STATE_BYTES = 8000;
    const MAX_RAW_NAME_LENGTH = 200;
    const FOLDER_ID_PATTERN = /^[a-z0-9-]{1,24}$/;
    const CHANNEL_ID_PATTERN = /^[0-9a-f]{32}$/;
    const STATE_FIELDS = ["version", "folders"];
    const FOLDER_FIELDS = ["id", "name", "channelIds", "collapsed"];
    const COMMAND_FIELDS = {
        create: ["type", "folderId", "name"],
        createWith: ["type", "folderId", "name", "channelId"],
        rename: ["type", "folderId", "name"],
        delete: ["type", "folderId"],
        move: ["type", "folderId", "offset"],
        moveTo: ["type", "folderId", "index"],
        assign: ["type", "folderId", "channelId"],
        unassign: ["type", "folderId", "channelId"],
        setCollapsed: ["type", "folderId", "collapsed"],
        resetCorrupt: ["type"],
        restore: ["type", "state"],
    };

    function deepFreeze(value) {
        if (value && typeof value === "object") {
            for (const child of Object.values(value)) deepFreeze(child);
            Object.freeze(value);
        }
        return value;
    }

    const EMPTY_STATE = deepFreeze({ version: VERSION, folders: [] });

    function isRecord(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function hasExactFields(value, fields) {
        if (!isRecord(value)) return false;
        const keys = Object.keys(value);
        return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
    }

    function isWellFormedText(value) {
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff) {
                const next = value.charCodeAt(index + 1);
                if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
                index += 1;
            } else if (code >= 0xdc00 && code <= 0xdfff) {
                return false;
            }
        }
        return true;
    }

    // 제어 문자와 줄 구분 문자는 머리 행·패널에서 보이지 않거나 줄을 바꾸므로 이름에 허용하지 않는다.
    function hasForbiddenCharacter(value) {
        for (const character of value) {
            const code = character.codePointAt(0);
            if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) return true;
        }
        return false;
    }

    function codePointLength(value) {
        let length = 0;
        for (let index = 0; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (code >= 0xd800 && code <= 0xdbff) index += 1;
            length += 1;
        }
        return length;
    }

    function utf8ByteLength(value) {
        let bytes = 0;
        for (const character of String(value)) {
            const code = character.codePointAt(0);
            bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
        }
        return bytes;
    }

    function isValidStoredName(value) {
        return (
            typeof value === "string" &&
            value === value.trim() &&
            isWellFormedText(value) &&
            !hasForbiddenCharacter(value) &&
            codePointLength(value) >= 1 &&
            codePointLength(value) <= MAX_NAME_LENGTH
        );
    }

    /** 사용자 입력 이름을 NFC·연속 공백 1칸·앞뒤 공백 제거로 정리한다. 규칙을 벗어나면 빈 문자열이다. */
    function normalizeFolderName(value) {
        if (typeof value !== "string" || value.length > MAX_RAW_NAME_LENGTH || !isWellFormedText(value)) return "";
        const name = value.normalize("NFC").replace(/\s+/g, " ").trim();
        return isValidStoredName(name) ? name : "";
    }

    function folderNameKey(name) {
        return String(name).normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
    }

    function isValidFolderId(value) {
        return typeof value === "string" && FOLDER_ID_PATTERN.test(value);
    }

    function isValidChannelId(value) {
        return typeof value === "string" && CHANNEL_ID_PATTERN.test(value);
    }

    function cloneState(state) {
        return {
            version: VERSION,
            folders: state.folders.map((folder) => ({
                id: folder.id,
                name: folder.name,
                channelIds: folder.channelIds.slice(),
                collapsed: folder.collapsed,
            })),
        };
    }

    function serializeState(state) {
        return JSON.stringify(cloneState(state));
    }

    /** chrome.storage.sync 한 항목 한도 계산과 같은 방식(키 + 값의 JSON)으로 UTF-8 바이트를 센다. */
    function getStateBytes(state) {
        return utf8ByteLength(STORAGE_KEY) + utf8ByteLength(serializeState(state));
    }

    function countAssignments(state) {
        return state.folders.reduce((total, folder) => total + folder.channelIds.length, 0);
    }

    function failure(error) {
        return { ok: false, error };
    }

    /**
     * 저장 형식 `{version:1,folders:[{id,name,channelIds,collapsed}]}`을 엄격하게 검증한다.
     * 잘못된 값을 잘라 성공으로 만들지 않고, 성공하면 입력과 분리된 새 객체를 돌려준다.
     */
    function parseState(value) {
        if (!hasExactFields(value, STATE_FIELDS)) return failure("invalid-shape");
        if (value.version !== VERSION) return failure("unsupported-version");
        if (!Array.isArray(value.folders)) return failure("invalid-shape");
        if (value.folders.length > MAX_FOLDERS) return failure("too-many-folders");
        const folderIds = new Set();
        const channelIds = new Set();
        const folders = [];
        for (let index = 0; index < value.folders.length; index += 1) {
            const folder = value.folders[index];
            if (!hasExactFields(folder, FOLDER_FIELDS)) return failure("invalid-folder");
            if (!isValidFolderId(folder.id)) return failure("invalid-folder-id");
            if (folderIds.has(folder.id)) return failure("duplicate-folder-id");
            if (!isValidStoredName(folder.name)) return failure("invalid-name");
            if (typeof folder.collapsed !== "boolean") return failure("invalid-folder");
            if (!Array.isArray(folder.channelIds)) return failure("invalid-folder");
            const ids = [];
            for (let channelIndex = 0; channelIndex < folder.channelIds.length; channelIndex += 1) {
                const channelId = folder.channelIds[channelIndex];
                if (!isValidChannelId(channelId)) return failure("invalid-channel-id");
                if (channelIds.has(channelId)) return failure("duplicate-channel");
                channelIds.add(channelId);
                ids.push(channelId);
                if (channelIds.size > MAX_ASSIGNMENTS) return failure("too-many-assignments");
            }
            folderIds.add(folder.id);
            folders.push({ id: folder.id, name: folder.name, channelIds: ids, collapsed: folder.collapsed });
        }
        const state = { version: VERSION, folders };
        if (getStateBytes(state) > MAX_STATE_BYTES) return failure("too-large");
        return { ok: true, state };
    }

    /** 저장소에서 읽은 값을 해석한다. 키가 없으면(undefined) 빈 상태이고, 그 밖의 값은 parseState와 같다. */
    function parseStoredValue(value) {
        if (value === undefined) return { ok: true, state: cloneState(EMPTY_STATE) };
        return parseState(value);
    }

    function statesEqual(left, right) {
        return serializeState(left) === serializeState(right);
    }

    function findFolderIdOfChannel(state, channelId) {
        return state.folders.find((folder) => folder.channelIds.includes(channelId))?.id || "";
    }

    function parseCommand(value) {
        const type = isRecord(value) ? value.type : "";
        const fields = typeof type === "string" && Object.hasOwn(COMMAND_FIELDS, type) ? COMMAND_FIELDS[type] : null;
        if (!fields || !hasExactFields(value, fields)) return failure("invalid-command");
        if (type === "resetCorrupt") return { ok: true, command: { type } };
        if (type === "restore") {
            // 되돌리기는 사용자가 방금 본 이전 상태 전체예요. 저장 형식 검증을 그대로 통과해야 해요.
            const parsed = parseState(value.state);
            return parsed.ok ? { ok: true, command: { type, state: parsed.state } } : parsed;
        }
        if (!isValidFolderId(value.folderId)) return failure("invalid-command");
        const command = { type, folderId: value.folderId };
        if (type === "create" || type === "rename" || type === "createWith") {
            const name = normalizeFolderName(value.name);
            if (!name) return failure("invalid-name");
            command.name = name;
            if (type === "createWith") {
                if (!isValidChannelId(value.channelId)) return failure("invalid-channel-id");
                command.channelId = value.channelId;
            }
        } else if (type === "move") {
            if (value.offset !== -1 && value.offset !== 1) return failure("invalid-command");
            command.offset = value.offset;
        } else if (type === "moveTo") {
            if (!Number.isInteger(value.index) || value.index < 0 || value.index >= MAX_FOLDERS)
                return failure("invalid-command");
            command.index = value.index;
        } else if (type === "assign" || type === "unassign") {
            if (!isValidChannelId(value.channelId)) return failure("invalid-channel-id");
            command.channelId = value.channelId;
        } else if (type === "setCollapsed") {
            if (typeof value.collapsed !== "boolean") return failure("invalid-command");
            command.collapsed = value.collapsed;
        }
        return { ok: true, command };
    }

    function hasDuplicateName(state, name, exceptFolderId = "") {
        const key = folderNameKey(name);
        return state.folders.some((folder) => folder.id !== exceptFolderId && folderNameKey(folder.name) === key);
    }

    function applyParsedCommand(current, command) {
        const next = cloneState(current);
        const index = command.folderId ? next.folders.findIndex((folder) => folder.id === command.folderId) : -1;
        const folder = index >= 0 ? next.folders[index] : null;
        switch (command.type) {
            case "create":
            case "createWith": {
                if (folder) return failure("duplicate-folder-id");
                if (next.folders.length >= MAX_FOLDERS) return failure("folder-limit");
                if (hasDuplicateName(next, command.name)) return failure("duplicate-name");
                const created = { id: command.folderId, name: command.name, channelIds: [], collapsed: false };
                if (command.type === "createWith") {
                    // 한 채널은 한 폴더에만 속하므로 다른 폴더에 있던 채널은 새 폴더로 옮겨요.
                    const previous = next.folders.find((candidate) => candidate.channelIds.includes(command.channelId));
                    if (previous) previous.channelIds = previous.channelIds.filter((id) => id !== command.channelId);
                    else if (countAssignments(next) >= MAX_ASSIGNMENTS) return failure("assignment-limit");
                    created.channelIds.push(command.channelId);
                }
                next.folders.push(created);
                return { ok: true, state: next };
            }
            case "rename":
                if (!folder) return failure("folder-not-found");
                if (hasDuplicateName(next, command.name, folder.id)) return failure("duplicate-name");
                folder.name = command.name;
                return { ok: true, state: next };
            case "delete":
                // 이미 없는 폴더는 삭제 의도가 충족된 상태다.
                if (folder) next.folders.splice(index, 1);
                return { ok: true, state: next };
            case "move": {
                if (!folder) return failure("folder-not-found");
                const target = index + command.offset;
                if (target < 0 || target >= next.folders.length) return { ok: true, state: next };
                next.folders.splice(index, 1);
                next.folders.splice(target, 0, folder);
                return { ok: true, state: next };
            }
            case "moveTo": {
                if (!folder) return failure("folder-not-found");
                const target = Math.min(command.index, next.folders.length - 1);
                next.folders.splice(index, 1);
                next.folders.splice(target, 0, folder);
                return { ok: true, state: next };
            }
            case "restore":
                return { ok: true, state: cloneState(command.state) };
            case "assign": {
                if (!folder) return failure("folder-not-found");
                if (folder.channelIds.includes(command.channelId)) return { ok: true, state: next };
                const previous = next.folders.find((candidate) => candidate.channelIds.includes(command.channelId));
                if (previous) previous.channelIds = previous.channelIds.filter((id) => id !== command.channelId);
                else if (countAssignments(next) >= MAX_ASSIGNMENTS) return failure("assignment-limit");
                folder.channelIds.push(command.channelId);
                return { ok: true, state: next };
            }
            case "unassign":
                // 다른 폴더로 옮겨진 채널은 이 폴더에서 빼려던 의도가 이미 충족됐으므로 건드리지 않는다.
                if (folder) folder.channelIds = folder.channelIds.filter((id) => id !== command.channelId);
                return { ok: true, state: next };
            case "setCollapsed":
                if (!folder) return failure("folder-not-found");
                folder.collapsed = command.collapsed;
                return { ok: true, state: next };
            default:
                return failure("invalid-command");
        }
    }

    /**
     * 최신 저장 원본값(키가 없으면 undefined)에 명령 하나를 적용한다.
     * 결과: `{ok:true, changed, state}`(changed가 true면 state를 써야 함) 또는 `{ok:false, error, state}`.
     * 실패 결과의 state는 해석 가능한 현재 상태이고, 저장값이 손상됐으면 null이다.
     */
    function applyCommand(rawValue, commandValue) {
        const parsedCommand = parseCommand(commandValue);
        const current = parseStoredValue(rawValue);
        const currentState = current.ok ? current.state : null;
        if (!parsedCommand.ok) return { ...parsedCommand, state: currentState };
        const { command } = parsedCommand;
        if (command.type === "resetCorrupt") {
            if (current.ok) return { ok: false, error: "not-corrupt", state: currentState };
            return { ok: true, changed: true, state: cloneState(EMPTY_STATE) };
        }
        if (!current.ok) return { ok: false, error: "corrupt-state", state: null };
        const result = applyParsedCommand(currentState, command);
        if (!result.ok) return { ok: false, error: result.error, state: currentState };
        const checked = parseState(result.state);
        if (!checked.ok) return { ok: false, error: checked.error, state: currentState };
        return { ok: true, changed: !statesEqual(currentState, checked.state), state: checked.state };
    }

    /** settingsStoreSet의 기대값 형식으로 바꾼다. 키가 없던 원본(undefined)은 `{absent:true}`다. */
    function toExpected(rawValue) {
        return rawValue === undefined ? { absent: true } : { value: rawValue };
    }

    /** conflict 오류의 `error.current[STORAGE_KEY]`를 원본값으로 되돌린다. 형식이 다르면 ok:false다. */
    function fromExpected(entry) {
        if (hasExactFields(entry, ["absent"]) && entry.absent === true) return { ok: true, rawValue: undefined };
        if (hasExactFields(entry, ["value"]) && entry.value !== undefined) return { ok: true, rawValue: entry.value };
        return { ok: false };
    }

    function createFolderId(randomValues = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
        const bytes = new Uint8Array(6);
        if (typeof randomValues === "function") randomValues(bytes);
        else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
        const random = Array.from(bytes, (byte) => (byte % 36).toString(36)).join("");
        return `f${Date.now().toString(36)}-${random}`.slice(0, 24);
    }

    globalThis.CheeseSpannerFollowingFolders = Object.freeze({
        STORAGE_KEY,
        VERSION,
        MAX_FOLDERS,
        MAX_NAME_LENGTH,
        MAX_ASSIGNMENTS,
        MAX_STATE_BYTES,
        EMPTY_STATE,
        parseState,
        parseStoredValue,
        parseCommand,
        applyCommand,
        toExpected,
        fromExpected,
        normalizeFolderName,
        isValidFolderId,
        isValidChannelId,
        cloneState,
        statesEqual,
        getStateBytes,
        countAssignments,
        findFolderIdOfChannel,
        createFolderId,
    });
})();
