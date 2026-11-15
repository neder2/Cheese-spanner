// Opt-in native playback controls. The option key is independent of retired rescue settings.
(() => {
    "use strict";
    if (CheeseSpanner.screenShortcuts) return;
    CheeseSpanner.screenShortcuts = {};
    const {
        bindFeatureOptions,
        getMainVideoElement,
        getPlayerRoot,
        isLiveAdBreakActive,
        isNativeAdBreakActive,
        isPlaybackRoute,
        isEditableTarget,
        isVodMultiviewInput,
    } = CheeseSpanner.utils;
    let enabled = false;
    let holdSpeedEnabled = true;
    const BUTTONS = {
        Space: ".pzp-pc__playback-switch",
        KeyM: ".pzp-pc__volume-button",
        KeyF: ".pzp-pc__fullscreen-button",
        KeyT: ".pzp-pc__viewmode-button",
    };

    function onKeyDown(event) {
        if (!isPlaybackRoute() || event.defaultPrevented || event.isComposing) return;
        if (isVodMultiviewInput(event)) return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        // holdSpeed owns both the short Space tap and the long press while enabled.
        if (event.code === "Space" && holdSpeedEnabled) return;
        const selector = BUTTONS[event.code];
        if (!selector) return;
        // 2026-11-05 공개 번들 기준 광고 구간의 Space·M은 네이티브가 광고 재생·음소거에 쓰므로 넘긴다. 라이브 광고는
        // 본영상 플레이어 바깥에서 재생돼 F/T가 숨은 본영상만 전체 화면·넓은 화면으로 바꾸므로 그때는 F/T도 넘긴다.
        // 다시보기 광고는 플레이어 안에서 재생돼 F/T가 광고를 포함한 화면에 그대로 적용된다.
        if (event.code === "Space" || event.code === "KeyM" ? isNativeAdBreakActive() : isLiveAdBreakActive()) return;
        const target = event.composedPath()[0] || event.target;
        if (isEditableTarget(target)) return;
        if (
            target instanceof Element &&
            target.closest(
                "[contenteditable]:not([contenteditable='false']), [role='textbox'], [role='searchbox'], [role='combobox'], [role='slider']"
            )
        )
            return;
        // Keys inside the stream info panel (streamInfo.js) belong to the panel: Space/Enter close it there.
        if (target instanceof Element && target.closest("#cheese-spanner-stream-info")) return;
        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
        const player = getPlayerRoot(video);
        if (!player?.contains(video)) return;
        if (target instanceof Element && target.closest("button, a[href], [role='button']") && !player.contains(target))
            return;
        const button = player.querySelector(selector);
        if (
            !(button instanceof HTMLButtonElement) ||
            button.disabled ||
            button.getAttribute("aria-disabled") === "true"
        )
            return;
        // Own this key synchronously, before the native bubbling handler can toggle it a second time.
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) button.click();
    }

    bindFeatureOptions((options) => {
        holdSpeedEnabled = options.holdSpeedEnabled !== false;
        const next = options.screenShortcutsEnabled === true;
        if (enabled === next) return;
        enabled = next;
        if (enabled) window.addEventListener("keydown", onKeyDown, true);
        else window.removeEventListener("keydown", onKeyDown, true);
    });
})();
