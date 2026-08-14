/**
 * features/shortcutRescue.js — 치지직 네이티브 플레이어 단축키(재생/음소거/전체화면/넓은 화면)가 죽었을 때 복구한다.
 *
 * 실행 컨텍스트: isolated world(확장 컨텍스트). manifest.json 로드 순서상 가장 마지막에 실행된다.
 * 동작 위치: /live 또는 /video 재생 라우트(isPlaybackRoute)의 플레이어 영역, keydown(Space/KeyM/KeyF/KeyT).
 * 하는 일: 키를 누르면 네이티브 핸들러가 상태(재생/음소거/전체화면)를 바꾸는지 PROBE_TIMEOUT_MS(80ms) 동안
 *   관찰해 파이프라인 생존 여부(pipelineState: unknown/alive/dead)를 라우트 진입마다 새로 판정한다. 죽었다고
 *   판정되면 이후 같은 라우트에서는 관찰을 건너뛰고 즉시 버튼 클릭(우선) 또는 video/document API 직접 호출로
 *   폴백한다. Space는 repeat keydown을 무시하며(네이티브와 달리 반복 입력에 반응하지 않음), 편집 가능 대상이나
 *   실제 상호작용 요소, 플레이어 바깥 상호작용 대상에서는 개입하지 않는다.
 * 의존: 전역 BetterChzzk.utils(getMainVideoElement, getPlayerRoot, isEditableTarget,
 *   isOutsidePlayerInteractiveTarget, isPlaybackRoute, isVisible, normalizeCompact).
 */
