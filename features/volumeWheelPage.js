/**
 * features/volumeWheelPage.js — 재생 화면에서 마우스 휠로 볼륨 컨트롤 위를 스크롤하면 영상 볼륨을 조절한다.
 *
 * 실행 컨텍스트: MAIN world(페이지 컨텍스트). document_start에 로드되며 전역 BetterChzzkSettings/BetterChzzk에
 *   접근할 수 없다 — 옵션은 isolated world의 volumeWheel.js가 DOM attribute/CustomEvent로 중계해준다.
 * 동작 위치: /live 또는 /video 라우트(PLAYBACK_ROUTE_RE)의 볼륨 컨트롤(.pzp-pc__volume 계열) 위.
 * 하는 일: window에 capture 단계 wheel 리스너를 설치해, 이벤트 경로가 볼륨 컨트롤과 겹치고 메인 video와
 *   같은 플레이어 컨텍스트에 있을 때만 deltaY 부호로 볼륨을 step만큼 증감시킨다. 확장 자체 미리보기 영상
 *   (EXTENSION_PREVIEW_VIDEO_SELECTOR)은 메인 video 후보에서 제외한다. 라우트 변경(popstate/hashchange/
 *   pageshow/click 후 재확인)마다 리스너 설치 여부를 다시 동기화한다.
 * 옵션 키: volumeWheelEnabled, volumeWheelStep (모두 volumeWheel.js를 통해 전달받음).
 * 통신: CONFIG_ATTR(data-betterchzzk-volume-wheel-options) attribute를 읽고, CONFIG_EVENT
 *   (betterchzzk:volume-wheel-options)를 window에서 수신해 옵션을 갱신한다.
 */
(() => {
    const CONFIG_EVENT = "betterchzzk:volume-wheel-options";
    const CONFIG_ATTR = "data-betterchzzk-volume-wheel-options";
    const EXTENSION_PREVIEW_VIDEO_SELECTOR = "[data-bcfp-player-mount], .bcfp-player, [data-bcfp-tooltip]";
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

    let options = {
        enabled: false,
        step: 5,
    };
    let volumeApplyToken = 0;
    let wheelListenerInstalled = false;
    let routeSyncTimer = 0;

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function compact(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/\s+/g, "");
    }

    function isPlaybackRoute() {
        return PLAYBACK_ROUTE_RE.test(location.pathname);
    }

    function getStepRatio() {
        const step = Number(options.step);
        return clamp(Number.isFinite(step) ? step : 5, 1, 50) / 100;
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

    function commitVideoVolume(video, ratio) {
        const next = clamp(ratio, 0, 1);
        if (next <= 0) {
            video.volume = 0;
            video.muted = true;
            return;
        }

        if (video.muted) video.muted = false;
        video.volume = next;
        if (video.muted) video.muted = false;
    }

    function scheduleVolumeCommit(video, ratio, token) {
        const apply = () => {
            if (token !== volumeApplyToken) return;
            commitVideoVolume(video, ratio);
        };

        queueMicrotask(apply);
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(apply);
        setTimeout(apply, 0);
    }

    function applyVolumeDelta(video, directionSteps) {
        if (!(video instanceof HTMLVideoElement)) return false;

        const current = video.muted ? 0 : Number.isFinite(video.volume) ? video.volume : 0;
        const next = clamp(current + directionSteps * getStepRatio(), 0, 1);
        const token = ++volumeApplyToken;

        commitVideoVolume(video, next);
        scheduleVolumeCommit(video, next, token);
        return true;
    }

    function handleWheel(event) {
        if (!options.enabled || !isPlaybackRoute()) return;
        if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return;

        const controls = getVolumeControlCandidates(event);
        if (!controls.length) return;

        const video = getMainVideoElement();
        if (!(video instanceof HTMLVideoElement)) return;

        const control = getVolumeControlForVideo(controls, video);
        if (!control) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        const direction = event.deltaY < 0 ? 1 : -1;
        applyVolumeDelta(video, direction);
    }

    function parseOptions(value) {
        if (!value) return null;
        try {
            const parsed = JSON.parse(value);
            if (!parsed || typeof parsed !== "object") return null;
            const step = Number(parsed.step);
            return {
                enabled: parsed.enabled === true,
                step: clamp(Number.isFinite(step) ? step : 5, 1, 50),
            };
        } catch {
            return null;
        }
    }

    function applyOptionsFromAttribute() {
        const parsed = parseOptions(document.documentElement.getAttribute(CONFIG_ATTR));
        if (parsed) options = parsed;
        syncWheelListener();
    }

    function installWheelListener() {
        if (wheelListenerInstalled) return;
        wheelListenerInstalled = true;
        window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    }

    function uninstallWheelListener() {
        if (!wheelListenerInstalled) return;
        wheelListenerInstalled = false;
        window.removeEventListener("wheel", handleWheel, true);
    }

    function syncWheelListener() {
        if (options.enabled && isPlaybackRoute()) installWheelListener();
        else uninstallWheelListener();
    }

    function scheduleWheelListenerSync() {
        if (routeSyncTimer) return;
        routeSyncTimer = window.setTimeout(() => {
            routeSyncTimer = 0;
            syncWheelListener();
        }, 0);
    }

    window.addEventListener(CONFIG_EVENT, applyOptionsFromAttribute, true);
    window.addEventListener("popstate", syncWheelListener, true);
    window.addEventListener("hashchange", syncWheelListener, true);
    window.addEventListener("pageshow", syncWheelListener, true);
    document.addEventListener("click", scheduleWheelListenerSync, true);
    applyOptionsFromAttribute();
})();
