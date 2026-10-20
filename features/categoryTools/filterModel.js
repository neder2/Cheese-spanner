/** 카테고리 목록 필터의 입력·모드·조건·검색 단어·탭 기록 계산. UI 상태와 저장은 호출자가 소유한다. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const FOLLOWER_FILTER_PRESET_KEYS = Object.freeze([
        "categoryToolsFollowerFilterPreset1",
        "categoryToolsFollowerFilterPreset2",
        "categoryToolsFollowerFilterPreset3",
        "categoryToolsFollowerFilterPreset4",
        "categoryToolsFollowerFilterPreset5",
        "categoryToolsFollowerFilterPreset6",
    ]);
    const VIEW_FILTER_PRESET_KEYS = Object.freeze([
        "categoryToolsViewFilterPreset1",
        "categoryToolsViewFilterPreset2",
        "categoryToolsViewFilterPreset3",
        "categoryToolsViewFilterPreset4",
        "categoryToolsViewFilterPreset5",
        "categoryToolsViewFilterPreset6",
    ]);
    const DURATION_FILTER_PRESET_KEYS = Object.freeze([
        "categoryToolsDurationFilterPreset1",
        "categoryToolsDurationFilterPreset2",
        "categoryToolsDurationFilterPreset3",
        "categoryToolsDurationFilterPreset4",
        "categoryToolsDurationFilterPreset5",
        "categoryToolsDurationFilterPreset6",
    ]);
    const SECONDS_PER_HOUR = 60 * 60;
    const FILTER_KINDS = Object.freeze(["followers", "views", "duration"]);
    const FILTER_MODES = Object.freeze(["none", "min", "max", "range"]);
    // 탭 기록에 받아들이는 상한. 인원·횟수는 옵션 프리셋 상한, 진행 시간은 옵션 상한(168시간)과 같다.
    const COUNT_VALUE_LIMIT = 10_000_000;
    const DURATION_VALUE_LIMIT = 168 * SECONDS_PER_HOUR;
    const SEARCH_QUERY_LIMIT = 100;
    const LIST_FILTER_SESSION_VERSION = 1;
    const LIST_FILTER_ROUTE_LIMIT = 20;
    const LIST_FILTER_ROUTE_KEY = /^(?:global-lives\/lives|[^/]{1,80}\/[^/]{1,160}\/(?:lives|videos|clips))$/;

    function passesCountRange(value, min, max) {
        const count = Number(value) || 0;
        if (min > 0 && count < min) return false;
        if (max > 0 && count > max) return false;
        return true;
    }

    function passesCategoryExclusions(category, excludedCategories) {
        const categoryKey = root.categoryExclusions?.categoryKey;
        const key = categoryKey?.(category);
        if (!key) return true;
        if (typeof excludedCategories?.has === "function") return !excludedCategories.has(key);
        if (!Array.isArray(excludedCategories)) return true;
        return !excludedCategories.some((excluded) => categoryKey(excluded) === key);
    }

    function passesTagExclusions(tags, excludedTagKeys) {
        const tagMatchKey = root.categoryExclusions?.tagMatchKey;
        if (!tagMatchKey || !excludedTagKeys?.size || !Array.isArray(tags)) return true;
        return !tags.some((tag) => {
            const key = tagMatchKey(tag);
            return Boolean(key) && excludedTagKeys.has(key);
        });
    }

    function parseFilterInput(value) {
        const raw = String(value || "")
            .replace(/,/g, "")
            .trim();
        if (!raw) return 0;
        const match = raw.match(/^(\d+(?:\.\d+)?)\s*(만|천)?/);
        if (!match) return 0;
        const base = Number(match[1]);
        if (!Number.isFinite(base)) return 0;
        const unit = match[2];
        if (unit === "만") return Math.max(0, Math.floor(base * 10000));
        if (unit === "천") return Math.max(0, Math.floor(base * 1000));
        return Math.max(0, Math.floor(base));
    }

    function formatFilterInput(value) {
        const number = Math.max(0, Math.floor(Number(value) || 0));
        if (!number) return "";
        if (number >= 10000 && number % 10000 === 0) return `${number / 10000}만`;
        return number.toLocaleString("ko-KR");
    }

    function parseDurationFilterInput(value) {
        const raw = String(value || "")
            .replace(/,/g, "")
            .trim();
        if (!raw) return 0;
        const match = raw.match(/^(\d+(?:\.\d+)?)/);
        if (!match) return 0;
        const hours = Number(match[1]);
        if (!Number.isFinite(hours) || hours <= 0) return 0;
        return Math.floor(hours * SECONDS_PER_HOUR);
    }

    function formatDurationFilterInput(value) {
        const seconds = Math.max(0, Number(value) || 0);
        if (!seconds) return "";
        const hours = seconds / SECONDS_PER_HOUR;
        return String(Number.isInteger(hours) ? hours : Math.round(hours * 100) / 100);
    }

    function parseFilterInputForKind(kind, value) {
        return kind === "duration" ? parseDurationFilterInput(value) : parseFilterInput(value);
    }

    function formatFilterInputForKind(kind, value) {
        return kind === "duration" ? formatDurationFilterInput(value) : formatFilterInput(value);
    }

    function getFilterPresetValues(kind, options) {
        const keys =
            kind === "followers"
                ? FOLLOWER_FILTER_PRESET_KEYS
                : kind === "duration"
                  ? DURATION_FILTER_PRESET_KEYS
                  : VIEW_FILTER_PRESET_KEYS;
        const scale = kind === "duration" ? SECONDS_PER_HOUR : 1;
        const values = keys
            .map((key) => Math.max(0, Math.floor(Number(options[key]) || 0)) * scale)
            .filter((value) => value > 0)
            .sort((a, b) => a - b);
        return Array.from(new Set(values));
    }

    function positiveInteger(value) {
        const number = Math.floor(Number(value));
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function createFilterState() {
        return { mode: "none", min: 0, max: 0 };
    }

    // 모드에 따라 실제로 적용하는 범위. 값이 없는 끝은 제한이 없고, 범위는 입력 순서와 무관하게 양끝을 포함한다.
    function effectiveRange(state) {
        const min = positiveInteger(state?.min);
        const max = positiveInteger(state?.max);
        if (state?.mode === "min") return { min, max: 0 };
        if (state?.mode === "max") return { min: 0, max };
        if (state?.mode === "range") return min && max && min > max ? { min: max, max: min } : { min, max };
        return { min: 0, max: 0 };
    }

    function isActiveRange(range) {
        return Boolean(range && (range.min > 0 || range.max > 0));
    }

    function filterStateFromRange(min, max) {
        const low = positiveInteger(min);
        const high = positiveInteger(max);
        const mode = low && high ? "range" : low ? "min" : high ? "max" : "none";
        return { mode, min: low, max: high };
    }

    // 이상↔이하는 값을 옮기고, 이상·이하에서 범위로 가면 그 값을 같은 끝에 둔다. 전체는 값을 지우지 않는다.
    function setFilterMode(state, mode) {
        const current = state || createFilterState();
        if (!FILTER_MODES.includes(mode) || current.mode === mode) return current;
        const min = positiveInteger(current.min);
        const max = positiveInteger(current.max);
        const single = current.mode === "min" ? min : current.mode === "max" ? max : min || max;
        if (mode === "none") return { mode, min, max };
        if (mode === "min") return { mode, min: single, max: 0 };
        if (mode === "max") return { mode, min: 0, max: single };
        if (current.mode === "min") return { mode, min: single, max: 0 };
        if (current.mode === "max") return { mode, min: 0, max: single };
        return { mode, min, max };
    }

    function setFilterSingleValue(state, value) {
        const mode = state?.mode === "max" ? "max" : "min";
        const number = positiveInteger(value);
        return mode === "max" ? { mode, min: 0, max: number } : { mode, min: number, max: 0 };
    }

    function setFilterRangeValue(state, bound, value) {
        const current = state?.mode === "range" ? state : { mode: "range", ...effectiveRange(state) };
        const number = positiveInteger(value);
        return {
            mode: "range",
            min: bound === "min" ? number : positiveInteger(current.min),
            max: bound === "max" ? number : positiveInteger(current.max),
        };
    }

    // 조건 칩 문구용 숫자. 만·천 단위로 딱 떨어질 때만 줄이고 그 밖은 정확한 수를 보인다.
    function formatConditionValue(kind, value) {
        if (kind === "duration") return formatDurationFilterInput(value);
        const number = positiveInteger(value);
        if (number >= 10000 && number % 1000 === 0) {
            const tenThousands = number / 10000;
            return `${Number.isInteger(tenThousands) ? tenThousands : tenThousands.toFixed(1).replace(/\.0$/, "")}만`;
        }
        if (number >= 1000 && number % 1000 === 0) return `${number / 1000}천`;
        return number.toLocaleString("ko-KR");
    }

    function conditionTerms(kind, liveList) {
        if (kind === "followers") return { name: "팔로워", unit: "명" };
        if (kind === "duration") return { name: "진행", unit: "시간" };
        return liveList ? { name: "시청자", unit: "명" } : { name: "조회수", unit: "회" };
    }

    function formatConditionLabel(kind, range, { liveList = true } = {}) {
        const { min, max } = range || {};
        if (!isActiveRange(range)) return "";
        const { name, unit } = conditionTerms(kind, liveList);
        const value = (number) => formatConditionValue(kind, number);
        if (min && max) return `${name} ${value(min)}~${value(max)}${unit}`;
        if (min) return `${name} ${value(min)}${unit} 이상`;
        return `${name} ${value(max)}${unit} 이하`;
    }

    function normalizeSearchText(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");
    }

    // 띄어쓰기로 나눈 단어를 모두 포함해야 하고, '-'로 시작하는 두 글자 이상 단어는 빼는 조건이다.
    function parseSearchTerms(query) {
        const include = [];
        const exclude = [];
        const tokens = [];
        for (const raw of String(query || "")
            .slice(0, SEARCH_QUERY_LIMIT)
            .split(/\s+/)) {
            if (!raw) continue;
            const negative = raw.length > 1 && raw.startsWith("-");
            const word = normalizeSearchText(negative ? raw.slice(1) : raw);
            if (!word || /^-+$/.test(word)) continue;
            tokens.push({ raw, word, negative });
            (negative ? exclude : include).push(word);
        }
        const key = tokens.map((token) => `${token.negative ? "-" : ""}${token.word}`).join(" ");
        return { include, exclude, tokens, key };
    }

    function hasSearchTerms(terms) {
        return Boolean(terms && (terms.include.length || terms.exclude.length));
    }

    // 단어마다 한 칸(제목·채널·카테고리·태그·카드 글자 조각) 안에서만 찾아 칸 경계를 넘는 일치를 막는다.
    function matchesSearchTerms(fields, terms) {
        if (!hasSearchTerms(terms)) return true;
        const list = Array.isArray(fields) ? fields : [];
        const hit = (word) => list.some((field) => typeof field === "string" && field.includes(word));
        return terms.include.every(hit) && !terms.exclude.some(hit);
    }

    function removeSearchTerm(query, index) {
        return parseSearchTerms(query)
            .tokens.filter((_, tokenIndex) => tokenIndex !== index)
            .map((token) => token.raw)
            .join(" ");
    }

    function normalizeFilterRecord(kind, value) {
        if (!value || typeof value !== "object" || !FILTER_MODES.includes(value.mode) || value.mode === "none")
            return null;
        const limit = kind === "duration" ? DURATION_VALUE_LIMIT : COUNT_VALUE_LIMIT;
        for (const number of [value.min, value.max]) {
            if (!Number.isSafeInteger(number) || number < 0 || number > limit) return null;
        }
        const range = effectiveRange(value);
        if (!isActiveRange(range)) return null;
        return { mode: value.mode, min: range.min, max: range.max };
    }

    function normalizeListFilterRecord(record, routeKey) {
        if (!record || typeof record !== "object" || !LIST_FILTER_ROUTE_KEY.test(String(routeKey))) return null;
        const query =
            typeof record.query === "string" && record.query.length <= SEARCH_QUERY_LIMIT ? record.query.trim() : "";
        const filters = {};
        for (const kind of FILTER_KINDS) {
            // 진행 시간은 라이브 목록에서만 쓰는 조건이다.
            if (kind === "duration" && !String(routeKey).endsWith("/lives")) continue;
            const normalized = normalizeFilterRecord(kind, record.filters?.[kind]);
            if (normalized) filters[kind] = normalized;
        }
        if (!query && !Object.keys(filters).length) return null;
        const savedAt = Number.isSafeInteger(record.savedAt) && record.savedAt > 0 ? record.savedAt : 0;
        return { savedAt, query, filters };
    }

    function pruneListFilterRoutes(routes) {
        const kept = Object.entries(routes)
            .sort((a, b) => b[1].savedAt - a[1].savedAt)
            .slice(0, LIST_FILTER_ROUTE_LIMIT);
        return Object.fromEntries(kept);
    }

    // 탭 기록은 페이지 스크립트도 바꿀 수 있어 읽을 때마다 형식·상한을 다시 검증하고 틀린 항목은 버린다.
    function readListFilterSession(raw) {
        let parsed = null;
        try {
            parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (_) {
            parsed = null;
        }
        const routes = {};
        if (
            parsed &&
            typeof parsed === "object" &&
            parsed.version === LIST_FILTER_SESSION_VERSION &&
            parsed.routes &&
            typeof parsed.routes === "object" &&
            !Array.isArray(parsed.routes)
        ) {
            for (const [key, record] of Object.entries(parsed.routes)) {
                const normalized = normalizeListFilterRecord(record, key);
                if (normalized) routes[key] = normalized;
            }
        }
        return { version: LIST_FILTER_SESSION_VERSION, routes: pruneListFilterRoutes(routes) };
    }

    function writeListFilterRoute(session, routeKey, record, savedAt) {
        const routes = { ...(session?.routes || {}) };
        delete routes[routeKey];
        const normalized = normalizeListFilterRecord({ ...record, savedAt }, routeKey);
        if (normalized) routes[routeKey] = normalized;
        return { version: LIST_FILTER_SESSION_VERSION, routes: pruneListFilterRoutes(routes) };
    }

    root.categoryToolsFilterModel = Object.freeze({
        FILTER_KINDS,
        FILTER_MODES,
        passesCountRange,
        passesCategoryExclusions,
        passesTagExclusions,
        parseFilterInputForKind,
        formatFilterInputForKind,
        getFilterPresetValues,
        createFilterState,
        effectiveRange,
        isActiveRange,
        filterStateFromRange,
        setFilterMode,
        setFilterSingleValue,
        setFilterRangeValue,
        formatConditionValue,
        formatConditionLabel,
        normalizeSearchText,
        parseSearchTerms,
        hasSearchTerms,
        matchesSearchTerms,
        removeSearchTerm,
        readListFilterSession,
        writeListFilterRoute,
    });
})();
