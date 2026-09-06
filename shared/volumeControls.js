/** Shared volume hit testing, loaded independently in MAIN and isolated worlds. */
(() => {
    const EXTENSION_PREVIEW_VIDEO_SELECTOR =
        "[data-bcfp-player-mount], .bcfp-player, [data-bcfp-tooltip], [data-bcmv-video]";
    // Skip controls copy native button classes for appearance, including volume classes.
    // Their identity takes precedence over those copied classes in both execution worlds.
    const NON_VOLUME_CONTROL_SELECTOR = "#betterchzzk-skip-pill, #betterchzzk-live-fast-forward";
    const VOLUME_CONTROL_SELECTOR = [
        "[class*='pzp'][class*='volume']",
        ".pzp-pc__volume",
        ".pzp-pc__volume-control",
        ".pzp-pc__volume-button",
        ".pzp-pc__volume-slider",
        ".pzp-pc-volume",
        ".pzp-pc-volume-control",
        ".pzp-pc-volume-button",
        ".pzp-pc-volume-slider",
    ].join(", ");
    const VOLUME_BUTTON_SELECTOR = ["button", "[role='button']", "input[type='range']", "[role='slider']"].join(", ");
    const PLAYER_ROOT_SELECTOR = [
        ".pzp-pc",
        "[class*='pzp-pc']",
        "[class*='player']",
        "[id*='player']",
        "[class*='video_player']",
    ].join(", ");
    const PLAYBACK_ROUTE_RE = /^\/(?:live|video)(?:\/|$)/;
    const VOLUME_TERMS = ["volume", "mute", "muted", "speaker", "\uBCFC\uB968", "\uC74C\uB7C9", "\uC74C\uC18C\uAC70"];
    const DESCRIPTOR_ATTRS = [
        "id",
        "class",
        "aria-label",
        "label",
        "tooltip",
        "title",
        "data-testid",
        "data-test-id",
        "data-role",
    ];

    function compact(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");
    }

    function isPlaybackRoute() {
        return PLAYBACK_ROUTE_RE.test(location.pathname);
    }

    function isVisible(el) {
        if (!(el instanceof HTMLElement)) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = getComputedStyle(el);
        return style.display !== "none" && style.visibility !== "hidden";
    }

    function getElementDescriptor(el) {
        if (!(el instanceof Element)) return "";

        const parts = [];
        for (const attr of DESCRIPTOR_ATTRS) {
            parts.push(el.getAttribute(attr));
        }
        return compact(parts.filter(Boolean).join(" "));
    }

    function hasVolumeTerm(el) {
        const descriptor = getElementDescriptor(el);
        return VOLUME_TERMS.some((term) => descriptor.includes(compact(term)));
    }

    function getEventElements(event) {
        if (typeof event?.composedPath === "function") {
            return event.composedPath().filter((node) => node instanceof Element);
        }

        const elements = [];
        let node = event?.target;
        while (node instanceof Element) {
            elements.push(node);
            node = node.parentElement;
        }
        return elements;
    }

    function getVisibleVolumeElement(el) {
        if (!(el instanceof Element)) return null;

        const selectorMatch = el.closest?.(VOLUME_CONTROL_SELECTOR);
        if (selectorMatch instanceof HTMLElement && isVisible(selectorMatch)) return selectorMatch;

        const buttonMatch = el.closest?.(VOLUME_BUTTON_SELECTOR);
        if (buttonMatch instanceof HTMLElement && isVisible(buttonMatch) && hasVolumeTerm(buttonMatch)) {
            return buttonMatch;
        }

        if (el instanceof HTMLElement && isVisible(el) && hasVolumeTerm(el)) return el;
        return null;
    }

    function rectsOverlap(a, b, margin = 0) {
        return (
            a.left <= b.right + margin &&
            a.right >= b.left - margin &&
            a.top <= b.bottom + margin &&
            a.bottom >= b.top - margin
        );
    }

    function isVolumeControlInPlaybackContext(control, video) {
        if (!(control instanceof HTMLElement) || !(video instanceof HTMLVideoElement)) return false;

        const videoRoot = video.closest?.(PLAYER_ROOT_SELECTOR);
        if (videoRoot instanceof Element && videoRoot.contains(control)) return true;

        const controlRoot = control.closest?.(PLAYER_ROOT_SELECTOR);
        if (controlRoot instanceof Element && controlRoot.contains(video)) return true;

        const controlRect = control.getBoundingClientRect();
        const videoRect = video.getBoundingClientRect();
        if (controlRect.width <= 0 || controlRect.height <= 0 || videoRect.width <= 0 || videoRect.height <= 0) {
            return false;
        }

        return rectsOverlap(controlRect, videoRect, 12);
    }

    function getVolumeControlCandidates(event) {
        if (elementOrHostMatches(event?.target, NON_VOLUME_CONTROL_SELECTOR)) return [];
        if (
            elementOrHostMatches(
                event?.target,
                "[data-bcfp-player-mount], [data-bcfp-tooltip], .bcfp-player, .bcmv-cell"
            )
        )
            return [];
        const controls = [];
        const seen = new Set();
        for (const el of getEventElements(event)) {
            const control = getVisibleVolumeElement(el);
            if (!control || seen.has(control)) continue;
            seen.add(control);
            controls.push(control);
        }

        return controls;
    }

    function getVolumeControlForVideo(controls, video) {
        for (const control of controls || []) {
            if (isVolumeControlInPlaybackContext(control, video)) return control;
        }
        return null;
    }

    function pickLargestVisible(nodes) {
        let best = null;
        let bestArea = -1;
        for (const el of nodes || []) {
            if (!isVisible(el)) continue;
            const rect = el.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area > bestArea) {
                best = el;
                bestArea = area;
            }
        }
        return best || null;
    }

    function elementOrHostMatches(node, selector) {
        let current = node;
        while (current) {
            if (current instanceof Element && current.matches(selector)) return true;

            if (current.parentElement) {
                current = current.parentElement;
                continue;
            }

            const rootNode = current.getRootNode?.();
            if (
                typeof ShadowRoot !== "undefined" &&
                rootNode instanceof ShadowRoot &&
                rootNode.host &&
                rootNode.host !== current
            ) {
                current = rootNode.host;
                continue;
            }

            break;
        }
        return false;
    }

    function isExtensionPreviewVideo(video) {
        return video instanceof HTMLVideoElement && elementOrHostMatches(video, EXTENSION_PREVIEW_VIDEO_SELECTOR);
    }

    function getMainVideoElement() {
        const videos = Array.from(document.querySelectorAll("video")).filter(
            (video) => !isExtensionPreviewVideo(video)
        );
        return pickLargestVisible(videos) || videos[0] || null;
    }

    globalThis.BetterChzzkVolumeControls = Object.freeze({
        getVolumeControlCandidates,
        getVolumeControlForVideo,
        getMainVideoElement,
        isPlaybackRoute,
    });
})();
