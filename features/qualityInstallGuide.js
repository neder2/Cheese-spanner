/**
 * 통합 팝업 제거 옵션의 고화질 설치 안내 닫기. 확인한 안내의 미설치 일반/기본 화질 선택만 누른다.
 * 2026-09-14/10-11 화면의 두 안내와 2026-10-17 공개 번들·한국어 locale의 기본 화질 분기를 확인한다.
 * isolated world. 설정이 로드된 뒤 라이브에서 동작하며 설치·재생 버튼이나 메타데이터는 다루지 않는다.
 * 전역 감시는 추가/제거된 하위 트리만 확인하고, 최대 4개의 안내와 조상 표시 속성만 관찰한다.
 */
(() => {
    const BACKDROP = '[class^="_dimmed_"], [class*=" _dimmed_"]';
    const LAYER = '[class^="_layer_"], [class*=" _layer_"]';
    const PLAYER = '[class^="_player_"], [class*=" _player_"]';
    const STATE_ATTR = "data-cheese-spanner-auto-quality-guide";
    const DIALOG = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    const ACTION =
        "button, a, input, select, textarea, summary, [role=button], [role=link], [tabindex], [contenteditable]";
    const BOUNDARY = `${BACKDROP}, ${LAYER}, ${PLAYER}, [role=dialog], [role=alertdialog], [aria-modal=true]`;
    const HELP_URL = "https://help.naver.com/alias/navergame/chzzk6.naver";
    const MAX_NODES = 80;
    const MAX_DEPTH = 8;
    const MAX_TEXT = 4096;
    const MAX_WRAPPERS = 2;
    // 문단·설치·미설치 선택의 짝을 유지하고 조사·어미만 제한적으로 허용한다.
    // lower 분기는 p2pMinScanline < 720일 때 함께 선택되는 공개 번들의 번역 키다.
    const GUIDES = [
        {
            message: /^고화질시청을위해(?:서는)?네이버라이브스트리밍커넥터가필요(?:합니다|해요)$/,
            install: /^설치하고고화질(?:로)?시청(?:하기)?$/,
            decline: /^설치없이일반화질(?:로)?시청(?:하기)?$/,
        },
        {
            message:
                /^크롬엣지브라우저에서고화질시청을위해(?:서는)?브라우저확장프로그램을(?:먼저)?설치(?:합니다|해주세요)$/,
            install: /^확장프로그램설치(?:하기)?$/,
            decline: /^설치없이일반화질(?:로)?시청(?:하기)?$/,
            help: true,
        },
        {
            message: /^더높은화질로시청하려면네이버라이브스트리밍커넥터가필요(?:합니다|해요)$/,
            install: /^설치하고더높은화질(?:로)?시청(?:하기)?$/,
            decline: /^설치없이기본화질(?:로)?시청(?:하기)?$/,
        },
        {
            message:
                /^크롬엣지브라우저에서더높은화질로시청하려면브라우저확장프로그램을(?:먼저)?설치(?:합니다|해주세요)$/,
            install: /^확장프로그램설치(?:하기)?$/,
            decline: /^설치없이기본화질(?:로)?시청(?:하기)?$/,
            help: true,
        },
    ];
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        normalizeCompact,
        startPageChangeDetection,
        hasNativeHideMutation,
    } = CheeseSpanner.utils;
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

    function label(text) {
        return normalizeCompact(text).replace(/[.,!·ㆍ'"‘’“”]/g, "");
    }

    function neutralWrapper(wrapper, child) {
        return (
            wrapper instanceof HTMLElement &&
            /^(DIV|SECTION)$/.test(wrapper.tagName) &&
            !wrapper.matches(`${BOUNDARY}, ${ACTION}, [role]`) &&
            wrapper.children.length === 1 &&
            wrapper.firstElementChild === child &&
            Array.from(wrapper.childNodes).every((node) => node === child || !node.textContent.trim())
        );
    }

    function playerFor(root) {
        let child = root;
        for (let depth = 0; depth <= MAX_WRAPPERS; depth++) {
            const parent = child.parentElement;
            if (parent?.matches(PLAYER)) return parent;
            if (!neutralWrapper(parent, child)) return null;
            child = parent;
        }
        return null;
    }

    function layerFor(root) {
        let parent = root;
        for (let depth = 0; depth <= MAX_WRAPPERS; depth++) {
            if (parent.children.length !== 1) return null;
            const child = parent.firstElementChild;
            if (Array.from(parent.childNodes).some((node) => node !== child && node.textContent.trim())) return null;
            if (child.matches(LAYER)) return child;
            if (!neutralWrapper(child, child.firstElementChild)) return null;
            parent = child;
        }
        return null;
    }

    function guideContents(layer) {
        const elements = [];
        const texts = new Map();
        let count = 0;
        let length = 0;
        let valid = true;
        function visit(node, depth, visible) {
            if (++count > MAX_NODES || depth > MAX_DEPTH) {
                valid = false;
                return "";
            }
            if (node.nodeType === Node.TEXT_NODE) {
                length += node.data.length;
                if (length > MAX_TEXT) valid = false;
                return visible ? node.data : "";
            }
            if (!(node instanceof Element)) return "";
            if (node !== layer && node.matches(BOUNDARY)) valid = false;
            if (node.matches("form, iframe, video, audio, script, style")) valid = false;
            elements.push(node);
            const shownHere = visible && shown(node);
            let text = "";
            for (const child of node.childNodes) {
                if (!valid) break;
                text += visit(child, depth + 1, shownHere);
            }
            texts.set(node, label(text));
            return text;
        }
        visit(layer, 0, true);
        return valid ? { elements, texts } : null;
    }

    function getDeclineButton(root) {
        if (!root.matches(BACKDROP) || root.matches("[role]") || root.closest(DIALOG) || !playerFor(root)) return null;
        const layer = layerFor(root);
        if (!layer || layer.matches("[role], [aria-modal=true]")) return null;
        const contents = guideContents(layer);
        if (!contents) return null;
        const { elements, texts } = contents;
        const actions = elements.filter((item) => item.matches(ACTION));
        const buttons = actions.filter((item) => item.tagName === "BUTTON");
        if (
            buttons.length !== 2 ||
            !buttons.every((item) => item.type === "button" && shown(item) && item.closest(BACKDROP) === root)
        )
            return null;
        const matches = elements.flatMap((node) => {
            if (actions.some((action) => node === action || node.contains(action) || action.contains(node))) return [];
            const guide = GUIDES.find(({ message }) => message.test(texts.get(node)));
            return guide ? [{ node, guide }] : [];
        });
        // Text wrappers may repeat the same evidence; separate messages must remain unambiguous.
        const messages = matches.filter(
            ({ node }) => !matches.some((other) => other.node !== node && node.contains(other.node))
        );
        if (messages.length !== 1) return null;
        const { guide } = messages[0];
        const otherActions = actions.filter((item) => !buttons.includes(item));
        if (
            otherActions.length > 1 ||
            otherActions.some(
                (item) => !guide.help || item.tagName !== "A" || item.href !== HELP_URL || item.hasAttribute("role")
            )
        )
            return null;
        const installs = buttons.filter((item) => guide.install.test(texts.get(item)));
        const declines = buttons.filter((item) => guide.decline.test(texts.get(item)));
        return installs.length === 1 && declines.length === 1 ? declines[0] : null;
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
            !(playerFor(root) || layerFor(root))
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
            attributeFilter: [
                "class",
                "style",
                "hidden",
                "aria-hidden",
                "disabled",
                "aria-disabled",
                "role",
                "aria-modal",
                "tabindex",
                "contenteditable",
                "type",
                "href",
            ],
        });
        for (let ancestor = entry.parent; ancestor; ancestor = ancestor.parentElement) {
            entry.observer.observe(ancestor, {
                attributes: true,
                attributeOldValue: true,
                attributeFilter: [
                    "class",
                    "style",
                    "hidden",
                    "aria-hidden",
                    "role",
                    "aria-modal",
                    "tabindex",
                    "contenteditable",
                ],
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