(() => {
    // 네이티브 키 핸들러는 정상일 때 같은 이벤트 턴 근처에서 상태를 바꾼다.
    // 오래 기다리면 복구 자체가 입력 지연처럼 보이므로 짧은 유예만 둔다.
    const PROBE_TIMEOUT_MS = 80;
    const BUTTON_SELECTOR = "button, [role='button']";
    const INTERACTIVE_TARGET_SELECTOR =
        "button, [role='button'], a[href], [role='link'], summary, [role='checkbox'], [role='menuitem'], " +
        "[role='option'], [role='radio'], [role='slider'], [role='switch'], [role='tab'], [role='textbox'], " +
        "[role='combobox'], [role='searchbox'], [role='spinbutton'], [role='treeitem']";
    const DESCRIPTOR_ATTRS = ["aria-label", "label", "tooltip", "title", "data-testid", "class"];

    const {
        getMainVideoElement,
        getPlayerRoot,
        isEditableTarget,
        isOutsidePlayerInteractiveTarget,
        isPlaybackRoute,
        isVisible,
        normalizeCompact,
    } = BetterChzzk.utils;

    // 치지직 단축키 파이프라인 생존 여부는 페이지 진입 시점에 랜덤하게 결정되므로 라우트마다 다시 판정한다.
    let pipelineState = "unknown"; // "unknown" | "alive" | "dead"
    let lastHref = location.href;
    let lastFallbackAt = -Infinity;
    let lastFallbackAction = null;
    const pendingProbes = new Set();

    const KEY_ACTIONS = {
        Space: {
            playerTargetOnly: true,
            buttonSelectors: [".pzp-pc__playback-switch", ".pzp-pc-playback-switch"],
            buttonTerms: ["일시정지", "일시 정지", "재생", "pause", "play"],
            observe(video) {
                return video ? `paused:${video.paused}` : null;
            },
            apply(video) {
                if (!(video instanceof HTMLVideoElement)) return;
                if (video.paused) {
                    try {
                        video.play()?.catch?.(() => {});
                    } catch {
                        /* 재생 거부는 무시 */
                    }
                    return;
                }
                video.pause();
            },
        },
        KeyM: {
            buttonSelectors: [".pzp-pc__volume-button", ".pzp-pc-volume-button"],
            buttonTerms: ["음소거", "음소거 해제", "mute", "unmute"],
            observe(video) {
                return video ? `muted:${video.muted}` : null;
            },
            apply(video) {
                if (video instanceof HTMLVideoElement) video.muted = !video.muted;
            },
        },
        KeyF: {
            buttonSelectors: [".pzp-pc__fullscreen-button", ".pzp-pc-fullscreen-button"],
            buttonTerms: ["전체 화면", "전체화면", "fullscreen"],
            observe() {
                return `fullscreen:${Boolean(document.fullscreenElement)}`;
            },
            apply(video) {
                try {
                    if (document.fullscreenElement) {
                        document.exitFullscreen()?.catch?.(() => {});
                        return;
                    }
                    const root = getPlayerRoot(video) || video;
                    root?.requestFullscreen?.()?.catch?.(() => {});
                } catch {
                    /* 전체 화면 거부는 무시 */
                }
            },
        },
        // 넓은 화면은 React 레이아웃 상태라 버튼 클릭으로만 처리하고,
        // 토글 결과를 안정적으로 관찰할 수 없어 생존 판정에는 참여하지 않는다.
        KeyT: {
            buttonSelectors: [".pzp-pc__viewmode-button", ".pzp-pc-viewmode-button"],
            buttonTerms: ["넓은 화면", "넓은화면", "기본 화면", "기본화면", "wide", "theater"],
        },
    };

    function getElementDescriptor(el) {
        if (!(el instanceof Element)) return "";
        const parts = [];
        for (const attr of DESCRIPTOR_ATTRS) {
            parts.push(el.getAttribute(attr));
        }
        return normalizeCompact(parts.filter(Boolean).join(" "));
    }

    function matchesAnyTerm(el, terms) {
        const descriptor = getElementDescriptor(el);
        if (!descriptor) return false;
        return terms.some((term) => descriptor.includes(normalizeCompact(term)));
    }

    function isInteractiveTarget(target) {
        return target instanceof Element && Boolean(target.closest(INTERACTIVE_TARGET_SELECTOR));
    }

    function resolveClickTarget(el) {
        if (!(el instanceof HTMLElement)) return null;
        if (el.matches(BUTTON_SELECTOR)) return el;
        const inner = el.querySelector(BUTTON_SELECTOR);
        return inner instanceof HTMLElement ? inner : el;
    }

    function findControlButton(action, video) {
        const root = getPlayerRoot(video);
        const classScope = root || document;
        for (const selector of action.buttonSelectors) {
            const direct = classScope.querySelector(selector);
            if (direct instanceof HTMLElement && isVisible(direct)) return resolveClickTarget(direct);
        }
        // 용어 매칭은 플레이어 밖 버튼(채팅 설정 등) 오클릭을 막기 위해 플레이어 루트 안에서만 시도한다.
        if (!root) return null;
        for (const candidate of root.querySelectorAll(BUTTON_SELECTOR)) {
            if (!(candidate instanceof HTMLElement) || !isVisible(candidate)) continue;
            if (matchesAnyTerm(candidate, action.buttonTerms)) return candidate;
        }
        return null;
    }

    // 버튼 클릭은 정상 React 경로라 죽은 파이프라인과 무관하게 동작하므로 항상 클릭을 우선한다.
    function runFallback(action, video) {
        lastFallbackAt = performance.now();
        lastFallbackAction = action;
        const button = findControlButton(action, video);
        if (button) {
            button.click();
            return;
        }
        action.apply?.(video);
    }

    function resetPipelineState() {
        pipelineState = "unknown";
        lastFallbackAction = null;
        pendingProbes.clear();
    }

    function syncRouteState() {
        if (lastHref === location.href) return;
        lastHref = location.href;
        resetPipelineState();
    }

    function resolveProbe(action, video, snapshot, startedAt) {
        if (pipelineState !== "unknown") return;
        if (lastHref !== location.href) return;
        // 같은 키의 프로브 도중 우리가 폴백을 실행했다면 그 변화가 섞이므로 이번 판정은 버린다.
        if (lastFallbackAt >= startedAt && lastFallbackAction === action) return;

        const current = action.observe(video);
        if (current === null) return;

        if (current !== snapshot) {
            pipelineState = "alive";
            return;
        }

        pipelineState = "dead";
        runFallback(action, video);
    }

    function scheduleProbe(action, video, snapshot) {
        if (pendingProbes.has(action)) return;
        pendingProbes.add(action);
        const startedAt = performance.now();
        window.setTimeout(() => {
            if (!pendingProbes.delete(action)) return;
            resolveProbe(action, video, snapshot, startedAt);
        }, PROBE_TIMEOUT_MS);
    }

    function onKeyDown(event) {
        if (!isPlaybackRoute()) return;
        if (event.repeat || event.isComposing) return;
        if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;

        syncRouteState();
        if (pipelineState === "alive") return;

        const action = KEY_ACTIONS[event.code];
        if (!action) return;
        if (isEditableTarget(event.target)) return;
        if (isInteractiveTarget(event.target)) return;

        const video = getMainVideoElement();
        if (action.playerTargetOnly && isOutsidePlayerInteractiveTarget(event.target, video)) return;

        if (pipelineState === "dead") {
            event.preventDefault();
            runFallback(action, video);
            return;
        }

        if (typeof action.observe !== "function") {
            event.preventDefault();
            runFallback(action, video);
            return;
        }
        const snapshot = action.observe(video);
        if (snapshot === null) return;
        scheduleProbe(action, video, snapshot);
    }

    window.addEventListener("keydown", onKeyDown, true);
})();
