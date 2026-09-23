/**
 * 통합 팝업 제거 옵션의 커넥터 설치 안내 닫기. 측정한 안내의 '설치없이 일반 화질 시청'만 선택한다.
 * isolated world. 설정이 로드된 뒤 라이브에서 동작하며 설치·재생 버튼이나 메타데이터는 다루지 않는다.
 * 전역 감시는 추가/제거된 하위 트리만 확인하고, 최대 4개의 안내와 조상 표시 속성만 관찰한다.
 */
(() => {
    const BACKDROP = '[class^="_dimmed_"], [class*=" _dimmed_"]';
    const LAYER = '[class^="_layer_"], [class*=" _layer_"]';
    const PLAYER = '[class^="_player_"], [class*=" _player_"]';
    const STATE_ATTR = "data-betterchzzk-auto-quality-guide";
    const MESSAGE = "고화질시청을위해서는네이버라이브스트리밍커넥터가필요합니다.";
    const DECLINE = "설치없이일반화질시청";
    const INSTALL = "설치하고고화질시청";
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        normalizeCompact,
        startPageChangeDetection,
        hasNativeHideMutation,
    } = BetterChzzk.utils;
    const entries = new Map();
    let options = null;
    let observer = null;
    let removeRouteListener = null;
    let running = false;
    let route = location.pathname;
    let attempts = 0;

    function requested() {
        return Boolean(options?.adblockPopupEnabled);
    }

    function enabled() {
        return requested() && /^\/live\/[^/]+\/?$/.test(location.pathname);
    }

    function publish() {
        const value = JSON.stringify({ enabled: running && enabled(), attempts });
        if (document.documentElement.getAttribute(STATE_ATTR) !== value)
            document.documentElement.setAttribute(STATE_ATTR, value);
    }

    function drop(root) {
        entries.get(root)?.observer.disconnect();
        entries.delete(root);
    }

    function shown(root) {
        if (!root.isConnected) return false;
        for (let node = root; node instanceof HTMLElement; node = node.parentElement) {
            if (node.hidden || node.getAttribute("aria-hidden") === "true") return false;
            const style = getComputedStyle(node);
            if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")
                return false;
        }
        return true;
    }

    function rendered(root) {
        const rect = root.getBoundingClientRect();
        return shown(root) && rect.width > 0 && rect.height > 0;
    }

    function getDeclineButton(root) {
        if (!root.matches(BACKDROP) || !root.parentElement?.matches(PLAYER)) return null;
        const layers = Array.from(root.children).filter((child) => child.matches(LAYER));
        const layer = layers.length === 1 ? layers[0] : null;
        const buttons = Array.from(layer?.querySelectorAll("button") || []);
        const button = buttons.find((item) => normalizeCompact(item.textContent) === DECLINE);
        return button &&
            buttons.length === 2 &&
            buttons.every((item) => item.closest(BACKDROP) === root) &&
            buttons.filter((item) => normalizeCompact(item.textContent) === DECLINE).length === 1 &&
            buttons.filter((item) => normalizeCompact(item.textContent) === INSTALL).length === 1 &&
            Array.from(layer.querySelectorAll("p")).some((item) => normalizeCompact(item.textContent) === MESSAGE)
            ? button
            : null;
    }

    function inspect(entry) {
        if (!running || !enabled() || route !== location.pathname) return;
        const { root, parent } = entry;
        if (!root.isConnected || root.parentElement !== parent) {
            drop(root);
            return;
        }
        if (!rendered(root)) {
            entry.handled = false;
            entry.button = null;
            return;
        }
        const button = getDeclineButton(root);
        if (!button) {
            entry.handled = false;
            entry.button = null;
            return;
        }
        if (entry.handled && entry.button === button) return;
        if (button.disabled || button.getAttribute("aria-disabled") === "true" || !rendered(button)) return;
        entry.handled = true;
        entry.button = button;
        attempts++;
        publish();
        try {
            button.click();
        } catch (_) {
            // 실패한 안내는 화면에 남긴다. 같은 표시 상태에서 재시도하지 않는다.
        }
        if (!root.isConnected) drop(root);
    }

    function consider(root) {
        if (
            !running ||
            !enabled() ||
            !(root instanceof HTMLElement) ||
            !root.isConnected ||
            !root.matches(BACKDROP) ||
            !(root.parentElement?.matches(PLAYER) || Array.from(root.children).some((child) => child.matches(LAYER)))
        )
            return;
        if (entries.has(root)) {
            inspect(entries.get(root));
            return;
        }
        if (entries.size >= 4) {
            // A complete measured guide takes priority over incomplete candidates, even while disabled.
            if (!getDeclineButton(root)) return;
            const invalid = Array.from(entries.keys()).find((candidate) => !getDeclineButton(candidate));
            if (!invalid) return;
            drop(invalid);
        }
        const entry = { root, parent: root.parentElement, observer: null, button: null, handled: false };
        entry.observer = new MutationObserver((mutations) => {
            if (hasNativeHideMutation(mutations, root)) {
                entry.handled = false;
                entry.button = null;
            }
            if (
                entry.button &&
                mutations.some((mutation) =>
                    Array.from(mutation.removedNodes || []).some(
                        (node) => node === entry.button || node.contains?.(entry.button)
                    )
                )
            )
                entry.handled = false;
            inspect(entry);
        });
        entries.set(root, entry);
        entry.observer.observe(root, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ["class", "style", "hidden", "aria-hidden", "disabled", "aria-disabled"],
        });
        for (let ancestor = entry.parent; ancestor; ancestor = ancestor.parentElement) {
            entry.observer.observe(ancestor, {
                attributes: true,
                attributeOldValue: true,
                attributeFilter: ["class", "style", "hidden", "aria-hidden"],
            });
        }
        inspect(entry);
    }

    function discover(node) {
        if (!(node instanceof Element)) return;
        if (node.matches(BACKDROP)) consider(node);
        for (const root of node.querySelectorAll(BACKDROP)) consider(root);
    }

    function onMutations(mutations) {
        if (route !== location.pathname) {
            onRoute();
            return;
        }
        if (!running || !enabled()) return;
        for (const mutation of mutations) {
            for (const node of mutation.removedNodes || []) {
                for (const root of entries.keys()) if (node === root || node.contains?.(root)) drop(root);
            }
        }
        for (const mutation of mutations) {
            const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
            const root = target?.closest(BACKDROP);
            if (root) consider(root);
            for (const node of mutation.addedNodes || []) discover(node);
        }
    }

    function stop() {
        running = false;
        observer?.disconnectAll?.();
        observer?.disconnect();
        observer = null;
        for (const root of entries.keys()) drop(root);
        publish();
    }

    function sync() {
        if (requested() && !removeRouteListener) removeRouteListener = startPageChangeDetection(onRoute);
        if (!requested() && removeRouteListener) {
            removeRouteListener();
            removeRouteListener = null;
        }
        if (!enabled()) {
            stop();
            return;
        }
        if (running) return;
        running = true;
        route = location.pathname;
        observer = createMutationObserverSync({ onMutations, onObserved: (_observer, target) => discover(target) });
        publish();
    }

    function onRoute() {
        if (route === location.pathname) return;
        route = location.pathname;
        stop();
        sync();
    }

    publish();
    bindFeatureOptions((value) => {
        options = value;
        sync();
    });
})();
