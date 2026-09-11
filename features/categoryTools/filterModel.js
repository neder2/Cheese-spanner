/** 카테고리 목록 필터의 입력·프리셋·포함 범위 계산. UI 상태와 설정은 호출자가 전달한다. */
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

    function passesCountRange(value, min, max) {
        const count = Number(value) || 0;
        if (min > 0 && count < min) return false;
        if (max > 0 && count > max) return false;
        return true;
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

    function getFilterPresetRanges(kind, options) {
        const values = getFilterPresetValues(kind, options);
        const ranges = [{ min: 0, max: 0 }];
        if (!values.length) return ranges;

        ranges.push({ min: 0, max: values[0] });
        for (let i = 1; i < values.length; i++) {
            ranges.push({ min: values[i - 1], max: values[i] });
        }
        ranges.push({ min: values[values.length - 1], max: 0 });
        return ranges;
    }

    function formatFilterOptionLabel(kind, min, max, unit) {
        if (min <= 0 && max <= 0) return "전체";
        if (min <= 0) return `${formatFilterInputForKind(kind, max)}${unit} 이하`;
        if (max <= 0) {
            const suffix = kind === "duration" ? " 이상" : " ~ 최대";
            return `${formatFilterInputForKind(kind, min)}${unit}${suffix}`;
        }
        return `${formatFilterInputForKind(kind, min)}${unit} ~ ${formatFilterInputForKind(kind, max)}${unit}`;
    }

    function combineFilterOptionRanges(firstRange, lastRange) {
        const min = Math.min(firstRange.min, lastRange.min);
        const includesOpenEnd =
            (firstRange.max <= 0 && firstRange.min > 0) || (lastRange.max <= 0 && lastRange.min > 0);
        const max = includesOpenEnd ? 0 : Math.max(firstRange.max || firstRange.min, lastRange.max || lastRange.min);
        return { min, max: min === max ? 0 : max };
    }

    function hasFilterOptionRange(range) {
        return Boolean(range && (range.min > 0 || range.max > 0));
    }

    root.categoryToolsFilterModel = Object.freeze({
        passesCountRange,
        parseFilterInputForKind,
        formatFilterInputForKind,
        getFilterPresetValues,
        getFilterPresetRanges,
        formatFilterOptionLabel,
        combineFilterOptionRanges,
        hasFilterOptionRange,
    });
})();
