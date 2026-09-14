// Opt-in native playback controls. The option key is independent of retired rescue settings.
(() => {
    "use strict";
    if (BetterChzzk.screenShortcuts) return;
    BetterChzzk.screenShortcuts = {};
    const { bindFeatureOptions, getMainVideoElement, getPlayerRoot, isPlaybackRoute, isEditableTarget } =
        BetterChzzk.utils;
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
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
        // holdSpeed owns both the short Space tap and the long press while enabled.
        if (event.code === "Space" && holdSpeedEnabled) return;
        const selector = BUTTONS[event.code];
        if (!selector) return;
        const target = event.composedPath()[0] || event.target;
        if (isEditableTarget(target)) return;
        if (
            target instanceof Element &&
            target.closest(
                "[contenteditable]:not([contenteditable='false']), [role='textbox'], [role='searchbox'], [role='combobox'], [role='slider']"
            )
        )
            return;
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
