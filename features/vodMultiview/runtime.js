(() => {
    "use strict";

    const {
        bindFeatureOptions,
        startPageChangeDetection,
        createMutationObserverSync,
        injectStyleOnce,
        ensureUiTheme,
        syncPlayerButtonTooltip,
        formatKstTime,
    } = CheeseSpanner.utils;
    const { loadVideo, videoNoFromUrl, searchChannels, findReplay } = CheeseSpanner.vodMultiviewMetadata;
    const model = CheeseSpanner.multiviewModel;
    const maxAuxiliary = model.MAX_VIEWS - 1;
    const HOST = "#player_layout.chzzk_player.type_vod";
    const PANEL_ID = "cheese-spanner-vod-multiview";
    const LAUNCHER_ID = `${PANEL_ID}-launcher`;
    const COMMAND = "cheese-spanner:vod-multiview:command";
    const STATUS = "cheese-spanner:vod-multiview:status";
    const REFERENCE = "cheese-spanner:vod-multiview:reference";
    const AUXILIARY = "cheese-spanner:vod-multiview:auxiliary";
    const MESSAGES = {
        "waiting-main": "메인 영상이 준비되면 맞춰 재생합니다.",
        loading: "보조 영상을 불러오는 중입니다.",
        syncing: "방송 시각을 맞추는 중입니다.",
        synced: "메인과 방송 시각을 맞췄습니다.",
        "main-paused": "메인이 일시정지 중입니다.",
        "main-ended": "메인 영상이 끝났습니다.",
        paused: "보조 영상만 일시정지 중입니다.",
        "out-of-range": "해당 시각의 영상이 없습니다.",
        "unknown-time": "방송 시각을 확인할 수 없습니다.",
        restricted: "접근이 제한된 다시보기입니다.",
        unsupported: "이 다시보기의 재생 형식을 지원하지 않습니다.",
        "lookup-error": "다시보기 정보를 불러오지 못했습니다.",
        "load-error": "보조 영상을 재생하지 못했습니다.",
        "cleanup-error": "이전 영상의 정리가 끝나지 않았습니다. 이 페이지를 새로 열어 주세요.",
        "no-replay": "메인과 방송 시간이 겹치는 공개 다시보기 없음",
        "search-limit": "검색 범위에서 영상을 찾지 못했습니다. 다시보기 주소로 추가할 수 있습니다.",
        resync: "방송 시각을 맞추지 못했습니다.",
    };
    const RETRY = new Set(["lookup-error", "load-error"]);
    let enabled = false;
    let hidden = false;
    let view = null;
    let observer = null;
    let unsubscribe = null;
    let route = "";
    let requestSequence = 0;
    let clockEnabled = false;
    const clocks = new Map();

    function installStyles() {
        ensureUiTheme?.();
        injectStyleOnce(
            "cheese-spanner-vod-multiview-style",
            `
#player_layout[data-bcvm-split]:not(.pip_mode) > .pzp-pc:not(:fullscreen) {
    position:absolute; inset:var(--bcvm-top) auto auto var(--bcvm-left);
    width:var(--bcvm-width) !important; max-width:var(--bcvm-width); height:var(--bcvm-height) !important;
    container:bcvm-main / size;
}
#player_layout[data-bcvm-viewport][popover] {
    position:fixed !important; inset:0 !important; margin:0 !important;
    width:100vw !important; height:100vh !important; max-width:none !important; max-height:none !important;
    padding:0 !important; border:0 !important; overflow:visible !important; background:transparent !important;
    pointer-events:none;
}
#player_layout[data-bcvm-viewport]::backdrop { background:transparent; pointer-events:none; }
#player_layout[data-bcvm-viewport] > .pzp-pc { z-index:var(--bcvm-main-layer) !important; pointer-events:auto; }
#player_layout[data-bcvm-viewport] > #${PANEL_ID} { z-index:auto; }
#${PANEL_ID} {
    position: absolute;
    inset: 0;
    z-index: 12;
    pointer-events: none;
}
#${LAUNCHER_ID} { position:relative; display:inline-flex; align-items:center; justify-content:center; flex:none; box-sizing:border-box; width:36px; height:36px; margin-left:10px; padding:6px; border:0; border-radius:var(--bct-radius-sm); background:transparent; color:inherit; cursor:pointer; }
#${LAUNCHER_ID} svg { width:24px; height:24px; pointer-events:none; }
#${LAUNCHER_ID}:hover { background:rgba(255,255,255,.2); }
#${LAUNCHER_ID}[aria-expanded="true"], #${LAUNCHER_ID}[data-active] { color:var(--bct-brand); }
.pzp-pc:not(.pzp-pc--controls) #${LAUNCHER_ID}:not(:focus-visible, [aria-expanded="true"]) { opacity:0; pointer-events:none; }
#${PANEL_ID}[hidden], #${PANEL_ID} [hidden], #bcvm-toolbar[hidden], #bcvm-toolbar [hidden] { display:none !important; }
#bcvm-toolbar {
    position: absolute;
    z-index: 45;
    inset-inline-end: 8px;
    bottom: 72px;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 8px;
    padding: 10px;
    box-sizing: border-box;
    width: min(360px, calc(100% - 16px));
    max-height: calc(100% - 80px);
    background: var(--bct-surface);
    border: 1px solid var(--bct-border);
    border-radius: var(--bct-radius-md);
    box-shadow: var(--bct-shadow);
    color: var(--bct-text);
    font: 13px/1.4 var(--bct-font);
    text-align: start;
    overflow: auto;
}
#bcvm-toolbar .bcvm-row, #bcvm-toolbar form {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
}
#bcvm-toolbar .bcvm-title {
    flex: 1 1 100px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#bcvm-toolbar .bcvm-row > span { flex: 1 1 auto; color: var(--bct-text-muted); }
#bcvm-toolbar :is(button, input) {
    box-sizing: border-box;
    min-height: 30px;
    border-radius: var(--bct-radius-sm);
    border: 1px solid var(--bct-border-strong);
    background: var(--bct-surface);
    color: var(--bct-text);
    font: inherit;
    padding: 4px 8px;
}
#bcvm-toolbar input { flex: 1 1 160px; min-width: 0; background: var(--bct-surface-weak); }
#bcvm-toolbar button:hover { background: var(--bct-hover); }
#bcvm-toolbar button[aria-pressed="true"] { background:var(--bct-brand); color:var(--bct-on-brand); }
#bcvm-toolbar :is(button, input):focus-visible, #${LAUNCHER_ID}:focus-visible, #${PANEL_ID} :is(.bcvm-divider, .bcvm-grip, .bcvm-corner):focus-visible {
    outline: 2px solid var(--bct-focus-ring);
    outline-offset: 1px;
}
#bcvm-toolbar :is(.bcvm-results, .bcvm-list) { display:grid; gap:4px; margin:0; padding:0; list-style:none; }
#bcvm-toolbar .bcvm-entry { display:grid; gap:4px; padding:4px 0; }
#bcvm-toolbar .bcvm-results button { display:flex; align-items:center; gap:8px; width:100%; text-align:start; }
#bcvm-toolbar .bcvm-results img { width:24px; height:24px; border-radius:50%; object-fit:cover; }
@container bcvm-main (width < 560px) {
    #player_layout > .pzp-pc .pzp-pc__bottom-buttons-left { min-inline-size:0; max-inline-size:calc(100% - 40px); }
    #${LAUNCHER_ID} { order:-1; margin-left:0; z-index:1; }
    #bcvm-toolbar { bottom:42px; max-height:calc(100% - 48px); }
}
@container bcvm-main (height < 150px) {
    #bcvm-toolbar { bottom:36px; max-height:calc(100% - 38px); padding:2px 4px; }
    #bcvm-toolbar .bcvm-layout { order:-1; }
    #bcvm-toolbar :is(button, input) { min-height:26px; padding:2px 6px; }
}
#${PANEL_ID} .bcvm-screen { position:absolute; background:#000; pointer-events:auto; container-type:inline-size; }
#${PANEL_ID} .bcvm-screen > .pzp-pc { width: 100%; height: 100%; }
#${PANEL_ID} .bcvm-main-chrome { position:absolute; pointer-events:none; }
#${PANEL_ID}[data-open="1"] .bcvm-main-chrome { visibility:hidden; }
#player_layout[data-bcvm-viewport] #${PANEL_ID} .bcvm-screen { box-shadow:var(--bct-shadow); }
#player_layout[data-bcvm-split] :is(.pzp-pc__video, .webplayer-internal-video) { touch-action:none; -webkit-user-drag:none; }
#${PANEL_ID} :is(.bcvm-grip, .bcvm-corner) {
    position:absolute; z-index:46; border:0; color:#fff; opacity:0; pointer-events:none; touch-action:none;
}
#${PANEL_ID} .bcvm-grip {
    inset-block-start:6px; inset-inline-start:22px; max-inline-size:calc(100% - 44px); min-block-size:28px;
    border-radius:var(--bct-radius-sm); padding:4px 8px; background:#000b; cursor:grab;
    font:12px/1.4 var(--bct-font); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
#${PANEL_ID} .bcvm-corner { inline-size:20px; block-size:20px; padding:0; background:transparent; }
#${PANEL_ID} .bcvm-corner::after {
    content:""; position:absolute; inset:4px; border:2px solid currentColor; filter:drop-shadow(0 0 2px #000);
}
#${PANEL_ID} .bcvm-corner[data-bcvm-corner="nw"] { top:0; left:0; cursor:nwse-resize; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner="ne"] { top:0; right:0; cursor:nesw-resize; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner="sw"] { bottom:0; left:0; cursor:nesw-resize; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner="se"] { bottom:0; right:0; cursor:nwse-resize; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner^="n"]::after { border-bottom:0; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner^="s"]::after { border-top:0; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner$="w"]::after { border-right:0; }
#${PANEL_ID} .bcvm-corner[data-bcvm-corner$="e"]::after { border-left:0; }
#${PANEL_ID} [data-bcvm-tile]:is(:hover, :focus-within) > :is(.bcvm-grip, .bcvm-corner),
#player_layout > .pzp-pc:is(:hover, :focus-within) ~ #${PANEL_ID} .bcvm-main-chrome > :is(.bcvm-grip, .bcvm-corner) {
    opacity:1; pointer-events:auto;
}
#${PANEL_ID} .bcvm-grip[data-dragging] { cursor:grabbing; }
#${PANEL_ID} .bcvm-drop-preview {
    position:absolute; z-index:48; display:grid; place-items:center; pointer-events:none; box-sizing:border-box;
    border:2px solid var(--bct-brand); background:color-mix(in srgb, var(--bct-brand) 15%, transparent);
    color:#fff; text-shadow:0 1px 3px #000; font:600 13px/1.4 var(--bct-font);
}
#${PANEL_ID} .bcvm-clock { margin-inline-start:6px; color:#fff; font-size:12px; font-variant-numeric:tabular-nums; white-space:nowrap; }
#${PANEL_ID} .pzp-pc:not(.pzp-pc--controls) :is(.bcvm-clock, .pzp-pc__zoom-button):not(:focus-visible) { visibility:hidden; }
#${PANEL_ID} .pzp-pc__mute-indicator { display:none !important; }
@container (max-width: 350px) {
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons { flex-wrap:wrap; gap:2px; padding-inline:4px; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) :is(.pzp-pc__bottom-buttons-left, .pzp-pc__bottom-buttons-right) { min-width:0; gap:1px; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons .pzp-button { width:26px; height:26px; min-width:0; padding:0; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons :is(.pzp-ui-icon, .bcac-icon) { width:24px; height:24px; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons svg { max-width:100%; max-height:100%; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__vod-time { display:none; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .bcvm-clock { position:absolute; inset-inline-end:6px; bottom:100%; }
}
#${PANEL_ID} .bcvm-screen[data-unavailable="1"] > .pzp-pc:not(:fullscreen) { visibility: hidden; }
#${PANEL_ID} .bcvm-message { position:absolute; inset:0; display:grid; place-items:center; margin:0; padding:12px; color:#fff; text-align:center; font:13px/1.4 var(--bct-font); pointer-events:none; }
#${PANEL_ID} .bcvm-screen:has(> .pzp-pc):not([data-unavailable="1"]) .bcvm-message { display:none; }
#${PANEL_ID} .bcvm-divider { position:absolute; z-index:1; width:12px; padding:0; border:0; background:transparent; cursor:col-resize; transform:translateX(-50%); pointer-events:auto; touch-action:none; }
#${PANEL_ID} .bcvm-divider::before { content:""; position:absolute; inset:0 5px; background:var(--bct-border-strong); pointer-events:none; }
#${PANEL_ID} .bcvm-divider:is(:hover, :focus-visible, [data-dragging])::before { background:var(--bct-brand); }
#${PANEL_ID} .bcvm-divider[aria-orientation="horizontal"] { height:12px; transform:translateY(-50%); cursor:row-resize; }
#${PANEL_ID} .bcvm-divider[aria-orientation="horizontal"]::before { inset:5px 0; }
#${PANEL_ID} :is(.pzp-pc__progress-slider, .pzp-setting-intro-playbackrate, .pzp-pc__setting-playbackrate-pane) {
    display: none !important;
}
#player_layout.pip_mode :is(#${PANEL_ID}, #bcvm-toolbar, #${LAUNCHER_ID}) { display:none !important; }
`
        );
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function button(label, action) {
        const node = element("button", "", label);
        node.type = "button";
        if (action) node.addEventListener("click", action);
        return node;
    }

    function send(panel, command) {
        panel.dispatchEvent(new CustomEvent(COMMAND, { bubbles: true, detail: command }));
    }

    function updateStatus(current, status, text = MESSAGES[status] || "") {
        current.status.textContent = text;
        current.message.textContent = text;
        current.retry.hidden = !RETRY.has(status);
        current.resync.hidden = status !== "resync" && status !== "paused";
        current.screen.dataset.unavailable = ["out-of-range", "unknown-time", "main-ended"].includes(status)
            ? "1"
            : "0";
    }

    function cancelLookup(current) {
        current.pending?.abort();
        current.pending = null;
    }

    function removeSub(current, entry) {
        entry.pending?.abort();
        if (entry.request) send(current.panel, { action: "stop", request: entry.request });
        current.entries.delete(entry.no);
        current.windows.delete(entry.no);
        entry.screen.remove();
        entry.row.remove();
        refreshLayout(current, "remove", entry.no);
    }

    function clearAll(current) {
        cancelLookup(current);
        current.free = false;
        current.windows.clear();
        for (const entry of current.entries.values()) removeSub(current, entry);
        refreshLayout(current);
    }

    function isCurrent(current, pending, mainNo) {
        return (
            view === current &&
            current.pending === pending &&
            !pending.signal.aborted &&
            current.panel.isConnected &&
            route === mainNo &&
            videoNoFromUrl(location.href) === mainNo
        );
    }

    function selectSub(current, subNo) {
        const used = new Set([...current.entries.values()].map((entry) => entry.index));
        const index = Array.from({ length: maxAuxiliary }, (_, n) => n).find((n) => !used.has(n));
        const screen = element("div", "bcvm-screen");
        screen.dataset.bcmvVideo = "1";
        screen.dataset.bcvmSlot = String(index);
        const message = element("p", "bcvm-message");
        message.setAttribute("aria-hidden", "true");
        screen.append(message);
        const row = element("li", "bcvm-entry");
        const heading = element("div", "bcvm-row");
        const title = element("strong", "bcvm-title", `보조 다시보기 ${subNo}`);
        const status = element("span");
        status.setAttribute("role", "status");
        const entry = { no: subNo, index, row, screen, message, title, status, request: 0 };
        entry.tile = createTile(screen, subNo, `보조 다시보기 ${subNo}`);
        const remove = button("영상 빼기", () => {
            removeSub(current, entry);
            current.notice.textContent = "";
            current.input.focus({ preventScroll: true });
        });
        remove.setAttribute("aria-label", `다시보기 ${subNo} 빼기`);
        entry.retry = button("다시 시도", () => {
            removeSub(current, entry);
            void add(current, `https://chzzk.naver.com/video/${subNo}`);
        });
        entry.resync = button("다시 동기화", () => send(current.panel, { action: "resync", request: entry.request }));
        heading.append(title, remove);
        const state = element("div", "bcvm-row");
        state.append(status, entry.retry, entry.resync);
        row.append(heading, state);
        current.entries.set(subNo, entry);
        current.results.replaceChildren();
        current.list.append(row);
        current.panel.append(screen);
        updateStatus(entry, "loading");
        refreshLayout(current, "add", subNo);
        return entry;
    }

    function startSub(current, entry, main, sub) {
        if (sub.title) entry.title.textContent = sub.title;
        if (sub.channelName || sub.title) labelTile(entry.tile, sub.channelName || sub.title);
        if (main.status !== "ok" || sub.status !== "ok") {
            const status = main.status !== "ok" ? main.status : sub.status;
            const owner = main.status !== "ok" ? "메인" : "보조";
            updateStatus(entry, status, `${owner} 영상 · ${MESSAGES[status]}`);
            return;
        }
        if (
            main.media.id === sub.media.id ||
            [...current.entries.values()].some((item) => item.info?.media.id === sub.media.id)
        ) {
            updateStatus(entry, "", "이미 화면에 있는 다시보기입니다.");
            return;
        }
        entry.info = { media: sub.media, title: sub.title, channelName: sub.channelName };
        entry.screen.setAttribute("aria-label", sub.title || "보조 다시보기");
        entry.request = ++requestSequence;
        send(current.panel, {
            action: "start",
            request: entry.request,
            slot: entry.index,
            main: main.media,
            sub: sub.media,
            key: sub.key,
            aes: sub.aes,
        });
    }

    function canAdd(current) {
        if (view !== current) return false;
        if (current.entries.size < maxAuxiliary) return true;
        current.notice.textContent = `메인 포함 최대 ${model.MAX_VIEWS}개 영상을 볼 수 있습니다.`;
        return false;
    }

    async function add(current, url) {
        if (!canAdd(current)) return;
        const subNo = videoNoFromUrl(url);
        if (!subNo || subNo === route || current.entries.has(subNo)) {
            const message = !subNo
                ? "치지직 다시보기 주소를 입력해 주세요."
                : subNo === route
                  ? "메인 영상은 보조로 추가할 수 없습니다."
                  : "이미 추가한 다시보기입니다.";
            current.notice.textContent = message;
            return;
        }
        cancelLookup(current);
        current.notice.textContent = "";
        const entry = selectSub(current, subNo);
        const pending = (entry.pending = new AbortController());
        const { signal } = pending;
        const mainNo = route;
        const ownsEntry = () =>
            !signal.aborted &&
            view === current &&
            current.entries.get(subNo) === entry &&
            current.panel.isConnected &&
            route === mainNo &&
            videoNoFromUrl(location.href) === mainNo;
        try {
            const [main, sub] = await Promise.all([
                current.mainInfo || loadVideo(mainNo, { signal }),
                loadVideo(subNo, { signal, needsKey: true }),
            ]);
            if (!ownsEntry()) return;
            if (main.status === "ok") current.mainInfo = main;
            startSub(current, entry, main, sub);
        } catch {
            if (ownsEntry()) updateStatus(entry, "lookup-error");
        } finally {
            entry.pending = null;
        }
    }

    function reference(current, main) {
        let at;
        const receive = (event) => {
            if (Number.isFinite(event.detail)) at = event.detail;
        };
        current.panel.addEventListener(REFERENCE, receive);
        try {
            send(current.panel, { action: "reference", main });
        } finally {
            current.panel.removeEventListener(REFERENCE, receive);
        }
        return at;
    }

    async function addChannel(current, channel) {
        if (!canAdd(current)) return;
        cancelLookup(current);
        const pending = (current.pending = new AbortController());
        const { signal } = pending;
        const mainNo = route;
        current.notice.textContent = `${channel.name}의 다시보기를 확인하고 있습니다.`;
        try {
            const main = current.mainInfo || (await loadVideo(mainNo, { signal }));
            if (!isCurrent(current, pending, mainNo)) return;
            if (main.status !== "ok") {
                current.notice.textContent = `메인 영상 · ${MESSAGES[main.status]}`;
                return;
            }
            current.mainInfo = main;
            const at = reference(current, main.media);
            const sub = await findReplay(channel.id, main.media, { signal, at, excluded: current.entries.keys() });
            if (!isCurrent(current, pending, mainNo)) return;
            if (sub.status !== "ok") {
                current.notice.textContent = MESSAGES[sub.status];
                return;
            }
            if (!canAdd(current) || current.entries.has(sub.media.videoNo)) return;
            current.notice.textContent = "";
            const entry = selectSub(current, sub.media.videoNo);
            startSub(current, entry, main, sub);
        } catch {
            if (isCurrent(current, pending, mainNo)) current.notice.textContent = MESSAGES["lookup-error"];
        } finally {
            if (current.pending === pending) current.pending = null;
        }
    }

    async function search(current, keyword) {
        if (!canAdd(current)) return;
        cancelLookup(current);
        const pending = (current.pending = new AbortController());
        const mainNo = route;
        current.results.replaceChildren();
        current.notice.textContent = "채널을 검색하고 있습니다.";
        try {
            const channels = await searchChannels(keyword, { signal: pending.signal });
            if (!isCurrent(current, pending, mainNo)) return;
            for (const channel of channels) {
                const row = element("li");
                const select = button(channel.name, () => void addChannel(current, channel));
                if (channel.image) {
                    const image = element("img");
                    image.alt = "";
                    image.src = channel.image;
                    image.referrerPolicy = "no-referrer";
                    image.addEventListener("error", () => image.remove(), { once: true });
                    select.prepend(image);
                }
                row.append(select);
                current.results.append(row);
            }
            current.notice.textContent = channels.length
                ? "채널을 선택하면 메인과 같은 방송 시각의 다시보기를 찾습니다."
                : "검색 결과가 없습니다.";
        } catch {
            if (isCurrent(current, pending, mainNo)) current.notice.textContent = "채널을 검색하지 못했습니다.";
        } finally {
            if (current.pending === pending) current.pending = null;
        }
    }

    function setOpen(current, open) {
        current.open = open;
        current.panel.dataset.open = open ? "1" : "0";
        current.toolbar.hidden = !open;
        current.launcher.setAttribute("aria-expanded", String(open));
        (open ? current.input : current.launcher).focus({ preventScroll: true });
    }

    const percent = (n) => `${n * 100}%`;
    const dimensions = ["left", "top", "width", "height"];
    const corners = { nw: "왼쪽 위", ne: "오른쪽 위", sw: "왼쪽 아래", se: "오른쪽 아래" };
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

    function createTile(node, id, label) {
        node.dataset.bcvmTile = id;
        const grip = button("");
        grip.className = "bcvm-grip";
        const handles = Object.keys(corners).map((corner) => {
            const handle = button("");
            handle.className = "bcvm-corner";
            handle.dataset.bcvmCorner = corner;
            handle.hidden = true;
            return handle;
        });
        node.append(grip, ...handles);
        const tile = { id, node, grip, handles };
        labelTile(tile, label);
        return tile;
    }

    function labelTile(tile, label) {
        tile.grip.textContent = label;
        tile.grip.title = "드래그하거나 방향키로 영상 위치 이동";
        tile.grip.setAttribute("aria-label", `${label} 영상 이동`);
        for (const handle of tile.handles)
            handle.setAttribute("aria-label", `${label} ${corners[handle.dataset.bcvmCorner]} 모서리 크기 조절`);
    }

    function tileFor(current, id) {
        return id === current.mainId ? current.mainTile : current.entries.get(id)?.tile;
    }

    function tileAt(current, target) {
        const node = target.closest("[data-bcvm-tile]");
        const tile = tileFor(current, node?.dataset.bcvmTile);
        if (tile?.node === node) return tile;
        if (current.root.contains(target)) return current.mainTile;
        return null;
    }

    function dockBounds(current) {
        if (!current.viewport) return current.host.getBoundingClientRect();
        const wrapper = current.host.parentElement?.getBoundingClientRect();
        return wrapper?.width && wrapper.height ? wrapper : current.dockBounds;
    }

    function layoutSuspended(current) {
        return Boolean(document.fullscreenElement || current.host.classList.contains("pip_mode"));
    }

    function closeViewport(current) {
        if (!current.viewport) return;
        current.viewport = false;
        const { host } = current;
        try {
            host.hidePopover();
        } catch {
            // The native player may have detached during a route change.
        } finally {
            if (host.getAttribute("popover") === "manual") host.removeAttribute("popover");
            host.removeAttribute("data-bcvm-viewport");
        }
    }

    function syncViewport(current) {
        if (!current.free || layoutSuspended(current)) {
            closeViewport(current);
            return;
        }
        if (current.viewport) return;
        const { host } = current;
        const bounds = dockBounds(current);
        if (
            bounds.width &&
            bounds.height &&
            typeof host.togglePopover === "function" &&
            !host.hasAttribute("popover")
        ) {
            current.dockBounds = bounds;
            host.setAttribute("popover", "manual");
            host.setAttribute("data-bcvm-viewport", "");
            current.viewport = true;
            try {
                if (host.togglePopover(true)) return;
            } catch {
                // A detached host or a cancelled opening still needs to return to the split layout.
            }
            closeViewport(current);
        }
        current.free = false;
        current.notice.textContent = "현재 화면에서 자유 배치 사용 불가";
    }

    function fitWindow(rect, bounds, aspect) {
        const [x, y, width, height] = rect;
        const ratio = (aspect * bounds.height) / bounds.width;
        const w = Math.min(width, height * ratio);
        const h = Math.min(height, width / ratio);
        return [x + (width - w) / 2, y + (height - h) / 2, w, h];
    }

    function freeCells(current, tiled) {
        const bounds = current.host.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return tiled;
        for (const { id, rect } of tiled) {
            if (current.windows.has(id)) continue;
            const dock = dockBounds(current);
            const player = id === current.mainId ? current.root : tileFor(current, id).node;
            const video = player.querySelector("video.webplayer-internal-video");
            const aspect =
                video?.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
            current.windows.set(id, {
                rect: model.toViewportWindow(fitWindow(rect, dock, aspect), dock, bounds),
                aspect,
            });
        }
        return [...current.windows].map(([id, placement]) => ({
            id,
            rect:
                current.drag?.tile?.id === id && current.drag.previewRect
                    ? current.drag.previewRect
                    : fitWindow(placement.rect, bounds, placement.aspect),
        }));
    }

    function positionRect(node, rect) {
        dimensions.forEach((name, i) => {
            node.style[name] = percent(rect[i]);
        });
    }

    function syncPanelOrder(current) {
        const cells = model.treeLayout(current.tree).cells.filter(({ id }) => current.entries.has(id));
        cells.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
        let next = current.list.firstElementChild;
        for (const { id } of cells) {
            const row = current.entries.get(id).row;
            if (row !== next) current.list.insertBefore(row, next);
            next = row.nextElementSibling;
        }
    }

    function isCompact(current) {
        const { width } = dockBounds(current);
        return width > 0 && width < 760;
    }

    function refreshLayout(current, change, id) {
        endGesture(current, false);
        const compact = isCompact(current);
        const subs = [...current.entries.keys()];
        const { mainId } = current;
        const ids = [mainId, ...subs];
        const keep = Boolean(change && subs.length && current.customLayout && current.compact === compact);
        current.compact = compact;
        current.customLayout = keep;
        if (keep) {
            current.tree =
                change === "add" ? model.addTree(current.tree, id, mainId) : model.removeTree(current.tree, id);
        } else if (compact && subs.length > 0 && subs.length <= 2) {
            const bottom = subs.length === 1 ? subs[0] : { axis: "columns", ratio: 0.5, a: subs[0], b: subs[1] };
            current.tree = { axis: "rows", ratio: 0.5, a: mainId, b: bottom };
        } else if (subs.length === 1) {
            current.tree = { axis: "columns", ratio: 0.5, a: mainId, b: subs[0] };
        } else {
            current.tree = model.removeTree(model.defaultTree(ids.map((id) => ({ id }))), null);
        }
        for (const divider of current.dividers.values()) divider.remove();
        current.dividers.clear();
        drawLayout(current);
        syncPanelOrder(current);
    }

    function drawLayout(current) {
        syncViewport(current);
        const { host, panel, launcher, entries, viewport } = current;
        const active = Boolean(entries.size || viewport);
        const suspended = layoutSuspended(current);
        panel.hidden = !active;
        launcher.toggleAttribute("data-active", active);
        current.freeToggle.setAttribute("aria-pressed", String(current.free));
        current.freeToggle.disabled = suspended;
        host.toggleAttribute("data-bcvm-split", active);
        if (!viewport) host.style.removeProperty("--bcvm-main-layer");
        current.layout = model.treeLayout(current.drag?.previewTree || current.tree);
        current.cells = viewport ? freeCells(current, current.layout.cells) : current.layout.cells;
        if (!active) {
            for (const name of dimensions) host.style.removeProperty(`--bcvm-${name}`);
            return;
        }
        current.cells.forEach(({ id, rect }, index) => {
            const tile = tileFor(current, id);
            if (!tile) return;
            const layer = index * 2 + 2;
            positionRect(tile.node, rect);
            tile.node.style.zIndex = viewport ? String(layer + Number(id === current.mainId)) : "";
            tile.grip.toggleAttribute("hidden", suspended);
            for (const handle of tile.handles) handle.toggleAttribute("hidden", suspended || !viewport);
            if (id === current.mainId) {
                dimensions.forEach((name, i) => {
                    host.style.setProperty(`--bcvm-${name}`, percent(rect[i]));
                });
                if (viewport) host.style.setProperty("--bcvm-main-layer", String(layer));
            }
        });
        const handles =
            !viewport && !suspended && !(current.drag?.tile && current.drag.started) ? current.layout.handles : [];
        const visibleDividers = new Set(handles.map(({ key }) => key));
        for (const [key, divider] of current.dividers) divider.toggleAttribute("hidden", !visibleDividers.has(key));
        for (const handle of handles) {
            const { key, axis, value, position, start, length, lower, upper } = handle;
            const divider = current.dividers.get(key) || bindDivider(current, key);
            const vertical = axis === "columns";
            Object.assign(divider.style, {
                left: percent(vertical ? position : start),
                top: percent(vertical ? start : position),
                width: vertical ? "" : percent(length),
                height: vertical ? percent(length) : "",
            });
            divider.setAttribute("aria-orientation", vertical ? "vertical" : "horizontal");
            divider.setAttribute("aria-valuemin", String(Math.round(lower * 100)));
            divider.setAttribute("aria-valuemax", String(Math.round(upper * 100)));
            divider.setAttribute("aria-valuenow", String(Math.round(value * 100)));
        }
        const drop = current.drag?.drop;
        current.preview.hidden = !drop;
        if (drop) {
            positionRect(current.preview, current.cells.find(({ id }) => id === current.drag.tile.id).rect);
            current.preview.textContent = drop.label;
        }
    }

    function bindDivider(current, key) {
        const divider = button("");
        divider.className = "bcvm-divider";
        divider.dataset.bcvmDivider = key;
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-label", "영상 크기 조절");
        const getHandle = () => current.layout.handles.find((item) => item.key === key);
        divider.addEventListener("keydown", (event) => {
            const handle = getHandle();
            const keys = handle.axis === "columns" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
            const next =
                event.key === keys[0]
                    ? handle.value - 0.05
                    : event.key === keys[1]
                      ? handle.value + 0.05
                      : event.key === "Home"
                        ? 0.5
                        : NaN;
            if (!Number.isFinite(next)) return;
            event.preventDefault();
            resizeDivider(current, handle, next);
        });
        divider.addEventListener("dblclick", () => resizeDivider(current, getHandle(), 0.5));
        current.dividers.set(key, divider);
        current.panel.append(divider);
        return divider;
    }

    function resizeDivider(current, handle, ratio) {
        const value = Math.max(handle.lower, Math.min(handle.upper, ratio));
        current.tree = model.resizeTree(current.tree, handle.key, value);
        current.customLayout = true;
        drawLayout(current);
    }

    function dockTile(current, tree, source, target, side) {
        if (side === "center" && (source === current.mainId || target === current.mainId)) {
            // Reorder the boxes even when one is the native main. The route still owns playback and chat.
            return model.mapTree(tree, (id) => (id === source ? target : id === target ? source : id));
        }
        return model.dockTree(tree, source, target, side, current.mainId);
    }

    function findDrop(drag, x, y) {
        const px = (x - drag.bounds.left) / drag.bounds.width;
        const py = (y - drag.bounds.top) / drag.bounds.height;
        const cell = drag.cells.find(
            ({ rect: [left, top, width, height] }) => px >= left && px < left + width && py >= top && py < top + height
        );
        if (!cell || cell.id === drag.tile.id) return null;
        const [left, top, width, height] = cell.rect;
        const rx = (px - left) / width;
        const ry = (py - top) / height;
        const edges = [
            ["left", rx],
            ["right", 1 - rx],
            ["top", ry],
            ["bottom", 1 - ry],
        ];
        const [edge, distance] = edges.reduce((near, next) => (next[1] < near[1] ? next : near));
        const side = distance < 0.25 ? edge : "center";
        const labels = {
            left: "왼쪽에 배치",
            right: "오른쪽에 배치",
            top: "위에 배치",
            bottom: "아래에 배치",
            center: "이 위치로 이동",
        };
        return { id: cell.id, side, label: labels[side] };
    }

    function raiseTile(current, tile) {
        if (!current.viewport || !tile) return;
        const placement = current.windows.get(tile.id);
        if (!placement || [...current.windows.keys()].at(-1) === tile.id) return;
        current.windows.delete(tile.id);
        current.windows.set(tile.id, placement);
        drawLayout(current);
    }

    function isTileSurface(current, tile, target) {
        if (
            target.closest(
                "button, a, input, select, textarea, [role='button'], [role='slider'], [role='menu'], [role='dialog'], .pzp-pc__bottom, .pzp-pc__top, .pzp-pc__settings"
            )
        )
            return false;
        return (
            target === tile.node ||
            target === current.root ||
            target.matches(".pzp-pc") ||
            Boolean(target.closest(".pzp-pc__video, .webplayer-internal-video"))
        );
    }

    function beginGesture(current, event) {
        if (event.button !== 0 || event.isPrimary === false || current.drag || !(event.target instanceof Element))
            return;
        current.suppressClick = false;
        if (
            current.panel.hidden ||
            layoutSuspended(current) ||
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey
        )
            return;
        const target = event.target;
        const tile = tileAt(current, target);
        const key = target.dataset.bcvmDivider;
        const handle =
            current.dividers.get(key) === target && !target.hidden
                ? current.layout.handles.find((item) => item.key === key)
                : null;
        if (!tile && !handle) return;
        raiseTile(current, tile);
        const bounds = current.host.getBoundingClientRect();
        if (!bounds.width || !bounds.height) return;
        const gesture = { pointer: event.pointerId, x: event.clientX, y: event.clientY, tree: current.tree, bounds };
        if (handle) {
            current.drag = { ...gesture, handle, control: target, locked: null, started: true };
        } else {
            const corner = current.viewport && tile.handles.includes(target) ? target.dataset.bcvmCorner : null;
            const grip = target === tile.grip;
            if (
                !corner &&
                !grip &&
                (!isTileSurface(current, tile, target) || (!event.altKey && target.closest("[data-bcz-pannable]")))
            )
                return;
            const rect = current.cells.find(({ id }) => id === tile.id)?.rect;
            if (!rect) return;
            current.drag = {
                ...gesture,
                tile,
                rect,
                corner,
                free: current.viewport,
                cells: current.cells,
                control: corner || grip ? target : null,
                started: Boolean(corner),
            };
        }
        if (current.drag?.control) {
            event.preventDefault();
            current.drag.control.focus({ preventScroll: true });
        }
        if (current.drag?.started) current.drag.control.setAttribute("data-dragging", "");
    }

    function moveGesture(current, event) {
        const drag = current.drag;
        const started = drag.started;
        const dx = event.clientX - drag.x;
        const dy = event.clientY - drag.y;
        if (!drag.started && Math.hypot(dx, dy) < 5) return;
        drag.started = true;
        event.preventDefault();
        event.stopPropagation();
        drag.control?.setAttribute("data-dragging", "");
        if (drag.handle) {
            const vertical = drag.handle.axis === "columns";
            const span = vertical
                ? drag.bounds.width * drag.handle.region[2]
                : drag.bounds.height * drag.handle.region[3];
            const raw = drag.handle.value + (vertical ? dx : dy) / span;
            const result = model.snapRatio(drag.handle, raw, span, drag.locked, drag.handle.value);
            drag.locked = result.locked;
            drag.previewTree = model.resizeTree(drag.tree, drag.handle.key, result.value);
        } else if (drag.free) {
            const x = dx / drag.bounds.width;
            const y = dy / drag.bounds.height;
            drag.previewRect = drag.corner
                ? model.resizeWindow(drag.rect, drag.corner, x, y, drag.bounds)
                : model.moveWindow(drag.rect, x, y);
        } else {
            const drop = findDrop(drag, event.clientX, event.clientY);
            if (started && drop?.id === drag.drop?.id && drop?.side === drag.drop?.side) return;
            drag.drop = drop;
            drag.previewTree = drop ? dockTile(current, drag.tree, drag.tile.id, drop.id, drop.side) : null;
        }
        drawLayout(current);
    }

    function endGesture(current, commit) {
        const drag = current.drag;
        if (!drag) return;
        current.drag = null;
        drag.control?.removeAttribute("data-dragging");
        if (drag.started) current.suppressClick = true;
        if (!commit) return;
        if (drag.previewTree) {
            current.tree = drag.previewTree;
            current.customLayout = true;
            syncPanelOrder(current);
        }
        if (drag.previewRect) current.windows.get(drag.tile.id).rect = drag.previewRect;
    }

    function moveByKey(current, event) {
        const direction = arrows[event.key];
        if (
            !direction ||
            !(event.target instanceof Element) ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            layoutSuspended(current) ||
            current.drag
        )
            return;
        const tile = tileAt(current, event.target);
        if (!tile || (event.target !== tile.grip && !tile.handles.includes(event.target))) return;
        const origin = current.cells.find(({ id }) => id === tile.id);
        if (!origin) return;
        event.preventDefault();
        event.stopPropagation();
        if (current.viewport) {
            const [dx, dy] = direction.map((value) => value * (event.shiftKey ? 0.05 : 0.01));
            const corner = event.target.dataset.bcvmCorner;
            const bounds = current.host.getBoundingClientRect();
            current.windows.get(tile.id).rect = corner
                ? model.resizeWindow(origin.rect, corner, dx, dy, bounds)
                : model.moveWindow(origin.rect, dx, dy);
        } else {
            const center = ([x, y, w, h]) => [x + w / 2, y + h / 2];
            const [x, y] = center(origin.rect);
            let nearest = null;
            let distance = Infinity;
            for (const cell of current.cells) {
                const [cx, cy] = center(cell.rect);
                const delta = Math.hypot(cx - x, cy - y);
                if ((cx - x) * direction[0] + (cy - y) * direction[1] <= 0.0001 || delta >= distance) continue;
                nearest = cell;
                distance = delta;
            }
            if (!nearest) return;
            current.tree = dockTile(current, current.tree, tile.id, nearest.id, "center");
            current.customLayout = true;
            syncPanelOrder(current);
        }
        drawLayout(current);
    }

    function bindLayout(current) {
        const {
            host,
            panel,
            listeners: { signal },
        } = current;
        const capture = { capture: true, signal };
        const cancel = () => {
            if (!current.drag) return;
            endGesture(current, false);
            drawLayout(current);
        };
        window.addEventListener("pointerdown", (event) => beginGesture(current, event), capture);
        window.addEventListener(
            "pointermove",
            (event) => {
                if (!current.drag || current.drag.pointer !== event.pointerId) return;
                if (event.pointerType === "mouse" && event.buttons === 0) cancel();
                else moveGesture(current, event);
            },
            capture
        );
        window.addEventListener(
            "pointerup",
            (event) => {
                if (!current.drag || current.drag.pointer !== event.pointerId) return;
                moveGesture(current, event);
                endGesture(current, true);
                drawLayout(current);
            },
            capture
        );
        window.addEventListener(
            "pointercancel",
            (event) => {
                if (current.drag?.pointer === event.pointerId) cancel();
            },
            capture
        );
        window.addEventListener("blur", cancel, { signal });
        window.addEventListener(
            "keydown",
            (event) => {
                if (event.key !== "Escape" || !current.drag) return;
                event.preventDefault();
                event.stopPropagation();
                cancel();
            },
            capture
        );
        const suppressClick = (event) => {
            if (
                !current.suppressClick ||
                event.detail === 0 ||
                !(event.target instanceof Node) ||
                !host.contains(event.target)
            )
                return;
            event.preventDefault();
            event.stopPropagation();
        };
        window.addEventListener("click", suppressClick, capture);
        window.addEventListener("dblclick", suppressClick, capture);
        host.addEventListener(
            "dragstart",
            (event) => {
                if (current.drag?.tile) event.preventDefault();
            },
            capture
        );
        host.addEventListener(
            "focusin",
            (event) => {
                if (event.target instanceof Element) raiseTile(current, tileAt(current, event.target));
            },
            { signal }
        );
        panel.addEventListener("keydown", (event) => moveByKey(current, event), { signal });
        document.addEventListener(
            "visibilitychange",
            () => {
                if (document.hidden) cancel();
            },
            { signal }
        );
    }

    function launcherReference(root) {
        return root?.querySelector(".pzp-pc__viewmode-button") || root?.querySelector(".pzp-pc__fullscreen-button");
    }

    function mount(host, root, reference) {
        installStyles();
        const current = {
            host,
            root,
            reference,
            mainId: route,
            open: false,
            free: false,
            viewport: false,
            entries: new Map(),
            dividers: new Map(),
            windows: new Map(),
            listeners: new AbortController(),
        };
        const { signal } = current.listeners;
        const panel = (current.panel = element("section"));
        panel.id = PANEL_ID;
        panel.dataset.bcvm = "1";
        panel.setAttribute("aria-label", "다시보기 멀티뷰");
        current.mainTile = createTile(element("div", "bcvm-main-chrome"), current.mainId, "메인");
        current.preview = element("div", "bcvm-drop-preview");
        current.preview.hidden = true;
        current.preview.setAttribute("aria-hidden", "true");
        panel.append(current.mainTile.node, current.preview);
        const launcher = (current.launcher = button("", (event) => {
            event.stopPropagation();
            setOpen(current, !current.open);
        }));
        launcher.id = LAUNCHER_ID;
        launcher.className = "pzp-button";
        launcher.dataset.bcvm = "1";
        const icon = CheeseSpanner.multiviewView?.multiviewIcon();
        if (icon) launcher.append(icon);
        launcher.setAttribute("aria-label", "다시보기 멀티뷰");
        launcher.setAttribute("aria-expanded", "false");
        launcher.setAttribute("aria-controls", "bcvm-toolbar");
        syncPlayerButtonTooltip(launcher, "다시보기 멀티뷰");
        const toolbar = (current.toolbar = element("div", "bcvm-toolbar"));
        toolbar.id = "bcvm-toolbar";
        toolbar.dataset.bcvm = "1";
        toolbar.setAttribute("role", "group");
        toolbar.setAttribute("aria-label", "다시보기 멀티뷰 조작");
        const heading = element("div", "bcvm-row");
        const title = element("strong", "bcvm-title", "다시보기 멀티뷰");
        const close = button("멀티뷰 닫기", () => {
            clearAll(current);
            current.results.replaceChildren();
            current.notice.textContent = "";
            setOpen(current, false);
        });
        const reset = button("기본 배치", () => {
            current.windows.clear();
            refreshLayout(current);
        });
        heading.append(title, reset, close);
        const layoutRow = element("div", "bcvm-row bcvm-layout");
        current.freeToggle = button("자유 배치", () => {
            endGesture(current, false);
            current.free = !current.free;
            current.notice.textContent = "";
            drawLayout(current);
        });
        layoutRow.append(current.freeToggle, element("span", "", "영상을 끌어 위치 이동"));
        const form = element("form");
        const input = (current.input = element("input"));
        input.type = "search";
        input.required = true;
        input.maxLength = 2048;
        input.placeholder = "채널 이름 또는 다시보기 주소";
        input.setAttribute("aria-label", input.placeholder);
        const submit = button("검색");
        submit.type = "submit";
        form.append(input, submit);
        input.addEventListener("input", () => {
            cancelLookup(current);
            current.results.replaceChildren();
            current.notice.textContent = "";
            submit.textContent = videoNoFromUrl(input.value) ? "영상 추가" : "검색";
        });
        form.addEventListener("submit", (event) => {
            event.preventDefault();
            const value = input.value.trim();
            if (videoNoFromUrl(value) || /^(?:https?:\/\/|chzzk\.naver\.com\/)/i.test(value)) void add(current, value);
            else if (value && value.length <= 100) void search(current, value);
            else current.notice.textContent = "채널 이름이나 치지직 다시보기 주소를 확인해 주세요.";
        });
        current.notice = element("div");
        current.notice.setAttribute("role", "status");
        current.results = element("ul", "bcvm-results");
        current.results.setAttribute("aria-label", "채널 검색 결과");
        current.list = element("ul", "bcvm-list");
        current.list.setAttribute("aria-label", "추가한 다시보기");
        const help = element("div", "bcvm-help", "시간 이동과 배속은 메인에서 조작하세요.");
        toolbar.append(heading, layoutRow, form, current.notice, current.results, current.list, help);
        panel.addEventListener(STATUS, (event) => {
            if (view !== current || !Object.hasOwn(MESSAGES, event.detail?.status)) return;
            const entry = [...current.entries.values()].find(
                (item) => item.request && item.request === event.detail.request
            );
            if (entry) updateStatus(entry, event.detail.status);
        });
        host.addEventListener(
            "dragover",
            (event) => {
                if (event.dataTransfer?.types.includes("text/uri-list")) event.preventDefault();
            },
            { signal }
        );
        host.addEventListener(
            "drop",
            (event) => {
                const urls = event.dataTransfer?.getData("text/uri-list").split(/\r?\n/);
                const url =
                    urls?.find((item) => item && !item.startsWith("#")) || event.dataTransfer?.getData("text/plain");
                if (!videoNoFromUrl(url)) return;
                event.preventDefault();
                event.stopPropagation();
                if (!current.open) setOpen(current, true);
                void add(current, url);
            },
            { signal }
        );
        for (const type of ["keydown", "keyup", "click", "dblclick"]) {
            panel.addEventListener(type, (event) => event.stopPropagation());
            toolbar.addEventListener(type, (event) => event.stopPropagation());
        }
        toolbar.addEventListener("keydown", (event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setOpen(current, false);
        });
        toolbar.hidden = true;
        reference.before(launcher);
        root.append(toolbar);
        host.append(panel);
        view = current;
        refreshLayout(current);
        bindLayout(current);
        const displayModeChanged = () => {
            endGesture(current, false);
            drawLayout(current);
        };
        document.addEventListener("fullscreenchange", displayModeChanged, { signal });
        let pip = host.classList.contains("pip_mode");
        current.mode = new MutationObserver(() => {
            const next = host.classList.contains("pip_mode");
            if (next === pip) return;
            pip = next;
            displayModeChanged();
        });
        current.mode.observe(host, { attributes: true, attributeFilter: ["class"] });
        host.addEventListener(
            "toggle",
            (event) => {
                if (
                    event.target !== host ||
                    event.newState !== "closed" ||
                    !current.viewport ||
                    host.matches(":popover-open")
                )
                    return;
                if (!layoutSuspended(current)) {
                    current.free = false;
                    current.notice.textContent = "자유 배치 종료";
                }
                displayModeChanged();
            },
            { signal }
        );
        const resized = () => {
            const compact = isCompact(current);
            if (compact !== current.compact && !current.customLayout) refreshLayout(current);
            else if (current.viewport || current.drag || compact !== current.compact) {
                current.compact = compact;
                displayModeChanged();
            }
        };
        if (typeof ResizeObserver === "function") {
            current.resize = new ResizeObserver(resized);
            current.resize.observe(host);
        } else window.addEventListener("resize", resized, { signal });
    }

    function unmount() {
        if (!view) return;
        clearAll(view);
        view.listeners.abort();
        view.resize?.disconnect();
        view.mode?.disconnect();
        view.panel.remove();
        view.toolbar.remove();
        view.launcher.remove();
        view = null;
    }

    function reconcile() {
        const nextRoute = enabled && !hidden ? videoNoFromUrl(location.href) : "";
        if (route !== nextRoute) {
            unmount();
            observer?.disconnect();
            observer = null;
            route = nextRoute;
        }
        if (!route) return;
        const host = document.querySelector(HOST);
        const root = host?.querySelector(":scope > .pzp-pc");
        const reference = launcherReference(root);
        if (
            view?.host === host &&
            view.root === root &&
            view.panel.parentElement === host &&
            view.toolbar.parentElement === root &&
            reference
        ) {
            if (view.reference !== reference || view.launcher.parentElement !== reference.parentElement) {
                view.reference = reference;
                reference.before(view.launcher);
            }
            return;
        }
        unmount();
        if (root && reference) mount(host, root, reference);
        if (!observer) {
            observer = createMutationObserverSync({
                shouldSchedule: () =>
                    !view ||
                    !view.panel.isConnected ||
                    !view.reference.isConnected ||
                    view.panel.parentElement !== view.host ||
                    view.root.parentElement !== view.host ||
                    view.launcher.parentElement !== view.reference.parentElement ||
                    view.toolbar.parentElement !== view.root,
                schedule: reconcile,
                onBodyReady: reconcile,
            });
        }
    }

    CheeseSpanner.vodMultiview = Object.freeze({
        getAuxiliaries() {
            if (!view || route !== videoNoFromUrl(location.href)) return [];
            return [...view.entries.values()].flatMap(({ no, index, screen, info }) => {
                if (!info) return [];
                const player = screen.querySelector(":scope > .pzp-pc[data-bcmv-video]");
                if (!player?.isConnected || player.dataset.bcvmVideoNo !== no) return [];
                const video = player.querySelector("video.webplayer-internal-video");
                return video ? [{ video, player, index, ...info }] : [];
            });
        },
    });

    function syncClocks() {
        const targets = clockEnabled ? CheeseSpanner.vodMultiview.getAuxiliaries() : [];
        for (const [video, clock] of clocks) {
            if (targets.some((target) => target.video === video && target.media.videoNo === clock.no)) continue;
            clock.listeners.abort();
            clock.node.remove();
            clocks.delete(video);
        }
        for (const { video, player, media } of targets) {
            if (clocks.has(video)) continue;
            const anchor = player.querySelector(".pzp-pc__bottom-buttons-left");
            if (!anchor) continue;
            const node = element("time", "bcvm-clock");
            node.title = "방송시각 (KST)";
            const listeners = new AbortController();
            const update = () => {
                const seconds = video.currentTime;
                const at = media.startMs + seconds * 1000;
                node.hidden =
                    video.readyState < 1 ||
                    Math.abs(video.duration - media.duration) > 2 ||
                    !(at >= media.startMs && at < media.endMs);
                if (!node.hidden) {
                    const text = formatKstTime(at, { seconds: true });
                    if (node.textContent !== text) node.textContent = text;
                }
            };
            for (const name of ["timeupdate", "loadedmetadata", "emptied"])
                video.addEventListener(name, update, { signal: listeners.signal });
            anchor.append(node);
            clocks.set(video, { no: media.videoNo, node, listeners });
            update();
        }
    }

    document.addEventListener(AUXILIARY, syncClocks);

    bindFeatureOptions((options) => {
        enabled = options.vodMultiviewEnabled === true;
        clockEnabled = enabled && options.vodBroadcastClockEnabled !== false;
        if (enabled && !unsubscribe) unsubscribe = startPageChangeDetection(reconcile);
        if (!enabled && unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        reconcile();
        syncClocks();
    });
    window.addEventListener("pagehide", () => {
        hidden = true;
        reconcile();
    });
    window.addEventListener("pageshow", () => {
        hidden = false;
        reconcile();
    });
})();
