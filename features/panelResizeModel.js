/**
 * DOM·저장소·타이머에 의존하지 않는 패널 너비 계산이에요.
 * BetterChzzk.panelResizeModel:
 * - fromStorage(object), normalizeWidth(value): 독립 local 키에서 정수 너비만 읽어요.
 * - normalizeState(object): version 1 문서 내 선택값을 검증해요.
 * - withWidth(state, "sidebar"|"chat", integer|null): 다른 영역을 보존하고 null로 기본 복원해요.
 * - calculateLayout(state, geometry): { suspended, sidebarWidthPx, chatWidthPx }를 반환해요.
 *   geometry는 실제 여백을 뺀 availableWidthPx와 sidebar/chat의
 *   { visible, enabled, nativeWidthPx }예요. 숨김 영역은 visible:false로 전달해요.
 *   반환 너비 null은 확장 너비 지정을 해제하라는 뜻이며 선택값은 바뀌지 않아요.
 * - getResizeRange(panel, availableWidthPx, otherWidthPx): { min, max } 또는 공간 부족 시 null이에요.
 * - clampWidth(panel, requestedWidthPx, availableWidthPx, otherWidthPx): 조절할 정수 너비 또는 null이에요.
 *   otherWidthPx는 다른 영역의 현재 실제 표시 폭이며, 선택값이나 이전 기본 폭이 아니에요.
 */
(() => {
    "use strict";
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const STORAGE_KEYS = Object.freeze({
        sidebar: "betterchzzk:panel-resize:sidebar-width:v1",
        chat: "betterchzzk:panel-resize:chat-width:v1",
    });
    const LIMITS = Object.freeze({
        sidebar: Object.freeze({ min: 180, max: 420 }),
        chat: Object.freeze({ min: 240, max: 640 }),
        centerMinPx: 320,
    });
    const panels = ["sidebar", "chat"];
    const validWidth = (value) => Number.isInteger(value) && value >= 1 && value <= 8192;
    const measuredWidth = (value) => Number.isFinite(value) && value >= 0;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

    function normalizeState(value) {
        const result = { version: 1, sidebarWidthPx: null, chatWidthPx: null };
        if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) return result;
        for (const panel of panels) {
            const key = `${panel}WidthPx`;
            if (validWidth(value[key])) result[key] = value[key];
        }
        return result;
    }

    function normalizeWidth(value) {
        return validWidth(value) ? value : null;
    }

    function fromStorage(value) {
        return normalizeState({
            version: 1,
            ...Object.fromEntries(
                panels.map((panel) => [`${panel}WidthPx`, normalizeWidth(value?.[STORAGE_KEYS[panel]])])
            ),
        });
    }

    function withWidth(state, panel, width) {
        const next = normalizeState(state);
        if (panels.includes(panel) && (width === null || validWidth(width))) next[`${panel}WidthPx`] = width;
        return next;
    }

    function calculateLayout(state, geometry = {}) {
        const selected = normalizeState(state);
        const result = { suspended: false, sidebarWidthPx: null, chatWidthPx: null };
        const custom = [];
        let nativeTotal = 0;
        let invalidMeasurement = !measuredWidth(geometry.availableWidthPx);
        for (const panel of panels) {
            const measured = geometry[panel];
            if (!measured?.visible) continue;
            const key = `${panel}WidthPx`;
            if (measured.enabled && selected[key] !== null) {
                const { min, max } = LIMITS[panel];
                custom.push({ key, min, desired: clamp(selected[key], min, max) });
            } else if (measuredWidth(measured.nativeWidthPx)) {
                nativeTotal += measured.nativeWidthPx;
            } else {
                invalidMeasurement = true;
            }
        }
        // 기본 상태 자체에는 사용자 지정 범위를 강제하지 않아요.
        if (!custom.length) return result;
        const budget = Math.floor(geometry.availableWidthPx - LIMITS.centerMinPx - nativeTotal);
        const minimum = custom.reduce((sum, panel) => sum + panel.min, 0);
        if (invalidMeasurement || budget < minimum) return { ...result, suspended: true };
        const excess = custom.reduce((sum, panel) => sum + panel.desired - panel.min, 0);
        const ratio = excess ? Math.min(1, (budget - minimum) / excess) : 1;
        for (const panel of custom) {
            result[panel.key] = Math.floor(panel.min + (panel.desired - panel.min) * ratio);
        }
        return result;
    }

    function getResizeRange(panel, availableWidthPx, otherWidthPx) {
        if (!panels.includes(panel) || !measuredWidth(availableWidthPx) || !measuredWidth(otherWidthPx)) return null;
        const { min, max: configuredMax } = LIMITS[panel];
        const max = Math.min(configuredMax, Math.floor(availableWidthPx - LIMITS.centerMinPx - otherWidthPx));
        return max < min ? null : { min, max };
    }

    function clampWidth(panel, requestedWidthPx, availableWidthPx, otherWidthPx) {
        if (!Number.isFinite(requestedWidthPx)) return null;
        const range = getResizeRange(panel, availableWidthPx, otherWidthPx);
        return range ? clamp(Math.round(requestedWidthPx), range.min, range.max) : null;
    }

    root.panelResizeModel = Object.freeze({
        STORAGE_KEYS,
        LIMITS,
        normalizeState,
        normalizeWidth,
        fromStorage,
        withWidth,
        calculateLayout,
        getResizeRange,
        clampWidth,
    });
})();
