/**
 * features/volumeWheel.js — 휠 볼륨 조절 옵션을 isolated world에서 MAIN world로 중계한다.
 *
 * 실행 컨텍스트: isolated world(확장 컨텍스트). 실제 휠 동작 실행은 MAIN world의 volumeWheelPage.js가 맡는다.
 * 동작 위치: 페이지 전역(document.documentElement) — 특정 라우트에 종속되지 않고 옵션 변경 시마다 동작.
 * 하는 일: BetterChzzkSettings에서 volumeWheelEnabled/volumeWheelStep을 읽어 정규화한 뒤, 값이 바뀔 때마다
 *   document.documentElement의 data attribute에 JSON으로 기록하고 CustomEvent를 window에 dispatch한다.
 *   MAIN world는 전역 BetterChzzk 접근 권한이 없으므로 이 파일이 유일한 옵션 전달 통로다.
 * 의존: 전역 BetterChzzkSettings.normalizeOptions, BetterChzzk.utils.bindFeatureOptions.
 * 옵션 키: volumeWheelEnabled, volumeWheelStep.
 * 통신: CONFIG_ATTR(data-betterchzzk-volume-wheel-options)에 {enabled, step} JSON을 쓰고,
 *   CONFIG_EVENT(betterchzzk:volume-wheel-options)를 window에 dispatch해 volumeWheelPage.js(MAIN world)에 알린다.
 */
(() => {
    const CONFIG_EVENT = "betterchzzk:volume-wheel-options";
    const CONFIG_ATTR = "data-betterchzzk-volume-wheel-options";

    let featureOptions = BetterChzzkSettings.normalizeOptions();

    const { bindFeatureOptions } = BetterChzzk.utils;

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function publishOptions() {
        const payload = {
            enabled: Boolean(featureOptions.volumeWheelEnabled),
            step: clamp(Number(featureOptions.volumeWheelStep) || 5, 1, 50),
        };

        document.documentElement.setAttribute(CONFIG_ATTR, JSON.stringify(payload));
        window.dispatchEvent(new CustomEvent(CONFIG_EVENT));
    }

    function applyOptions(options) {
        featureOptions = options;
        publishOptions();
    }

    bindFeatureOptions(applyOptions);
})();
