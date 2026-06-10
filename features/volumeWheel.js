(() => {
    const CONFIG_EVENT = "betterchzzk:volume-wheel-options";
    const CONFIG_ATTR = "data-betterchzzk-volume-wheel-options";

    let featureOptions = BetterChzzkSettings.normalizeOptions();

    const {
        bindFeatureOptions,
    } = BetterChzzk.utils;

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
