/** 화면 배치·드래그·리사이즈와 해당 포인터/키보드 리소스를 소유해요. */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const model = root.multiviewModel;
    const { el, text } = root.multiviewView;
    function create({ state, players, persistSession, onOrder: syncPanelOrder, onSwap: swap }) {
        const { current, moveSlotAudio } = players;
        let host = null,
            native = null,
            overlay = null,
            routeId = null;
        let dragId = null,
            dragState = null,
            pointerDrag = null,
            suppressDragClick = false,
            resize = null;
        function boxRect(id, rect, bounds = host?.getBoundingClientRect()) {
            const video = players.get(id)?.video;
            if (!bounds?.width || !bounds.height) return rect;
            const ratio =
                video?.videoWidth > 0 && video?.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
            const [x, y, w, h] = rect;
            const width = Math.min(w, (h * bounds.height * ratio) / bounds.width);
            const height = Math.min(h, (w * bounds.width) / ratio / bounds.height);
            const position = (pointerDrag?.player.id === id && pointerDrag.position) ||
                state.channels.find((entry) => entry.id === id)?.position || [0.5, 0.5];
            return [x + (w - width) * position[0], y + (h - height) * position[1], width, height];
        }
        function positionCells(tree = state.dockTree) {
            if (!overlay || !host || !tree) return;
            const layout = model.treeLayout(tree);
            const bounds = host.getBoundingClientRect();
            for (const cell of overlay.querySelectorAll(".bcmv-cell")) {
                const id = cell.dataset.bcmvChannel,
                    leaf = layout.cells.find((item) => item.id === id);
                if (!leaf) continue;
                const [x, y, w, h] = boxRect(id, leaf.rect, bounds);
                Object.assign(cell.style, {
                    left: x * 100 + "%",
                    top: y * 100 + "%",
                    width: w * 100 + "%",
                    height: h * 100 + "%",
                });
                if (id === routeId) {
                    host.style.setProperty("--bcmv-main-left", x * 100 + "%");
                    host.style.setProperty("--bcmv-main-top", y * 100 + "%");
                    host.style.setProperty("--bcmv-main-width", w * 100 + "%");
                    host.style.setProperty("--bcmv-main-height", String(h));
                }
                if (!dragState) {
                    for (const corner of ["nw", "ne", "sw", "se"]) {
                        const existing = cell.querySelector(`[data-corner="${corner}"]`);
                        if (!cornerEdges(id, corner, tree).length) {
                            existing?.remove();
                            continue;
                        }
                        if (existing) continue;
                        const grip = el("div", "bcmv-corner");
                        grip.dataset.corner = corner;
                        grip.tabIndex = 0;
                        grip.setAttribute("role", "button");
                        const label = { nw: "왼쪽 위", ne: "오른쪽 위", sw: "왼쪽 아래", se: "오른쪽 아래" }[corner];
                        grip.setAttribute("aria-label", `${label} 모서리 크기 조절`);
                        cell.append(grip);
                    }
                }
            }
            if (dragState) return;
            const grid = overlay.querySelector(".bcmv-grid");
            for (const handle of grid.querySelectorAll(".bcmv-separator"))
                if (!layout.handles.some((item) => item.key === handle.dataset.path)) handle.remove();
            for (const item of layout.handles) {
                let handle = grid.querySelector('[data-path="' + item.key + '"]');
                if (!handle) {
                    handle = el("div", "bcmv-separator");
                    handle.dataset.path = item.key;
                    handle.dataset.axis = item.axis;
                    handle.tabIndex = 0;
                    handle.setAttribute("role", "separator");
                    handle.setAttribute(
                        "aria-label",
                        item.axis === "columns" ? "세로 경계 크기 조절" : "가로 경계 크기 조절"
                    );
                    handle.setAttribute("aria-orientation", item.axis === "columns" ? "vertical" : "horizontal");
                    grid.append(handle);
                }
                if (handle.dataset.axis !== item.axis) {
                    handle.style.cssText = "";
                    handle.dataset.axis = item.axis;
                    handle.setAttribute(
                        "aria-label",
                        item.axis === "columns" ? "세로 경계 크기 조절" : "가로 경계 크기 조절"
                    );
                    handle.setAttribute("aria-orientation", item.axis === "columns" ? "vertical" : "horizontal");
                }
                handle.setAttribute("aria-valuenow", String(Math.round(item.value * 100)));
                handle.setAttribute("aria-valuemin", String(Math.round(item.lower * 100)));
                handle.setAttribute("aria-valuemax", String(Math.round(item.upper * 100)));
                Object.assign(
                    handle.style,
                    item.axis === "columns"
                        ? {
                              left: item.position * 100 + "%",
                              top: item.start * 100 + "%",
                              height: item.length * 100 + "%",
                          }
                        : {
                              top: item.position * 100 + "%",
                              left: item.start * 100 + "%",
                              width: item.length * 100 + "%",
                          }
                );
            }
            if (!pointerDrag && !resize && tree === state.dockTree) syncPanelOrder(layout.cells);
        }
        function cornerEdges(id, corner, tree = state.dockTree) {
            const layout = model.treeLayout(tree),
                leaf = layout.cells.find((item) => item.id === id);
            if (!leaf) return [];
            const [x, y, w, h] = leaf.rect;
            return ["columns", "rows"]
                .map((axis) => {
                    const value =
                        axis === "columns" ? (corner.includes("e") ? x + w : x) : corner.includes("s") ? y + h : y;
                    const middle = axis === "columns" ? y + h / 2 : x + w / 2;
                    return layout.handles
                        .filter(
                            (handle) =>
                                handle.axis === axis &&
                                Math.abs(handle.position - value) < 1e-7 &&
                                middle >= handle.start &&
                                middle <= handle.start + handle.length
                        )
                        .sort((a, b) => b.key.length - a.key.length)[0];
                })
                .filter(Boolean);
        }
        function adjustSplit(path, value) {
            const handle = model.treeLayout(state.dockTree).handles.find((item) => item.key === path);
            if (!handle) return;
            state.dockTree = model.resizeTree(
                state.dockTree,
                path,
                Math.min(handle.upper, Math.max(handle.lower, value))
            );
            state.customLayout = true;
            positionCells();
        }
        function endDrag() {
            const active = Boolean(dragState || pointerDrag?.position);
            if (active) suppressDragClick = true;
            const gesture = pointerDrag;
            pointerDrag = null;
            window.removeEventListener("pointermove", onPointerMove, true);
            window.removeEventListener("pointerup", onPointerUp, true);
            window.removeEventListener("pointercancel", onPointerCancel, true);
            window.removeEventListener("keydown", onDragKey, true);
            overlay?.removeEventListener("lostpointercapture", onPointerCancel);
            if (gesture && overlay?.hasPointerCapture?.(gesture.pointerId))
                overlay.releasePointerCapture(gesture.pointerId);
            dragId = null;
            dragState?.guide.remove();
            dragState = null;
            gesture?.guide?.remove();
            host?.removeAttribute("data-bcmv-positioning");
            overlay?.removeAttribute("data-dragging");
            overlay?.querySelectorAll("[data-drag-source]").forEach((cell) => cell.removeAttribute("data-drag-source"));
            window.removeEventListener("blur", endDrag);
            if (active) positionCells();
        }
        function onPointerDown(event) {
            if (!state.active || !overlay) return;
            suppressDragClick = false;
            if (event.target.closest(".bcmv-corner")) {
                onCornerStart(event);
                return;
            }
            if (event.target.closest(".bcmv-separator")) {
                onResizeStart(event);
                return;
            }
            if (event.button !== 0 || event.isPrimary === false || resize) return;
            let origin = event.target.closest("video[data-bcmv-video], .bcmv-name");
            if (
                !origin &&
                native.contains(event.target) &&
                (event.target.closest(".pzp-pc__video, .webplayer-internal-video") ||
                    event.target === native ||
                    event.target.matches(".pzp-pc")) &&
                !event.target.closest(
                    'button, a, input, select, textarea, [role="button"], [role="slider"], [role="menu"]'
                )
            )
                origin = native;
            const player = origin && players.get(origin === native ? routeId : origin.dataset.channel);
            if (!player || (player.main && !event.altKey && state.channels.length < 2) || !current(player)) return;
            endDrag();
            const bounds = host.getBoundingClientRect(),
                leaf = model.treeLayout(state.dockTree).cells.find((item) => item.id === player.id);
            const entry = state.channels.find((item) => item.id === player.id);
            const fitted = leaf && boxRect(player.id, leaf.rect, bounds);
            if (event.altKey && (!fitted || !bounds.width || !bounds.height)) return;
            pointerDrag = {
                player,
                x: event.clientX,
                y: event.clientY,
                pointerId: event.pointerId,
                started: false,
                internal: event.altKey,
                initial: [...(entry.position || [0.5, 0.5])],
                space: fitted && [
                    (leaf.rect[2] - fitted[2]) * bounds.width,
                    (leaf.rect[3] - fitted[3]) * bounds.height,
                ],
                region: leaf?.rect,
                locks: [null, null],
            };
            if (event.altKey) {
                event.preventDefault();
                event.stopPropagation();
            }
            window.addEventListener("pointermove", onPointerMove, true);
            window.addEventListener("pointerup", onPointerUp, true);
            window.addEventListener("pointercancel", onPointerCancel, true);
            window.addEventListener("keydown", onDragKey, true);
            window.addEventListener("blur", endDrag);
        }
        function onDragKey(event) {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            endDrag();
        }
        function onHostClick(event) {
            if (!suppressDragClick || event.detail <= 0) return;
            suppressDragClick = false;
            event.preventDefault();
            event.stopPropagation();
        }
        function onNativeDragStart(event) {
            if (pointerDrag?.player.main) event.preventDefault();
        }
        function moveWithinBox(event) {
            const gesture = pointerDrag;
            const delta = [event.clientX - gesture.x, event.clientY - gesture.y];
            gesture.position = gesture.initial.map((coordinate, axis) => {
                const space = gesture.space[axis];
                if (space < 0.5) return coordinate;
                const raw = Math.max(0, Math.min(1, coordinate + delta[axis] / space));
                const locked = gesture.locks[axis];
                const snap =
                    locked !== null && Math.abs(raw - locked) * space <= 14
                        ? locked
                        : [0, 0.5, 1].find((value) => Math.abs(raw - value) * space <= 8);
                gesture.locks[axis] = snap ?? null;
                return snap ?? raw;
            });
            positionCells();
        }
        function beginDrag(player) {
            dragId = player.id;
            const grid = overlay.querySelector(".bcmv-grid"),
                guide = el("div", "bcmv-drop-preview");
            guide.append(el("span", "", "여기로 이동"));
            guide.hidden = true;
            guide.setAttribute("aria-hidden", "true");
            grid.append(guide);
            dragState = {
                source: dragId,
                rect: grid.getBoundingClientRect(),
                cells: model
                    .treeLayout(state.dockTree)
                    .cells.map((leaf) => ({ ...leaf, hitRect: leaf.id ? boxRect(leaf.id, leaf.rect) : leaf.rect })),
                tree: state.dockTree,
                target: null,
                guide,
            };
            overlay.querySelector(`[data-bcmv-channel="${player.id}"]`).setAttribute("data-drag-source", "");
            overlay.setAttribute("data-dragging", "");
        }
        function dragTarget(event) {
            if (!dragState) return null;
            const { rect, cells } = dragState;
            let leaf,
                rx = 0.5,
                ry = 0.5;
            if (rect.width > 0 && rect.height > 0) {
                const x = (event.clientX - rect.left) / rect.width,
                    y = (event.clientY - rect.top) / rect.height;
                leaf =
                    cells.find(({ hitRect: [l, t, w, h] }) => x >= l && x < l + w && y >= t && y < t + h) ||
                    cells.find(({ rect: [l, t, w, h] }) => x >= l && x < l + w && y >= t && y < t + h);
                if (leaf) {
                    rx = (x - leaf.hitRect[0]) / leaf.hitRect[2];
                    ry = (y - leaf.hitRect[1]) / leaf.hitRect[3];
                }
            } else {
                const id = event.target.closest?.("[data-bcmv-channel]")?.dataset.bcmvChannel;
                leaf = cells.find((item) => item.id === id);
            }
            if (!leaf || leaf.id === dragId) return null;
            if (dragId === routeId) {
                const move = model.moveMainTree(dragState.tree, routeId, leaf.id, leaf.path);
                return move ? { ...leaf, ...move, key: "main:" + move.path, mainMove: true } : null;
            }
            const edges = [
                ["left", rx],
                ["right", 1 - rx],
                ["top", ry],
                ["bottom", 1 - ry],
            ].sort((a, b) => a[1] - b[1]);
            const side = leaf.id === null ? "fill" : edges[0][1] < 0.25 ? edges[0][0] : "center";
            return { ...leaf, side, key: leaf.path + ":" + side };
        }
        function previewDrop(target) {
            if (!dragState || dragState.target?.key === target?.key) return;
            dragState.target = target;
            const { guide, source, tree } = dragState;
            if (!target) {
                guide.hidden = true;
                positionCells(tree);
                return;
            }
            const main = target.id === routeId && target.side === "center";
            const next = target.mainMove
                ? target.tree
                : main
                  ? tree
                  : model.dockTree(tree, source, target.id, target.side, routeId, target.path);
            if (!model.validTree(next, state.channels)) {
                guide.hidden = true;
                return;
            }
            dragState.previewTree = next;
            positionCells(next);
            const allocated = main ? target.rect : model.treeLayout(next).cells.find((leaf) => leaf.id === source).rect;
            const [x, y, width, height] = boxRect(main ? routeId : source, allocated);
            Object.assign(guide.style, {
                left: x * 100 + "%",
                top: y * 100 + "%",
                width: width * 100 + "%",
                height: height * 100 + "%",
            });
            const labels = {
                left: "왼쪽에 배치",
                right: "오른쪽에 배치",
                top: "위에 배치",
                bottom: "아래에 배치",
                fill: "빈 공간에 배치",
                center: "이 위치로 이동",
            };
            text(
                guide.firstElementChild,
                main ? "메인으로 전환" : target.mainMove ? `메인 ${labels[target.side]}` : labels[target.side]
            );
            guide.hidden = false;
        }
        function onPointerMove(event) {
            const gesture = pointerDrag;
            if (!gesture || gesture.pointerId !== event.pointerId) return;
            if (!current(gesture.player)) {
                endDrag();
                return;
            }
            if (!gesture.started) {
                if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 5) return;
                gesture.started = true;
                if (gesture.internal) {
                    const [x, y, width, height] = gesture.region;
                    gesture.guide = el("div", "bcmv-position-guide", "박스 안 이동 · 우클릭 취소");
                    Object.assign(gesture.guide.style, {
                        left: x * 100 + "%",
                        top: y * 100 + "%",
                        width: width * 100 + "%",
                        height: height * 100 + "%",
                    });
                    overlay.append(gesture.guide);
                    host.setAttribute("data-bcmv-positioning", "");
                } else beginDrag(gesture.player);
                overlay.addEventListener("lostpointercapture", onPointerCancel);
                if (typeof overlay.setPointerCapture === "function") overlay.setPointerCapture(event.pointerId);
            }
            event.preventDefault();
            event.stopPropagation();
            if (gesture.internal) moveWithinBox(event);
            else previewDrop(dragTarget(event));
        }
        function onPointerCancel(event) {
            if (pointerDrag?.pointerId === event.pointerId) endDrag();
        }
        function onPointerUp(event) {
            if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
            if (pointerDrag.internal) {
                const gesture = pointerDrag;
                if (gesture.started && current(gesture.player)) {
                    moveWithinBox(event);
                    const entry = state.channels.find((item) => item.id === gesture.player.id);
                    if (entry) entry.position = [...gesture.position];
                }
                event.preventDefault();
                event.stopPropagation();
                endDrag();
                suppressDragClick = true;
                if (gesture.started && current(gesture.player)) persistSession();
                return;
            }
            const target = dragTarget(event);
            const started = pointerDrag.started;
            if (started) {
                event.preventDefault();
                event.stopPropagation();
                suppressDragClick = true;
            }
            const source = dragId;
            const next =
                started && target
                    ? target.mainMove
                        ? target.tree
                        : model.dockTree(state.dockTree, source, target.id, target.side, routeId, target.path)
                    : null;
            endDrag();
            if (started && target) {
                if (target.id === routeId && target.side === "center") swap(source, target.id);
                else if (model.validTree(next, state.channels)) {
                    moveSlotAudio(state.dockTree, next, source, target.id, target.mainMove ? "group" : target.side);
                    state.dockTree = next;
                    state.customLayout = true;
                    positionCells();
                    persistSession();
                }
            }
        }
        function onResizeStart(event) {
            const handle = event.target.closest(".bcmv-separator");
            if (!handle || event.button !== 0 || dragId) return;
            event.preventDefault();
            cancelResize();
            handle.focus({ preventScroll: true });
            const guide = el("div", "bcmv-snap-guide");
            guide.dataset.axis = handle.dataset.axis;
            guide.hidden = true;
            overlay.querySelector(".bcmv-grid").append(guide);
            resize = {
                handle: model.treeLayout(state.dockTree).handles.find((item) => item.key === handle.dataset.path),
                rect: overlay.querySelector(".bcmv-grid").getBoundingClientRect(),
                tree: state.dockTree,
                custom: state.customLayout,
                pointerId: event.pointerId,
                locked: null,
                guide,
            };
            window.addEventListener("pointermove", onResizeMove);
            window.addEventListener("pointerup", endResize);
            window.addEventListener("pointercancel", cancelResize);
            window.addEventListener("blur", cancelResize);
        }
        function onCornerStart(event) {
            if (event.button !== 0 || dragId) return;
            const corner = event.target.closest(".bcmv-corner"),
                id = corner.closest(".bcmv-cell").dataset.bcmvChannel;
            const edges = cornerEdges(id, corner.dataset.corner);
            if (!edges.length) return;
            event.preventDefault();
            cancelResize();
            const grid = overlay.querySelector(".bcmv-grid"),
                guide = el("div", "bcmv-snap-guide");
            guide.hidden = true;
            guide.dataset.axis = edges[0].axis;
            grid.append(guide);
            const leaf = model.treeLayout(state.dockTree).cells.find((item) => item.id === id);
            resize = {
                corner: corner.dataset.corner,
                edges,
                leaf: leaf.rect,
                startX: event.clientX,
                startY: event.clientY,
                rect: grid.getBoundingClientRect(),
                tree: state.dockTree,
                custom: state.customLayout,
                pointerId: event.pointerId,
                locked: null,
                guide,
            };
            window.addEventListener("pointermove", onResizeMove);
            window.addEventListener("pointerup", endResize);
            window.addEventListener("pointercancel", cancelResize);
            window.addEventListener("blur", cancelResize);
            overlay.tabIndex = -1;
            overlay.focus({ preventScroll: true });
        }
        function onCornerMove(event) {
            const { leaf, rect, corner, tree, edges, startX, startY } = resize;
            const dx = ((event.clientX - startX) / rect.width) * (corner.includes("e") ? 1 : -1),
                dy = ((event.clientY - startY) / rect.height) * (corner.includes("s") ? 1 : -1);
            const delta = Math.abs(dx / leaf[2]) > Math.abs(dy / leaf[3]) ? dx / leaf[2] : dy / leaf[3];
            const scale = Math.max(0.1, 1 + delta);
            let next = tree;
            resize.guide.hidden = true;
            for (const old of edges) {
                const current = model.treeLayout(next).handles.find((item) => item.key === old.key);
                if (!current) continue;
                const vertical = old.axis === "columns",
                    span = vertical ? leaf[2] : leaf[3],
                    sign = vertical ? (corner.includes("e") ? 1 : -1) : corner.includes("s") ? 1 : -1;
                const position = old.position + span * (scale - 1) * sign;
                const raw = (position - current.region[vertical ? 0 : 1]) / current.region[vertical ? 2 : 3];
                const result = model.snapRatio(
                    current,
                    raw,
                    (vertical ? rect.width : rect.height) * current.region[vertical ? 2 : 3],
                    null,
                    old.value
                );
                next = model.resizeTree(next, old.key, result.value);
                if (result.locked !== null) {
                    resize.guide.dataset.axis = old.axis;
                    resize.guide.style.cssText = "";
                    resize.guide.style[vertical ? "left" : "top"] =
                        (current.region[vertical ? 0 : 1] + current.region[vertical ? 2 : 3] * result.value) * 100 +
                        "%";
                    resize.guide.hidden = false;
                }
            }
            state.dockTree = next;
            state.customLayout = true;
            positionCells();
        }
        function onResizeMove(event) {
            if (!resize || event.pointerId !== resize.pointerId) return;
            if (resize.corner) {
                onCornerMove(event);
                return;
            }
            const { handle, rect } = resize,
                axis = handle.axis;
            const horizontal = axis === "columns",
                region = handle.region;
            const pixels = (horizontal ? rect.width : rect.height) * (horizontal ? region[2] : region[3]);
            const start =
                (horizontal ? rect.left : rect.top) + (horizontal ? rect.width * region[0] : rect.height * region[1]);
            const raw = ((horizontal ? event.clientX : event.clientY) - start) / pixels;
            const result = model.snapRatio(handle, raw, pixels, resize.locked, handle.value);
            resize.locked = result.locked;
            resize.guide.hidden = result.locked === null;
            resize.guide.style[horizontal ? "left" : "top"] =
                ((horizontal ? region[0] : region[1]) + (horizontal ? region[2] : region[3]) * result.value) * 100 +
                "%";
            adjustSplit(handle.key, result.value);
        }
        function cancelResize(event) {
            if (resize && event?.type === "pointercancel" && event.pointerId !== resize.pointerId) return;
            if (resize) {
                state.dockTree = resize.tree;
                state.customLayout = resize.custom;
                positionCells();
            }
            endResize(false);
        }
        function endResize(commit = true) {
            if (resize && typeof commit === "object" && commit.pointerId !== resize.pointerId) return;
            const changed = resize && commit !== false;
            if (changed) persistSession();
            resize?.guide.remove();
            resize = null;
            if (changed) syncPanelOrder();
            window.removeEventListener("pointermove", onResizeMove);
            window.removeEventListener("pointerup", endResize);
            window.removeEventListener("pointercancel", cancelResize);
            window.removeEventListener("blur", cancelResize);
        }
        function onKey(event) {
            if (event.key === "Escape" && pointerDrag) {
                event.preventDefault();
                endDrag();
                return;
            }
            if (event.key === "Escape" && resize) {
                event.preventDefault();
                cancelResize();
                return;
            }
            const corner = event.target.closest(".bcmv-corner");
            if (corner && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                const id = corner.closest(".bcmv-cell").dataset.bcmvChannel;
                const axis = event.key === "ArrowLeft" || event.key === "ArrowRight" ? "columns" : "rows";
                const handle = cornerEdges(id, corner.dataset.corner).find((item) => item.axis === axis);
                event.preventDefault();
                event.stopPropagation();
                if (handle) {
                    adjustSplit(
                        handle.key,
                        handle.value + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.01 : 0.01)
                    );
                    persistSession();
                }
                return;
            }
            const handle = event.target.closest(".bcmv-separator");
            if (!handle) return;
            const direction = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[event.key];
            if (!direction) return;
            event.preventDefault();
            event.stopPropagation();
            const item = model.treeLayout(state.dockTree).handles.find((entry) => entry.key === handle.dataset.path);
            if (item) adjustSplit(item.key, item.value + direction * 0.01);
            persistSession();
        }

        function release() {
            cancelResize();
            endDrag();
            host?.removeEventListener("pointerdown", onPointerDown, true);
            host?.removeEventListener("click", onHostClick, true);
            host?.removeEventListener("dragstart", onNativeDragStart, true);
            overlay?.removeEventListener("keydown", onKey);
            host = native = overlay = null;
        }
        function mount(nextHost, nextNative, nextOverlay, mainId) {
            release();
            host = nextHost;
            native = nextNative;
            overlay = nextOverlay;
            routeId = mainId;
            host.addEventListener("pointerdown", onPointerDown, true);
            host.addEventListener("click", onHostClick, true);
            host.addEventListener("dragstart", onNativeDragStart, true);
            overlay.addEventListener("keydown", onKey);
        }
        function cancelPointer() {
            if (!pointerDrag) return false;
            endDrag();
            return true;
        }
        function cancelGesture() {
            if (cancelPointer()) return true;
            if (!resize) return false;
            cancelResize();
            return true;
        }
        return {
            mount,
            release,
            position: positionCells,
            cancelDrag: endDrag,
            cancelResize,
            cancelPointer,
            cancelGesture,
            get busy() {
                return Boolean(pointerDrag || resize);
            },
        };
    }
    root.multiviewLayoutControls = { create };
})();
