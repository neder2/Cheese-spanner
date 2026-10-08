(() => {
    "use strict";

    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const MESSAGE_TYPE = "betterchzzk:category-exclusions";
    const STORAGE_KEY = "betterchzzkCategoryExclusionsV1";
    const VERSION = 1;
    const MAX_CATEGORIES = 100;
    const CATEGORY_FIELDS = ["categoryType", "categoryId", "categoryValue"];
    // 스트리머가 직접 붙인 태그 단어는 기존 저장 형식에 예약 유형으로 보관한다. 치지직 카테고리 유형과 겹치지 않는 이름이다.
    const TAG_TYPE = "CHEESE_SPANNER_TAG";
    const MAX_TAG_LENGTH = 100;

    function isRecord(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function hasFields(value, fields) {
        return (
            isRecord(value) &&
            Object.keys(value).length === fields.length &&
            fields.every((field) => Object.hasOwn(value, field))
        );
    }

    function hasControlCharacter(value) {
        for (const character of value) {
            const code = character.charCodeAt(0);
            if (code < 32 || (code >= 127 && code <= 159)) return true;
        }
        return false;
    }

    function validText(value, maxLength) {
        return (
            typeof value === "string" &&
            value.length > 0 &&
            value.length <= maxLength &&
            value.trim().length > 0 &&
            !hasControlCharacter(value)
        );
    }

    function validIdentity(categoryType, categoryId) {
        return (
            validText(categoryType, 32) &&
            /^[A-Z][A-Z0-9_]*$/.test(categoryType) &&
            validText(categoryId, 200) &&
            categoryId !== "." &&
            categoryId !== ".."
        );
    }

    function normalizeCategory(value) {
        if (
            !isRecord(value) ||
            !CATEGORY_FIELDS.every((field) => Object.hasOwn(value, field)) ||
            !validIdentity(value.categoryType, value.categoryId) ||
            !validText(value.categoryValue, 200)
        )
            return null;
        return { categoryType: value.categoryType, categoryId: value.categoryId, categoryValue: value.categoryValue };
    }

    function tagText(value) {
        if (typeof value !== "string") return "";
        const text = value.normalize("NFC").trim().replace(/^#+/, "").replace(/\s+/g, " ").trim();
        return validText(text, MAX_TAG_LENGTH) ? text : "";
    }

    // 태그 비교는 대소문자와 연속 공백, 앞의 # 표시만 무시하는 정확한 일치다.
    function tagMatchKey(value) {
        return tagText(value).toLowerCase();
    }

    function createTagExclusion(value) {
        const text = tagText(value);
        const categoryId = text.toLowerCase();
        return text && validIdentity(TAG_TYPE, categoryId)
            ? { categoryType: TAG_TYPE, categoryId, categoryValue: text }
            : null;
    }

    function isTagExclusion(value) {
        return isRecord(value) && value.categoryType === TAG_TYPE;
    }

    function categoryKey(value, categoryId) {
        const categoryType = isRecord(value) ? value.categoryType : value;
        const id = isRecord(value) ? value.categoryId : categoryId;
        return validIdentity(categoryType, id) ? JSON.stringify([categoryType, id]) : "";
    }

    function createEmptyState() {
        return { version: VERSION, revision: 0, categories: [] };
    }

    function normalizeState(value) {
        if (
            !hasFields(value, ["version", "revision", "categories"]) ||
            value.version !== VERSION ||
            !Number.isSafeInteger(value.revision) ||
            value.revision < 0 ||
            !Array.isArray(value.categories) ||
            value.categories.length > MAX_CATEGORIES
        )
            return null;
        const categories = [];
        const seen = new Set();
        for (const source of value.categories) {
            if (!hasFields(source, CATEGORY_FIELDS)) return null;
            const category = normalizeCategory(source);
            if (!category) return null;
            const key = categoryKey(category);
            if (seen.has(key)) return null;
            seen.add(key);
            categories.push(category);
        }
        return { version: VERSION, revision: value.revision, categories };
    }

    function isTrustedSender(sender, runtime) {
        if (
            typeof runtime?.id !== "string" ||
            !runtime.id ||
            sender?.id !== runtime.id ||
            !Number.isSafeInteger(sender.tab?.id) ||
            sender.tab.id < 0 ||
            sender.frameId !== 0 ||
            typeof sender.url !== "string" ||
            hasControlCharacter(sender.url) ||
            !/^https:\/\/chzzk\.naver\.com\//.test(sender.url) ||
            (sender.origin !== undefined && sender.origin !== "https://chzzk.naver.com")
        )
            return false;
        // SPA navigation keeps the original document URL in sender.url. Chrome supplies
        // the current top-level URL in sender.tab; never accept a route from message data.
        const currentUrl = sender.tab.url;
        if (
            typeof currentUrl !== "string" ||
            hasControlCharacter(currentUrl) ||
            !/^https:\/\/chzzk\.naver\.com\/lives\/?(?:[?#][\s\S]*)?$/.test(currentUrl)
        )
            return false;
        try {
            return (
                new URL(sender.url).origin === "https://chzzk.naver.com" &&
                ["/lives", "/lives/"].includes(new URL(currentUrl).pathname)
            );
        } catch {
            return false;
        }
    }

    const failed = (error) => ({ ok: false, error });
    const succeeded = (state) => ({ ok: true, state });

    function normalizeRequest(message) {
        if (!isRecord(message) || message.type !== MESSAGE_TYPE) return failed("invalid-request");
        if (message.version !== VERSION) return failed("unsupported-version");
        if (!hasFields(message, ["type", "version", "operation"])) return failed("invalid-request");
        const operation = message.operation;
        if (operation?.kind === "get" && hasFields(operation, ["kind"])) return { operation: { kind: "get" } };
        if (operation?.kind === "add" && hasFields(operation, ["kind", "category"])) {
            const category = hasFields(operation.category, CATEGORY_FIELDS) && normalizeCategory(operation.category);
            if (category) return { operation: { kind: "add", category } };
        }
        if (
            operation?.kind === "remove" &&
            hasFields(operation, ["kind", "categoryType", "categoryId"]) &&
            validIdentity(operation.categoryType, operation.categoryId)
        )
            return {
                operation: { kind: "remove", categoryType: operation.categoryType, categoryId: operation.categoryId },
            };
        return failed("invalid-request");
    }

    function createController({ chrome } = {}) {
        let queue = Promise.resolve();

        function storageCall(kind, value) {
            const errorCode = kind === "get" ? "storage-read-failed" : "storage-write-failed";
            return new Promise((resolve) => {
                try {
                    chrome.storage.local[kind](value, (data) => {
                        const error = chrome.runtime.lastError;
                        resolve(error ? failed(errorCode) : { ok: true, data });
                    });
                } catch {
                    resolve(failed(errorCode));
                }
            });
        }

        async function applyOperation(operation) {
            if (typeof chrome.storage?.local?.get !== "function" || typeof chrome.storage.local.set !== "function")
                return failed("storage-unavailable");
            const read = await storageCall("get", STORAGE_KEY);
            if (!read.ok) return read;
            if (!isRecord(read.data)) return failed("storage-read-failed");
            // Only a genuinely absent key uses the default; corrupt or unreadable state is never repaired by a write.
            const state = Object.hasOwn(read.data, STORAGE_KEY)
                ? normalizeState(read.data[STORAGE_KEY])
                : createEmptyState();
            if (!state) return failed("invalid-stored-state");
            if (operation.kind === "get") return succeeded(state);

            const key = categoryKey(operation.kind === "add" ? operation.category : operation);
            const index = state.categories.findIndex((category) => categoryKey(category) === key);
            if (operation.kind === "add") {
                if (index >= 0) return succeeded(state);
                if (state.categories.length >= MAX_CATEGORIES) return failed("limit-reached");
            } else if (index < 0) return succeeded(state);
            if (state.revision === Number.MAX_SAFE_INTEGER) return failed("storage-write-failed");

            const next = {
                version: VERSION,
                revision: state.revision + 1,
                categories:
                    operation.kind === "add"
                        ? [...state.categories, operation.category]
                        : state.categories.filter((_, position) => position !== index),
            };
            const written = await storageCall("set", { [STORAGE_KEY]: next });
            return written.ok ? succeeded(next) : written;
        }

        function handleMessage(message, sender) {
            if (!isTrustedSender(sender, chrome?.runtime)) return Promise.resolve(failed("untrusted-sender"));
            const normalized = normalizeRequest(message);
            if (!normalized.operation) return Promise.resolve(normalized);
            // This durable key has its own queue and reads the latest local value for every received operation.
            const result = queue
                .then(() => applyOperation(normalized.operation))
                .catch(() => failed("storage-read-failed"));
            queue = result.then(() => undefined);
            return result;
        }

        return Object.freeze({ handleMessage });
    }

    root.categoryExclusions = Object.freeze({
        MESSAGE_TYPE,
        STORAGE_KEY,
        TAG_TYPE,
        normalizeCategory,
        tagMatchKey,
        createTagExclusion,
        isTagExclusion,
        categoryKey,
        normalizeState,
        createEmptyState,
        createController,
    });
})();
