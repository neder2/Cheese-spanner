/** 설정 패널 DOM·위치 관찰·목록 드래그·포커스 복원을 소유해요. */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const model = root.multiviewModel;
    const { el, text, button, delayButton, panelIcon } = root.multiviewView;
    const { STATES } = root.multiviewPlayback;
    const PANEL_ID = "betterchzzk-multiview-panel",
        CHAT = "aside#aside-chatting";
    function create({
        state,
        players,
        persistSession,
        onLayout: positionCells,
        onSwap: swap,
        equalLayout,
        onAction,
        onSubmit,
        onVisibility,
        cancelLayout,
    }) {
        const { moveSlotAudio } = players;
        let panel = null,
            panelId = null,
            panelAnchor = null,
            panelObserver = null;
        let host = null,
            routeId = null,
            chatButton = null,
            chatHeader = null,
            launcher = null;
        let panelDrag = null,
            panelScrollFrame = 0,
            panelNavigation = null,
            panelFocusId = null;
        let suppressPanelClick = false,
            generation = 0,
            message = "";
        function panelCells(cells = model.treeLayout(state.dockTree).cells) {
            return (
                cells
                    .filter((cell) => cell.id)
                    // Compare allocated rows first; round away floating-point noise at shared edges.
                    .sort(
                        (a, b) =>
                            Number(b.id === routeId) - Number(a.id === routeId) ||
                            Math.round(a.rect[1] * 1e6) - Math.round(b.rect[1] * 1e6) ||
                            a.rect[0] - b.rect[0]
                    )
            );
        }
        function syncPanelOrder(cells) {
            const list = panelId && panel?.querySelector(".bcmv-streams");
            if (!list) return;
            if (panelDrag && panelDrag.tree !== state.dockTree) endPanelDrag();
            const ordered = panelCells(cells);
            const focused = list.contains(document.activeElement) ? document.activeElement : null;
            const scrollTop = panel.scrollTop;
            for (const [index, cell] of ordered.entries()) {
                const row = list.querySelector(`[data-channel="${cell.id}"]`);
                if (row && row !== list.children[index]) list.insertBefore(row, list.children[index] || null);
                text(row?.querySelector(".bcmv-stream-role"), index ? `서브 ${index}` : "메인");
            }
            if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
            panel.scrollTop = scrollTop;
        }
        function focusPanelStream(id) {
            panel
                ?.querySelector(`.bcmv-stream[data-channel="${id}"] .bcmv-stream-move`)
                ?.focus({ preventScroll: true });
        }
        function validPanelDrag() {
            return (
                panelDrag &&
                state.active &&
                panel?.isConnected &&
                !panel.hidden &&
                panelDrag.generation === generation &&
                panelDrag.mainId === routeId &&
                panelDrag.tree === state.dockTree &&
                panel.contains(panelDrag.row)
            );
        }
        function endPanelDrag(event) {
            if (
                ["pointercancel", "lostpointercapture"].includes(event?.type) &&
                event.pointerId !== panelDrag?.pointerId
            )
                return;
            const gesture = panelDrag;
            panelDrag = null;
            if (panelScrollFrame) cancelAnimationFrame(panelScrollFrame);
            panelScrollFrame = 0;
            if (gesture?.started) suppressPanelClick = true;
            window.removeEventListener("pointermove", onPanelPointerMove, true);
            window.removeEventListener("pointerup", onPanelPointerUp, true);
            window.removeEventListener("pointercancel", endPanelDrag, true);
            window.removeEventListener("keydown", onPanelDragKey, true);
            window.removeEventListener("blur", endPanelDrag);
            panel?.removeEventListener("lostpointercapture", endPanelDrag);
            if (gesture && panel?.hasPointerCapture?.(gesture.pointerId))
                panel.releasePointerCapture(gesture.pointerId);
            panel?.removeAttribute("data-list-dragging");
            for (const row of panel?.querySelectorAll(".bcmv-stream") || []) {
                row.removeAttribute("data-moving");
                row.removeAttribute("data-drop");
                row.querySelector(".bcmv-stream-move")?.setAttribute("aria-pressed", "false");
            }
            text(panel?.querySelector("[data-bcmv-move-status]"), "");
        }
        function startPanelDrag(row, event, keyboard = false) {
            endPanelDrag();
            if (!state.active || state.channels.length < 2 || !panel?.contains(row)) return;
            panelDrag = {
                row,
                source: row.dataset.channel,
                target: null,
                x: event.clientX,
                y: event.clientY,
                pointerId: event.pointerId,
                keyboard,
                started: keyboard,
                generation,
                mainId: routeId,
                tree: state.dockTree,
            };
            focusPanelStream(panelDrag.source);
            window.addEventListener("keydown", onPanelDragKey, true);
            window.addEventListener("blur", endPanelDrag);
            if (keyboard) markPanelDrag();
            else {
                window.addEventListener("pointermove", onPanelPointerMove, true);
                window.addEventListener("pointerup", onPanelPointerUp, true);
                window.addEventListener("pointercancel", endPanelDrag, true);
                panel.addEventListener("lostpointercapture", endPanelDrag);
            }
        }
        function markPanelDrag() {
            panel.dataset.listDragging = "1";
            panelDrag.row.dataset.moving = "1";
            panelDrag.row.querySelector(".bcmv-stream-move").setAttribute("aria-pressed", "true");
        }
        function onPanelPointerDown(event) {
            suppressPanelClick = false;
            if (
                event.button !== 0 ||
                event.isPrimary === false ||
                event.altKey ||
                event.ctrlKey ||
                event.metaKey ||
                event.shiftKey
            )
                return;
            const row = event.target.closest(".bcmv-stream");
            const control = event.target.closest("button, select, label");
            if (!row || !panel?.contains(row) || (control && !control.matches(".bcmv-stream-move"))) return;
            event.preventDefault();
            event.stopPropagation();
            startPanelDrag(row, event);
        }
        function panelRowAt(event) {
            const bounds = panel.getBoundingClientRect();
            if (
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom
            )
                return null;
            // At most six owned rows; test their visible rectangles instead of the captured event target.
            return (
                [...panel.querySelectorAll(".bcmv-stream")].find((row) => {
                    const rect = row.getBoundingClientRect();
                    return (
                        rect.width > 0 &&
                        rect.height > 0 &&
                        event.clientX >= rect.left &&
                        event.clientX <= rect.right &&
                        event.clientY >= rect.top &&
                        event.clientY <= rect.bottom
                    );
                }) || null
            );
        }
        function setPanelDrop(row) {
            const id = row?.dataset.channel;
            panelDrag.target = id && id !== panelDrag.source ? id : null;
            for (const item of panel.querySelectorAll("[data-drop]")) item.removeAttribute("data-drop");
            if (!panelDrag.target) {
                text(panel.querySelector("[data-bcmv-move-status]"), "");
                return;
            }
            const ids = panelCells().map((cell) => cell.id);
            const main = panelDrag.source === routeId || id === routeId;
            row.dataset.drop = main ? "swap" : ids.indexOf(panelDrag.source) < ids.indexOf(id) ? "after" : "before";
            const name = players.get(id)?.name || id.slice(0, 8);
            text(
                panel.querySelector("[data-bcmv-move-status]"),
                main ? `${name} 방송과 메인 교체` : `${name} ${row.dataset.drop === "before" ? "앞" : "뒤"}으로 이동`
            );
        }
        function onPanelPointerMove(event) {
            if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
            if (!validPanelDrag()) {
                endPanelDrag();
                return;
            }
            if (!panelDrag.started) {
                if (Math.hypot(event.clientX - panelDrag.x, event.clientY - panelDrag.y) < 5) return;
                panelDrag.started = true;
                markPanelDrag();
                if (Number.isFinite(event.pointerId)) panel.setPointerCapture?.(event.pointerId);
            }
            event.preventDefault();
            event.stopPropagation();
            panelDrag.point = { clientX: event.clientX, clientY: event.clientY };
            setPanelDrop(panelRowAt(event));
            if (!panelScrollFrame) panelScrollFrame = requestAnimationFrame(scrollPanelDrag);
        }
        function scrollPanelDrag() {
            panelScrollFrame = 0;
            if (!validPanelDrag() || !panelDrag.point) return;
            const point = panelDrag.point,
                bounds = panel.getBoundingClientRect();
            if (
                point.clientX < bounds.left ||
                point.clientX > bounds.right ||
                point.clientY < bounds.top ||
                point.clientY > bounds.bottom
            )
                return;
            const direction = point.clientY < bounds.top + 24 ? -1 : point.clientY > bounds.bottom - 24 ? 1 : 0;
            const next = Math.max(
                0,
                Math.min(panel.scrollHeight - panel.clientHeight, panel.scrollTop + direction * 6)
            );
            if (!direction || next === panel.scrollTop) return;
            panel.scrollTop = next;
            setPanelDrop(panelRowAt(point));
            panelScrollFrame = requestAnimationFrame(scrollPanelDrag);
        }
        function commitPanelMove() {
            const gesture = validPanelDrag() && panelDrag;
            endPanelDrag();
            if (!gesture?.target) return;
            const { source, target } = gesture;
            if (source === routeId || target === routeId) {
                swap(source, target, true);
            } else {
                const ids = panelCells()
                    .map((cell) => cell.id)
                    .filter((id) => id !== routeId);
                const ordered = [...ids];
                ordered.splice(ids.indexOf(target), 0, ordered.splice(ids.indexOf(source), 1)[0]);
                const positions = new Map(ids.map((id, index) => [id, ordered[index]]));
                const next = model.mapTree(state.dockTree, (id) => positions.get(id) || id);
                moveSlotAudio(state.dockTree, next, source, target, "center");
                state.dockTree = next;
                state.customLayout = true;
                persistSession();
                positionCells();
            }
            focusPanelStream(source);
        }
        function onPanelPointerUp(event) {
            if (!panelDrag || event.pointerId !== panelDrag.pointerId) return;
            if (!validPanelDrag() || !panelDrag.started) {
                endPanelDrag();
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            setPanelDrop(panelRowAt(event));
            commitPanelMove();
        }
        function onPanelDragKey(event) {
            if (!panelDrag) return;
            if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                endPanelDrag();
                return;
            }
            if (event.key === "Tab") {
                endPanelDrag();
                return;
            }
            if (!panelDrag.keyboard || !["ArrowUp", "ArrowDown", " ", "Enter"].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (!validPanelDrag()) {
                endPanelDrag();
                return;
            }
            if (event.key === " " || event.key === "Enter") {
                commitPanelMove();
                return;
            }
            const rows = [...panel.querySelectorAll(".bcmv-stream")];
            const index = rows.findIndex((row) => row.dataset.channel === (panelDrag.target || panelDrag.source));
            const next = rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)))];
            next.scrollIntoView?.({ block: "nearest" });
            setPanelDrop(next);
        }
        function stopPanelTracking() {
            endPanelDrag();
            panelObserver?.disconnect();
            panelObserver = panelAnchor = null;
            window.removeEventListener("resize", positionPanel);
            window.removeEventListener("scroll", onPanelScroll, true);
            window.removeEventListener("pointerdown", onPanelOutside, true);
        }
        function positionPanel() {
            if (!panelId || !panel?.isConnected || !host) return;
            // 2026-09-06: the native live chat is aside#aside-chatting, beside the video in both T modes.
            const chat = document.querySelector(CHAT),
                chatBounds = chat?.getBoundingClientRect();
            const visibleChat =
                chatBounds?.width > 0 &&
                chatBounds.height > 0 &&
                chatBounds.bottom > 0 &&
                chatBounds.top < window.innerHeight;
            const anchor = visibleChat ? chat : host;
            const bounds = anchor.getBoundingClientRect();
            const width = Math.min(280, bounds.width > 16 ? bounds.width - 16 : 280, window.innerWidth - 16);
            const left = Math.max(8, Math.min(bounds.right - width - 8 || 8, window.innerWidth - width - 8));
            const headerBottom = visibleChat && chatHeader?.getBoundingClientRect().bottom;
            const anchorTop = headerBottom > bounds.top && headerBottom < bounds.bottom ? headerBottom : bounds.top;
            const top = Math.max(8, Math.min(anchorTop + 8, window.innerHeight - 128));
            panel.dataset.placement = visibleChat ? "chat" : "player";
            panel.style.left = left + "px";
            panel.style.top = top + "px";
            panel.style.width = Math.max(0, width) + "px";
            panel.style.maxHeight =
                Math.max(
                    0,
                    Math.min(
                        360,
                        window.innerHeight * 0.6,
                        (bounds.bottom || window.innerHeight) - top - 8,
                        window.innerHeight - top - 8
                    )
                ) + "px";
            if (panelAnchor !== anchor) {
                panelObserver?.disconnect();
                panelAnchor = anchor;
                if (typeof ResizeObserver === "function") {
                    panelObserver = new ResizeObserver(positionPanel);
                    panelObserver.observe(anchor);
                    if (anchor !== host) panelObserver.observe(host);
                }
            }
        }
        function onPanelScroll(event) {
            if (!(event.target instanceof Node) || !panel?.contains(event.target)) positionPanel();
        }
        function onPanelOutside(event) {
            if (panel?.contains(event.target) || chatButton?.contains(event.target)) return;
            renderPanel(null);
        }
        function closePanel() {
            renderPanel(null);
            (chatButton || launcher)?.focus({ preventScroll: true });
        }
        function renderPanel(id, focus = false) {
            panelId = id;
            chatButton?.setAttribute("aria-expanded", String(Boolean(id)));
            onVisibility(Boolean(id));
            if (!panel) return;
            stopPanelTracking();
            panel.replaceChildren();
            panel.hidden = !id;
            if (!id) {
                panelNavigation = panelFocusId = null;
                return;
            }
            const header = el("div", "bcmv-panel-header");
            const heading = el("h3", "", id === "add" ? "방송 추가" : "멀티뷰 설정");
            heading.id = PANEL_ID + "-title";
            const close = button("", "close-panel");
            close.append(panelIcon("close"));
            close.setAttribute("aria-label", "닫기");
            const tools = el("div", "bcmv-panel-tools");
            if (id !== "add") {
                const add = button("", "add");
                add.append(panelIcon("add"));
                add.setAttribute("aria-label", "방송 추가");
                add.title = "방송 추가";
                tools.append(add);
            }
            tools.append(close);
            header.append(heading, tools);
            panel.append(header);
            if (id === "add") {
                const form = el("form"),
                    label = el("label", "", "라이브 URL"),
                    input = el("input");
                input.type = "url";
                input.required = true;
                input.name = "liveUrl";
                input.placeholder = "https://chzzk.naver.com/live/…";
                label.append(input);
                const submit = button("추가", "submit-add");
                submit.type = "submit";
                form.append(label, submit);
                panel.append(form);
            } else {
                const actions = el("div", "bcmv-actions");
                const equalize = button("보조 방송 정렬", "equalize-layout");
                equalize.prepend(panelIcon("align"));
                equalize.disabled = !equalLayout();
                equalize.title = equalize.disabled
                    ? "같은 영역에 보조 방송이 2개 이상 있을 때 사용할 수 있어요."
                    : "메인 영역을 유지하고 모든 보조 영역의 방송들을 영역별로 같은 크기로 정렬해요.";
                const reset = button("기본 배치", "reset-layout");
                reset.prepend(panelIcon("layout"));
                actions.append(reset, equalize);
                panel.append(actions);
                const list = el("ul", "bcmv-streams");
                list.setAttribute("aria-label", "방송 배치 목록");
                for (const entry of state.channels) {
                    const row = el("li", "bcmv-stream");
                    row.dataset.channel = entry.id;
                    if (entry.id === routeId) row.dataset.main = "1";
                    const move = button("", "move-stream", entry.id);
                    move.className = "bcmv-stream-move";
                    move.title = "드래그로 위치 변경 · Space로 선택, ↑↓로 대상 이동, Enter로 적용";
                    move.setAttribute("aria-pressed", "false");
                    move.disabled = state.channels.length < 2;
                    const grip = el("span", "bcmv-stream-grip");
                    grip.setAttribute("aria-hidden", "true");
                    move.append(
                        grip,
                        el("span", "bcmv-stream-role"),
                        el("span", "bcmv-stream-name", players.get(entry.id)?.name || entry.id.slice(0, 8))
                    );
                    row.append(move);
                    list.append(row);
                    if (entry.id === routeId) {
                        row.append(el("p", "bcmv-quality-main", "화질은 메인 플레이어에서 조절해요."));
                        continue;
                    }
                    const qualityLabel = el("label", "bcmv-quality"),
                        quality = el("select");
                    quality.setAttribute("aria-label", `${players.get(entry.id)?.name || entry.id} 화질`);
                    quality.addEventListener("change", (event) => {
                        if (!event.isTrusted || !panel?.contains(quality)) return;
                        const player = players.get(entry.id);
                        if (player) players.setQuality(player, Number(quality.value));
                    });
                    const qualityControl = el("span", "bcmv-quality-control");
                    qualityControl.append(quality);
                    qualityLabel.append(el("span", "bcmv-quality-caption", "화질"), qualityControl);
                    const qualityStatus = el("span", "bcmv-quality-status");
                    qualityStatus.setAttribute("role", "status");
                    qualityLabel.append(qualityStatus);
                    row.append(qualityLabel);
                    const timing = el("span", "bcmv-stream-timing"),
                        latency = el("span");
                    latency.setAttribute("data-bcmv-latency", "");
                    latency.title = "플레이어의 라이브 기준으로 측정한 현재 추정 지연이에요.";
                    const delay = el("span");
                    delay.setAttribute("data-bcmv-delay", "");
                    timing.append(latency, delay);
                    const status = el("p");
                    status.setAttribute("data-bcmv-status", "");
                    const remove = button("", "remove", entry.id);
                    remove.append(panelIcon("remove"));
                    remove.title = "방송 제거";
                    const sync = el("div", "bcmv-stream-sync"),
                        detail = el("div", "bcmv-stream-detail");
                    sync.setAttribute("role", "group");
                    sync.append(delayButton(-0.1, entry.id), delayButton(0.1, entry.id));
                    detail.append(sync, status);
                    row.append(timing, remove, detail);
                }
                panel.append(list);
                syncPanelOrder();
                if (state.channels.length === 1) panel.append(el("p", "bcmv-notice", "추가한 서브 방송이 없어요."));
                const moveStatus = el("p", "bcmv-move-status");
                moveStatus.setAttribute("data-bcmv-move-status", "");
                moveStatus.setAttribute("role", "status");
                panel.append(moveStatus);
                for (const player of players.values()) updatePlayer(player);
            }
            const status = el("p", "bcmv-notice", message);
            status.setAttribute("data-bcmv-notice", "");
            status.setAttribute("role", "status");
            panel.append(status);
            positionPanel();
            window.addEventListener("resize", positionPanel);
            window.addEventListener("scroll", onPanelScroll, true);
            window.addEventListener("pointerdown", onPanelOutside, true);
            if (focus) (panel.querySelector('input[name="liveUrl"]') || close).focus({ preventScroll: true });
            if (panelFocusId) {
                focusPanelStream(panelFocusId);
                panelFocusId = null;
            }
        }
        function updatePlayer(player) {
            const row = panelId && panel?.querySelector(`.bcmv-stream[data-channel="${player.id}"]`);
            if (!row) return;
            const name = player.name || player.id.slice(0, 8);
            text(row.querySelector(".bcmv-stream-name"), name);
            row.querySelector(".bcmv-stream-name").title = name;
            row.querySelector(".bcmv-stream-move").setAttribute(
                "aria-label",
                `${player.main ? "메인" : "서브"} ${name} 위치 변경`
            );
            row.querySelector('[data-action="remove"]')?.setAttribute("aria-label", `${name} 제거`);
            if (player.main) return;
            const quality = row.querySelector(".bcmv-quality select");
            const heights = [...players.qualityLevels(player).keys()].sort((a, b) => b - a);
            const signature = heights.join(",");
            if (quality.dataset.levels !== signature) {
                quality.dataset.levels = signature;
                quality.replaceChildren(
                    ...[0, ...heights].map((height) => {
                        const option = el("option", "", height ? `${height}p` : "자동");
                        option.value = String(height);
                        return option;
                    })
                );
            }
            quality.value = String(heights.includes(player.quality) ? player.quality : 0);
            quality.disabled = !player.qualityLoaded || !heights.length;
            text(
                row.querySelector(".bcmv-quality-status"),
                player.qualityError ||
                    (player.qualitySaving
                        ? "저장 중"
                        : !player.qualityLoaded
                          ? "설정 읽기 대기"
                          : !heights.length
                            ? "화질 정보 대기"
                            : player.quality && !heights.includes(player.quality)
                              ? `저장된 ${player.quality}p 미제공 · 자동 재생`
                              : "")
            );
            row.querySelector(".bcmv-stream-sync").setAttribute("aria-label", `${name} 싱크 조절`);
            for (const control of row.querySelectorAll("[data-delta]")) control.disabled = !player.loaded;
            const delay = row.querySelector("[data-bcmv-delay]");
            const timing = !player.error && players.measureTiming(player);
            text(
                row.querySelector("[data-bcmv-latency]"),
                timing ? `현재 ${timing.latency.toFixed(1)}s` : "현재 측정 대기"
            );
            text(
                delay,
                player.loaded
                    ? `저장 ${player.savedDelay.toFixed(1)}s${player.savedBasis === "legacy" ? " · 이전 기준" : ""}${player.saving ? " · 저장 중" : ""}`
                    : player.saveError
                      ? "저장값 확인 불가"
                      : "저장값 불러오는 중"
            );
            const status = row.querySelector("[data-bcmv-status]"),
                statusText = player.saveError || player.error || STATES[player.status];
            text(status, statusText);
            status.title = statusText;
            delay.title = timing
                ? `현재 추정 지연 ${timing.latency.toFixed(1)}초`
                : "지연 측정 대기 · 라이브 시간 정보 확인 중";
        }
        function onKey(event) {
            const move = event.target.closest(".bcmv-stream-move");
            if (move && panel?.contains(move) && (event.key === " " || event.key === "Enter")) {
                event.preventDefault();
                event.stopPropagation();
                if (!move.disabled) startPanelDrag(move.closest(".bcmv-stream"), event, true);
                return;
            }
            if (event.key === "Escape" && panelId) {
                event.preventDefault();
                event.stopPropagation();
                if (!cancelLayout()) closePanel();
                return;
            }
        }

        function onClick(event) {
            if (suppressPanelClick && event.detail !== 0) {
                suppressPanelClick = false;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            onAction(event);
        }
        function mount() {
            if (panel?.isConnected) return;
            release();
            panel = el("div", "bcmv-panel");
            panel.id = PANEL_ID;
            panel.hidden = true;
            panel.setAttribute("role", "dialog");
            panel.setAttribute("aria-labelledby", PANEL_ID + "-title");
            panel.addEventListener("click", onClick, true);
            panel.addEventListener("submit", onSubmit);
            panel.addEventListener("keydown", onKey);
            panel.addEventListener("pointerdown", onPanelPointerDown, true);
            document.body.append(panel);
        }
        function setContext(context) {
            if (routeId !== context.routeId) endPanelDrag();
            ({ host, routeId, chatButton, chatHeader, launcher } = context);
            positionPanel();
        }
        function release() {
            stopPanelTracking();
            panel?.removeEventListener("click", onClick, true);
            panel?.removeEventListener("submit", onSubmit);
            panel?.removeEventListener("keydown", onKey);
            panel?.removeEventListener("pointerdown", onPanelPointerDown, true);
            panel?.remove();
            panel = null;
            host = chatButton = chatHeader = launcher = null;
        }
        function clear() {
            release();
            generation += 1;
            panelId = panelNavigation = panelFocusId = null;
        }
        function prepareNavigation(to, focusId) {
            panelNavigation = { from: routeId, to, generation, focusId };
        }
        function routeNavigation(next) {
            return panelId &&
                panelNavigation?.from === routeId &&
                panelNavigation.to === next &&
                panelNavigation.generation === generation
                ? panelNavigation
                : null;
        }
        function restoreNavigation(navigation) {
            if (!navigation) return;
            panelId = navigation.from;
            panelFocusId = navigation.focusId;
        }
        function cancelPointer() {
            if (!panelDrag) return false;
            endPanelDrag();
            return true;
        }
        return {
            mount,
            setContext,
            release,
            clear,
            show: renderPanel,
            close: closePanel,
            position: positionPanel,
            syncOrder: syncPanelOrder,
            updatePlayer,
            cancelPointer,
            prepareNavigation,
            routeNavigation,
            restoreNavigation,
            cancelNavigation() {
                panelNavigation = null;
            },
            get id() {
                return panelId;
            },
            contains: (node) => Boolean(panel?.contains(node)),
            notice(value) {
                message = value;
                text(panel?.querySelector("[data-bcmv-notice]"), value);
            },
            focusAction(action) {
                panel?.querySelector('[data-action="' + action + '"]')?.focus({ preventScroll: true });
            },
            afterRemove(id) {
                if (panelId === id) panelId = state.channels[1]?.id || "settings";
            },
            focusAfterRemove() {
                (
                    panel?.querySelector('[data-action="remove"]') ||
                    panel?.querySelector('[data-action="close-panel"]')
                )?.focus({ preventScroll: true });
            },
        };
    }
    root.multiviewSettingsPanel = { create };
})();
