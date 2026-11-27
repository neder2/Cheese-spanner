(() => {
    "use strict";

    const {
        bindFeatureOptions,
        startPageChangeDetection,
        createMutationObserverSync,
        injectStyleOnce,
        mutationMatchesSelector,
        ensureUiTheme,
        syncPlayerButtonTooltip,
        formatKstTime,
        formatKstDateTime,
    } = CheeseSpanner.utils;
    const { loadVideo, videoNoFromUrl, searchChannels, loadFollowing, findReplay } = CheeseSpanner.vodMultiviewMetadata;
    const model = CheeseSpanner.multiviewModel;
    const layoutView = CheeseSpanner.multiviewView;
    const maxAuxiliary = model.MAX_VIEWS - 1;
    const maxRememberedMainVideos = 12;
    const timelinePointWidth = 44;
    const timelineAvatarSize = 20;
    const timelineMinSpacing = timelineAvatarSize / 2 + 1;
    const timelinePointHeight = 54;
    const HOST = "#player_layout.chzzk_player.type_vod";
    const PLAYER_ROW = '[class^="_player_"], [class*=" _player_"]';
    const SIDEBAR = "aside#vod-aside, #cheese-spanner-vod-comment-aside";
    const SIDEBAR_HEADER = '[data-bcvc-header="1"], [class^="_header_"], [class*=" _header_"]';
    const PANEL_ID = "cheese-spanner-vod-multiview";
    const LAUNCHER_ID = `${PANEL_ID}-launcher`;
    const CHAT_BUTTON_ID = `${PANEL_ID}-chat-settings`;
    // VOD headers name this button with a blind span instead of the live header's aria-label.
    const CHAT_MENU =
        'button[aria-label="더보기 메뉴"], button[class^="_menu_button_"], button[class*=" _menu_button_"]';
    const CHAT_CLOSE =
        'button[aria-label="라이브 채팅 다시보기 닫기"], button[class^="_close_button_"], button[class*=" _close_button_"]';
    const CHAT_HEADER_TARGETS = `${SIDEBAR}, ${SIDEBAR_HEADER}, ${CHAT_MENU}, #${CHAT_BUTTON_ID}`;
    const COMMAND = "cheese-spanner:vod-multiview:command";
    const STATUS = "cheese-spanner:vod-multiview:status";
    const AUDIO_REFERENCE = "cheese-spanner:vod-multiview:audio-reference";
    const REFERENCE = "cheese-spanner:vod-multiview:reference";
    const AUXILIARY = "cheese-spanner:vod-multiview:auxiliary";
    const MESSAGES = {
        "waiting-main": "메인 영상이 준비되면 맞춰 재생합니다.",
        loading: "보조 영상을 불러오는 중입니다.",
        syncing: "방송 시각을 맞추는 중입니다.",
        synced: "메인과 방송 시각을 맞췄습니다.",
        independent: "동기화가 꺼져 있습니다. 이 영상에서 시간 이동과 배속을 따로 조절할 수 있어요.",
        "main-paused": "메인이 일시정지 중입니다.",
        "main-ended": "메인 영상이 끝났습니다.",
        paused: "보조 영상만 일시정지 중입니다.",
        "out-of-range": "해당 시각의 영상이 없습니다.",
        "unknown-time": "방송 시각을 확인할 수 없습니다.",
        restricted: "접근이 제한된 다시보기입니다.",
        unsupported: "이 다시보기의 재생 형식을 지원하지 않습니다.",
        preparing: "치지직에서 다시보기 재생 준비 중입니다. 잠시 후 다시 시도해 주세요.",
        "lookup-error": "다시보기 정보를 불러오지 못했습니다.",
        "load-error": "보조 영상을 재생하지 못했습니다.",
        "cleanup-error": "이전 영상의 정리가 끝나지 않았습니다. 이 페이지를 새로 열어 주세요.",
        "no-replay": "메인과 방송 시간이 겹치는 공개 다시보기 없음",
        "search-limit": "검색 범위에서 영상을 찾지 못했습니다. 다시보기 주소로 추가할 수 있습니다.",
        resync: "방송 시각을 맞추지 못했습니다.",
    };
    const RETRY = new Set(["lookup-error", "load-error", "preparing"]);
    let enabled = false;
    let compressorOption = false;
    let hidden = false;
    let view = null;
    let observer = null;
    let unsubscribe = null;
    let route = "";
    let requestSequence = 0;
    let clockEnabled = false;
    const clocks = new Map();
    const rememberedReplays = new Map();
    let remountState = null;

    function installStyles() {
        ensureUiTheme?.();
        injectStyleOnce(
            "cheese-spanner-vod-multiview-style",
            `
#player_layout[data-bcvm-split]:not([data-bcvm-viewport], .pip_mode, .miniplayer) { background-color:var(--bct-viewer-bg); }
#player_layout[data-bcvm-split]:not(.pip_mode, .miniplayer) > .pzp-pc:not(:fullscreen) {
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
#${LAUNCHER_ID}[aria-pressed="true"] { color:var(--bct-brand); }
#${CHAT_BUTTON_ID} { display:inline-flex; align-items:center; justify-content:center; flex:none; width:30px; height:30px; margin:0 2px 0 0; padding:0; border:0; border-radius:var(--bct-radius-md); background:transparent; color:var(--bct-text-muted); cursor:pointer; }
#${CHAT_BUTTON_ID}:hover { color:var(--bct-text); background:var(--bct-hover); }
#${CHAT_BUTTON_ID}[aria-expanded="true"] { color:var(--bct-text); background:var(--bct-brand-weak); }
#${CHAT_BUTTON_ID}:focus-visible { outline:2px solid var(--bct-focus-ring); outline-offset:-2px; }
#${CHAT_BUTTON_ID} svg { width:19px; height:19px; pointer-events:none; }
.pzp-pc:not(.pzp-pc--controls) #${LAUNCHER_ID}:not(:focus-visible) { opacity:0; pointer-events:none; }
#${PANEL_ID}[hidden], #${PANEL_ID} [hidden], #bcvm-toolbar[hidden], #bcvm-toolbar [hidden] { display:none !important; }
#bcvm-toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 0;
    padding: 12px;
    box-sizing: border-box;
    width: min(360px, calc(100% - 16px));
    max-height: min(520px, calc(100dvh - 16px));
    background: var(--bct-surface);
    border: 1px solid var(--bct-border);
    border-radius: var(--bct-radius-lg);
    box-shadow: var(--bct-shadow);
    color: var(--bct-text);
    font: 13px/1.4 var(--bct-font);
    text-align: start;
    overflow: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
}
#bcvm-toolbar[data-placement="sidebar"] {
    position:absolute; z-index:4; inset-block-start:var(--bcvm-toolbar-top); inset-inline-end:8px;
    max-height:min(520px, calc(100% - var(--bcvm-toolbar-top) - 8px));
}
#bcvm-toolbar[data-placement="below"] {
    flex:none; align-self:flex-start; margin:8px 0 8px var(--bcvm-toolbar-left, 8px);
    width:var(--bcvm-toolbar-width, min(360px, calc(100% - 16px)));
}
#bcvm-toolbar .bcvm-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-width: 0;
}
#bcvm-toolbar .bcvm-heading { justify-content:space-between; padding-bottom:12px; }
#bcvm-toolbar .bcvm-heading > strong { font-size:15px; }
#bcvm-toolbar .bcvm-heading-tools { display:flex; align-items:center; gap:4px; }
#bcvm-toolbar .bcvm-add-toggle { display:inline-flex; align-items:center; gap:4px; min-height:30px; padding:4px 8px; background:var(--bct-brand); color:var(--bct-on-brand); border-color:transparent; font-weight:700; }
#bcvm-toolbar .bcvm-add-toggle svg { width:16px; height:16px; }
#bcvm-toolbar .bcvm-add-toggle:hover { background:var(--bct-brand-hover); }
#bcvm-toolbar .bcvm-section { display:grid; gap:8px; min-width:0; padding:12px 0; border-top:1px solid var(--bct-border); }
#bcvm-toolbar .bcvm-section-title { margin:0; color:var(--bct-text); font:700 12px/1.4 var(--bct-font); }
#bcvm-toolbar form { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:6px; min-width:0; }
#bcvm-toolbar .bcvm-add-tabs { display:flex; gap:4px; padding:3px; border-radius:var(--bct-radius-md); background:var(--bct-surface-weak); }
#bcvm-toolbar .bcvm-add-tabs button { flex:1; min-width:0; border-color:transparent; background:transparent; color:var(--bct-text-muted); }
#bcvm-toolbar .bcvm-add-tabs button[aria-selected="true"] { background:var(--bct-surface); color:var(--bct-brand-text); border-color:var(--bct-border); font-weight:700; }
#bcvm-toolbar .bcvm-add-pane { display:grid; gap:8px; min-width:0; }
#bcvm-toolbar .bcvm-following-filter { display:grid; grid-template-columns:minmax(0, 1fr) auto; gap:6px; }
#bcvm-toolbar .bcvm-results img { flex:none; }
#bcvm-toolbar .bcvm-title {
    flex: 1 1 100px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#bcvm-toolbar .bcvm-row > span { flex: 1 1 auto; color: var(--bct-text-muted); }
#bcvm-toolbar a.bcvm-title { color:var(--bct-text); font-weight:700; text-decoration:none; }
#bcvm-toolbar a.bcvm-title:is(:hover, :focus-visible) { color:var(--bct-text); text-decoration:underline; text-underline-offset:3px; }
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
#bcvm-toolbar input { width:100%; min-width:0; min-height:36px; background:var(--bct-surface-weak); }
#bcvm-toolbar button { cursor:pointer; }
#bcvm-toolbar button[type="submit"] { background:var(--bct-brand); border-color:transparent; color:var(--bct-on-brand); font-weight:700; }
#bcvm-toolbar button:hover { background: var(--bct-hover); }
#bcvm-toolbar .bcvm-close { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; padding:4px; border:0; background:transparent; color:var(--bct-text-muted); }
#bcvm-toolbar .bcvm-close:hover { background:var(--bct-hover); color:var(--bct-text); }
#bcvm-toolbar .bcvm-close svg { width:18px; height:18px; pointer-events:none; }
#bcvm-toolbar button[type="submit"]:hover { background:var(--bct-brand-hover); }
#bcvm-toolbar button[aria-pressed="true"] { background:var(--bct-brand-weak); color:var(--bct-text); border-color:var(--bct-brand-border); }
#bcvm-toolbar :is(button, input, a):focus-visible, #${LAUNCHER_ID}:focus-visible, #${PANEL_ID} :is(.bcvm-divider, .bcvm-grip, .bcvm-corner, .bcvm-tile-close):focus-visible {
    outline: 2px solid var(--bct-focus-ring);
    outline-offset: 1px;
}
#bcvm-toolbar :is(.bcvm-results, .bcvm-list) { display:grid; gap:8px; margin:0; padding:0; list-style:none; }
#bcvm-toolbar .bcvm-following-list { box-sizing:border-box; max-height:240px; overflow:auto; overscroll-behavior:contain; padding:3px; }
#bcvm-toolbar .bcvm-list { gap:0; }
#bcvm-toolbar .bcvm-list > li { position:relative; min-width:0; padding:12px 0; }
#bcvm-toolbar .bcvm-list > li + li { border-top:1px solid var(--bct-border); }
#bcvm-toolbar .bcvm-entry-heading { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:10px; }
#bcvm-toolbar .bcvm-entry-copy { display:grid; grid-template-columns:auto minmax(0,1fr); align-items:baseline; gap:2px 8px; min-width:0; }
#bcvm-toolbar .bcvm-role { color:var(--bct-text-muted); font-size:12px; white-space:nowrap; }
#bcvm-toolbar .bcvm-main-entry .bcvm-role { color:var(--bct-brand-text); }
#bcvm-toolbar .bcvm-channel { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--bct-text); font-weight:600; }
#bcvm-toolbar .bcvm-list .bcvm-title { grid-column:2; color:var(--bct-text-muted); font-size:12px; font-weight:400; line-height:1.5; }
#bcvm-toolbar .bcvm-channel[hidden] + .bcvm-title { color:var(--bct-text); font:inherit; font-weight:600; }
#bcvm-toolbar .bcvm-solo { margin:4px 0 0; }
#bcvm-toolbar .bcvm-solo[aria-pressed="true"] { color:var(--bct-brand-text); }
#bcvm-toolbar .bcvm-solo[aria-disabled="true"] { color:var(--bct-text-muted); }
#bcvm-toolbar .bcvm-entry-actions { display:flex; align-items:center; gap:2px; }
#bcvm-toolbar :is(.bcvm-remove,.bcvm-sync) { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; min-height:28px; margin:0; padding:0; border:0; background:transparent; color:var(--bct-text-body); }
#bcvm-toolbar :is(.bcvm-remove,.bcvm-sync):hover { background:var(--bct-hover); color:var(--bct-text); }
#bcvm-toolbar .bcvm-sync[aria-checked="true"] { color:var(--bct-brand-text); }
#bcvm-toolbar .bcvm-sync[data-retry="true"] { color:var(--bct-danger); }
#bcvm-toolbar .bcvm-sync[aria-disabled="true"] { color:var(--bct-text-muted); cursor:default; }
#bcvm-toolbar .bcvm-sync svg { width:17px; height:17px; pointer-events:none; }
#bcvm-toolbar .bcvm-remove { width:24px; height:24px; min-height:24px; color:var(--bct-danger); opacity:.8; }
#bcvm-toolbar .bcvm-remove:hover { background:color-mix(in srgb,var(--bct-danger) 12%,transparent); color:var(--bct-danger); opacity:1; }
#bcvm-toolbar .bcvm-remove svg { width:16px; height:16px; pointer-events:none; }
#bcvm-toolbar .bcvm-equalize { display:inline-flex; align-items:center; justify-content:center; gap:4px; min-height:32px; padding:4px 8px; border:0; background:var(--bct-surface-weak); font-size:12px; font-weight:500; }
#bcvm-toolbar .bcvm-equalize:not(:disabled):hover { background:var(--bct-hover); }
#bcvm-toolbar .bcvm-equalize svg { flex:none; width:14px; height:14px; color:var(--bct-brand-text); pointer-events:none; }
#bcvm-toolbar .bcvm-equalize:disabled { cursor:default; color:var(--bct-text-muted); opacity:.65; }
#bcvm-toolbar .bcvm-equalize:disabled svg { color:inherit; }
#bcvm-toolbar .bcvm-entry-status { position:absolute; width:1px; height:1px; padding:0; margin:-1px; border:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
#bcvm-toolbar .bcvm-entry:has(.bcvm-sync:is(:hover,:focus-visible)) .bcvm-entry-status { z-index:8; inset-inline-end:0; top:calc(100% - 4px); width:max-content; max-width:min(260px,calc(100vw - 64px)); height:auto; margin:0; padding:8px 10px; border:1px solid var(--bct-border); border-radius:var(--bct-radius-sm); background:var(--bct-surface); color:var(--bct-text); box-shadow:var(--bct-shadow); font-size:12px; line-height:1.5; white-space:normal; clip-path:none; pointer-events:none; }
#bcvm-toolbar .bcvm-help, #bcvm-toolbar .bcvm-empty { margin:0; color:var(--bct-text-muted); font-size:12px; line-height:1.6; }
#bcvm-toolbar .bcvm-empty { padding:16px 10px; border:1px dashed var(--bct-border-strong); border-radius:var(--bct-radius-md); text-align:center; overflow-wrap:anywhere; }
#bcvm-toolbar .bcvm-notice { padding:8px 10px; background:var(--bct-surface-weak); border-radius:var(--bct-radius-sm); color:var(--bct-text-muted); font-size:12px; line-height:1.5; }
#bcvm-toolbar :is(.bcvm-notice, .bcvm-results, .bcvm-list):empty,
#bcvm-toolbar .bcvm-list:has(.bcvm-entry) + .bcvm-empty { display:none; }
#bcvm-toolbar .bcvm-results button { display:flex; align-items:center; gap:8px; width:100%; text-align:start; }
#bcvm-toolbar .bcvm-results button span { min-width:0; overflow-wrap:anywhere; }
#bcvm-toolbar .bcvm-results img { width:24px; height:24px; border-radius:50%; object-fit:cover; }
#bcvm-toolbar details.bcvm-timeline { display:block; }
#bcvm-toolbar .bcvm-timeline summary { display:flex; align-items:center; gap:6px; min-height:28px; cursor:pointer; list-style:none; font-weight:700; font-size:12px; }
#bcvm-toolbar .bcvm-timeline summary::-webkit-details-marker { display:none; }
#bcvm-toolbar .bcvm-timeline summary::before { content:""; width:5px; height:5px; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:rotate(-45deg); margin-right:3px; }
#bcvm-toolbar .bcvm-timeline[open] summary::before { transform:rotate(45deg); }
#bcvm-toolbar .bcvm-timeline summary:focus-visible { outline:2px solid var(--bct-focus-ring); outline-offset:2px; border-radius:var(--bct-radius-sm); }
#bcvm-toolbar .bcvm-timeline-zone { margin-left:auto; color:var(--bct-text-muted); font-size:10px; font-weight:400; }
#bcvm-toolbar .bcvm-timeline-body { display:grid; gap:12px; padding-top:8px; min-width:0; }
#bcvm-toolbar .bcvm-timeline-list { padding:2px; min-width:0; overflow-x:auto; overscroll-behavior-x:contain; }
#bcvm-toolbar .bcvm-timeline-points { position:relative; isolation:isolate; height:${timelinePointHeight}px; margin:0; padding:0; list-style:none; }
#bcvm-toolbar .bcvm-timeline-point { position:absolute; top:0; left:0; z-index:var(--bcvm-point-layer); width:${timelineAvatarSize}px; height:${timelineAvatarSize}px; border-radius:50%; }
#bcvm-toolbar .bcvm-timeline-point::after { content:""; position:absolute; z-index:-1; top:100%; left:50%; height:${timelinePointHeight - timelineAvatarSize + 2}px; width:1px; background:var(--bct-border-strong); transform:skewX(var(--bcvm-stem-angle)); transform-origin:top center; pointer-events:none; }
#bcvm-toolbar .bcvm-timeline-time { position:absolute; top:calc(100% + 2px); left:50%; transform:translateX(-50%); display:grid; gap:1px; width:${timelinePointWidth}px; background:var(--bct-surface); color:var(--bct-text); font-size:10px; line-height:1.1; text-align:center; font-variant-numeric:tabular-nums; white-space:nowrap; pointer-events:none; }
#bcvm-toolbar .bcvm-timeline-time small { color:var(--bct-text-muted); font-size:9px; }
#bcvm-toolbar .bcvm-timeline-point[data-crowded="true"] .bcvm-timeline-time { visibility:hidden; }
#bcvm-toolbar .bcvm-timeline-point:focus-visible { z-index:${model.MAX_VIEWS * 2 + 2}; outline:2px solid var(--bct-focus-ring); outline-offset:1px; }
#bcvm-toolbar .bcvm-timeline-points:has(.bcvm-timeline-point:hover) .bcvm-timeline-time { visibility:hidden; }
#bcvm-toolbar .bcvm-timeline-points .bcvm-timeline-point:hover { z-index:${model.MAX_VIEWS * 2 + 1}; }
#bcvm-toolbar .bcvm-timeline-points .bcvm-timeline-point:hover .bcvm-timeline-time { visibility:visible; }
#bcvm-toolbar .bcvm-timeline-points:has(.bcvm-timeline-point:focus-visible) .bcvm-timeline-time { visibility:hidden; }
#bcvm-toolbar .bcvm-timeline-points .bcvm-timeline-point:focus-visible .bcvm-timeline-time { visibility:visible; }
#bcvm-toolbar .bcvm-timeline-person { display:flex; align-items:center; width:${timelineAvatarSize}px; }
#bcvm-toolbar .bcvm-timeline-person img, #bcvm-toolbar .bcvm-timeline-avatar { flex:none; width:${timelineAvatarSize}px; height:${timelineAvatarSize}px; box-sizing:border-box; border:1px solid var(--bct-border); border-radius:50%; object-fit:cover; background:var(--bct-surface); }
#bcvm-toolbar .bcvm-timeline-avatar { display:grid; place-items:center; background:var(--bct-surface-base); color:var(--bct-text-muted); font-size:11px; }
#bcvm-toolbar .bcvm-timeline-name { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
#bcvm-toolbar .bcvm-timeline-point[data-main="true"] :is(img,.bcvm-timeline-avatar) { border-color:var(--bct-brand-text); }
#bcvm-toolbar .bcvm-timeline-track { position:relative; height:4px; margin-inline:${timelinePointWidth / 2}px; border-radius:var(--bct-radius-full); background:var(--bct-border); }
#bcvm-toolbar .bcvm-timeline-overlap { position:absolute; height:4px; border-radius:inherit; background:var(--bct-brand-text); }
#bcvm-toolbar .bcvm-timeline-marker { display:none; position:absolute; left:var(--bcvm-current); top:-4px; width:2px; height:12px; background:var(--bct-text); transform:translateX(-50%); }
#bcvm-toolbar .bcvm-timeline-list[data-current="true"] .bcvm-timeline-marker { display:block; }
#bcvm-toolbar .bcvm-timeline-axis { display:flex; justify-content:space-between; gap:8px; padding-top:6px; color:var(--bct-text-muted); font-size:10px; font-variant-numeric:tabular-nums; }
#bcvm-toolbar .bcvm-timeline-axis time:last-child { text-align:end; }
#bcvm-toolbar .bcvm-timeline-now { color:var(--bct-text); font-size:11px; font-variant-numeric:tabular-nums; }
#bcvm-toolbar .bcvm-timeline-jump { justify-self:start; font-size:12px; }
#bcvm-toolbar .bcvm-timeline-jump:disabled { cursor:default; color:var(--bct-text-muted); background:var(--bct-surface-weak); }
@container bcvm-main (width < 860px) {
    #player_layout > .pzp-pc :is(#cheese-spanner-vod-broadcast-clock, .pzp-pc__vod-time) {
        position:absolute; bottom:calc(100% + 18px); margin:0;
    }
    #player_layout > .pzp-pc #cheese-spanner-vod-broadcast-clock { inset-inline-end:0; }
    #player_layout > .pzp-pc .pzp-pc__vod-time { inset-inline-start:0; }
}
@container bcvm-main (width < 350px) {
    #player_layout > .pzp-pc .pzp-pc__vod-time { display:none; }
}
@container bcvm-main (width < 220px) {
    #player_layout > .pzp-pc #cheese-spanner-vod-broadcast-clock .bcbc-label { display:none; }
}
@container bcvm-main (width < 560px) {
    #player_layout > .pzp-pc .pzp-pc__bottom-buttons-left { min-inline-size:0; max-inline-size:calc(100% - 40px); }
    #${LAUNCHER_ID} { order:-1; margin-left:0; z-index:1; }
}
#${PANEL_ID} .bcvm-screen { position:absolute; background:#000; pointer-events:auto; container-type:inline-size; }
#${PANEL_ID} .bcvm-screen > .pzp-pc { width: 100%; height: 100%; }
#${PANEL_ID} .bcvm-main-chrome { position:absolute; pointer-events:none; }
@media (prefers-reduced-motion: no-preference) {
    #player_layout[data-bcvm-motion] > .pzp-pc:not(:fullscreen),
    #player_layout[data-bcvm-motion] > #${PANEL_ID} > :is(.bcvm-screen, .bcvm-main-chrome) {
        transition:left .14s ease, top .14s ease, width .14s ease, max-width .14s ease, height .14s ease;
    }
}
#player_layout[data-bcvm-viewport] #${PANEL_ID} .bcvm-screen { box-shadow:var(--bct-shadow); }
#player_layout[data-bcvm-split] :is(.pzp-pc__video, .webplayer-internal-video) { touch-action:none; -webkit-user-drag:none; }
#${PANEL_ID} :is(.bcvm-grip, .bcvm-corner, .bcvm-tile-close) {
    position:absolute; z-index:46; border:0; color:#fff; opacity:0; pointer-events:none; touch-action:none;
}
#${PANEL_ID} .bcvm-grip {
    inset-block-start:6px; inset-inline-start:22px; max-inline-size:calc(100% - 44px); min-block-size:28px;
    border-radius:var(--bct-radius-sm); padding:4px 8px; background:#000b; cursor:grab;
    font:12px/1.4 var(--bct-font); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
#${PANEL_ID} a.bcvm-grip { box-sizing:border-box; text-decoration:none; }
#${PANEL_ID} a.bcvm-grip:is(:hover, :focus-visible) { text-decoration:underline; text-underline-offset:3px; }
#${PANEL_ID} .bcvm-screen > .bcvm-grip { max-inline-size:calc(100% - 82px); }
#${PANEL_ID} .bcvm-tile-close { display:inline-flex; align-items:center; justify-content:center; inset-block-start:6px; inset-inline-end:22px; width:28px; height:28px; padding:4px; box-sizing:border-box; border-radius:var(--bct-radius-sm); background:#000b; cursor:pointer; }
#${PANEL_ID} .bcvm-tile-close:hover { background:#000e; }
#${PANEL_ID} .bcvm-tile-close svg { width:18px; height:18px; pointer-events:none; }
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
#${PANEL_ID} [data-bcvm-tile]:is(:hover, :has(:focus-visible)) > :is(.bcvm-grip, .bcvm-corner, .bcvm-tile-close),
#${PANEL_ID} :is(.bcvm-grip, .bcvm-corner)[data-dragging],
#player_layout > .pzp-pc:is(:hover, :focus-visible, :has(:focus-visible)) ~ #${PANEL_ID} .bcvm-main-chrome > :is(.bcvm-grip, .bcvm-corner) {
    opacity:1; pointer-events:auto;
}
#${PANEL_ID} .bcvm-grip[data-dragging] { cursor:grabbing; }
#${PANEL_ID} .bcvm-drop-preview {
    position:absolute; z-index:48; display:grid; place-items:center; pointer-events:none; box-sizing:border-box;
    border:2px solid var(--bct-brand); background:color-mix(in srgb, var(--bct-brand) 15%, transparent);
    color:#fff; text-shadow:0 1px 3px #000; font:600 13px/1.4 var(--bct-font);
}
#${PANEL_ID} .bcvm-clock {
    display:inline-flex; align-items:center; flex:none; align-self:center; gap:4px; box-sizing:border-box;
    height:22px; margin-inline-start:auto; margin-inline-end:8px; padding:0 6px;
    border:1px solid rgb(255 255 255 / .2); border-radius:var(--bct-radius-full);
    background:rgb(0 0 0 / .38); color:#fff; font-family:inherit; font-size:12px; font-weight:700; line-height:16px;
    font-variant-numeric:tabular-nums; white-space:nowrap; pointer-events:none; user-select:none;
}
#${PANEL_ID} .bcvm-clock-label { opacity:.7; font-weight:600; }
#${PANEL_ID} .pzp-pc:not(.pzp-pc--controls) :is(.bcvm-clock, .pzp-pc__zoom-button):not(:focus-visible) { visibility:hidden; }
#${PANEL_ID} .pzp-pc__mute-indicator { display:none !important; }
@container (max-width: 560px) {
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .bcvm-clock { position:absolute; inset-inline-end:0; bottom:calc(100% + 4px); margin:0; }
}
@container (max-width: 220px) {
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .bcvm-clock-label { display:none; }
}
@container (max-width: 350px) {
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons { flex-wrap:wrap; gap:2px; padding-inline:4px; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) :is(.pzp-pc__bottom-buttons-left, .pzp-pc__bottom-buttons-right) { min-width:0; gap:1px; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons .pzp-button { width:26px; height:26px; min-width:0; padding:0; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons :is(.pzp-ui-icon, .bcac-icon) { width:24px; height:24px; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__bottom-buttons svg { max-width:100%; max-height:100%; }
    #${PANEL_ID} .pzp-pc:not(:fullscreen) .pzp-pc__vod-time { display:none; }
}
#${PANEL_ID} .bcvm-screen[data-unavailable="1"] > .pzp-pc:not(:fullscreen) { visibility: hidden; }
#${PANEL_ID} .bcvm-message { position:absolute; inset:0; display:grid; place-items:center; margin:0; padding:12px; color:#fff; text-align:center; font:13px/1.4 var(--bct-font); pointer-events:none; }
#${PANEL_ID} .bcvm-screen:has(> .pzp-pc):not([data-unavailable="1"]) .bcvm-message { display:none; }
#${PANEL_ID} .bcvm-divider { position:absolute; z-index:1; width:12px; padding:0; border:0; background:transparent; cursor:col-resize; transform:translateX(-50%); pointer-events:auto; touch-action:none; }
#${PANEL_ID} .bcvm-divider::before { content:""; position:absolute; inset:0 5px; pointer-events:none; }
#${PANEL_ID} .bcvm-divider:is(:hover, :focus-visible, [data-dragging])::before { background:var(--bct-brand); }
#${PANEL_ID} .bcvm-divider[aria-orientation="horizontal"] { height:12px; transform:translateY(-50%); cursor:row-resize; }
#${PANEL_ID} .bcvm-divider[aria-orientation="horizontal"]::before { inset:5px 0; }
${layoutView.bottomGripCss(`#${PANEL_ID} .bcvm-divider[data-bcvm-divider="bottom"]`)}
#${PANEL_ID} .bcvm-screen:not([data-bcvm-sync="false"]) :is(.pzp-pc__progress-slider, .pzp-setting-intro-playbackrate, .pzp-pc__setting-playbackrate-pane) {
    display: none !important;
}
#player_layout:is(.pip_mode, .miniplayer) :is(#${PANEL_ID}, #${LAUNCHER_ID}) { display:none !important; }
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

    function syncIcon(kind) {
        const icon = CheeseSpanner.multiviewView.panelIcon("close");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("stroke-width", "1.8");
        const ends = "M9 8H7a4 4 0 0 0 0 8h2M15 8h2a4 4 0 0 1 0 8h-2";
        icon.querySelector("path").setAttribute(
            "d",
            kind === "retry" ? "M20 8a8 8 0 1 0 0 8M20 3v5h-5" : ends + (kind === "on" ? "M8 12h8" : "M10 5l4 14")
        );
        return icon;
    }

    function updateStatus(entry, status, text = MESSAGES[status] || "") {
        entry.state = status;
        entry.status.textContent = text;
        entry.message.textContent = text;
        const retry = RETRY.has(status);
        const kind = retry ? "retry" : entry.syncEnabled ? "on" : "off";
        if (entry.sync.dataset.icon !== kind) {
            entry.sync.dataset.icon = kind;
            entry.sync.replaceChildren(syncIcon(kind));
        }
        entry.sync.dataset.retry = String(retry);
        entry.sync.setAttribute("aria-disabled", String(!retry && !entry.syncAvailable));
        entry.sync.setAttribute("role", retry ? "button" : "switch");
        if (retry) entry.sync.removeAttribute("aria-checked");
        else entry.sync.setAttribute("aria-checked", String(entry.syncEnabled));
        const name = entry.channel.textContent || `다시보기 ${entry.no}`;
        const action = retry ? "다시 시도" : "동기화";
        entry.sync.setAttribute("aria-label", `${name} ${action}`);
        entry.sync.title = retry ? `${text}\n${action}` : `동기화 ${entry.syncEnabled ? "켜짐" : "꺼짐"}\n${text}`;
        if (status !== "resync" && document.activeElement === entry.resync) entry.sync.focus({ preventScroll: true });
        entry.resync.hidden = status !== "resync";
        if (!entry.resync.hidden) entry.resync.setAttribute("aria-label", `${name} 다시 맞추기`);
        entry.screen.dataset.bcvmSync = String(entry.syncEnabled);
        entry.screen.dataset.unavailable = ["out-of-range", "unknown-time", "main-ended"].includes(status) ? "1" : "0";
    }

    function cancelLookup(current) {
        current.pending?.abort();
        current.pending = null;
    }

    function clearFollowing(current) {
        current.followingPending?.abort();
        current.followingPending = null;
        current.followingChannels = null;
        current.followingList.replaceChildren();
        current.followingStatus.textContent = "";
        current.followingPane.removeAttribute("aria-busy");
        current.followingRefresh.disabled = false;
    }

    // 같은 SDK 슬롯을 다른 영상이 재사용할 수 있어요. 실제 세션이 현재 소유한 미디어에서만 응답을 받아요.
    function readAuxAudio(current, entry) {
        const root = entry.screen.querySelector(":scope > .pzp-pc[data-bcmv-video]");
        const video = root?.querySelector("video.webplayer-internal-video");
        if (!video?.isConnected || root.dataset.bcvmVideoNo !== entry.no || !entry.request || !entry.info) return null;
        let status = null;
        const receive = (event) => {
            if (event.detail?.request === entry.request && event.detail?.id === entry.info.media.id)
                status = event.detail.status;
        };
        video.addEventListener(AUDIO_REFERENCE, receive);
        try {
            send(current.panel, { action: "read-audio", request: entry.request });
        } finally {
            video.removeEventListener(AUDIO_REFERENCE, receive);
        }
        return status ? { root, video, status } : null;
    }

    function soloPlayers(current) {
        const main = current.root.querySelector("video.webplayer-internal-video");
        return [
            { row: current.mainEntry, video: main },
            ...Array.from(current.entries.values(), (row) => {
                const player = row.screen.querySelector(":scope > .pzp-pc[data-bcmv-video]");
                const video =
                    player?.dataset.bcvmVideoNo === row.no && row.syncAvailable
                        ? player.querySelector("video.webplayer-internal-video")
                        : null;
                return { row, video };
            }),
        ];
    }

    function soloReason(players, selected) {
        if (players.length < 2) return "보조 영상을 추가하세요.";
        if (
            document.hidden ||
            players.some(
                ({ video }) =>
                    !video?.isConnected ||
                    video.readyState < 2 ||
                    video.seeking ||
                    video.error ||
                    video.ended ||
                    video.paused
            )
        )
            return "모든 영상이 재생된 뒤 사용할 수 있어요.";
        const target = players.find(({ row }) => row.solo === selected)?.video;
        if (!target || target.muted || !target.volume) return "이 영상의 음소거와 볼륨을 먼저 조절하세요.";
        if (
            players.some(
                ({ video }) =>
                    video !== target &&
                    !video.muted &&
                    video.volume > 0 &&
                    !CheeseSpanner.mainAudioOutput?.available(video)
            )
        )
            return "다른 영상의 음소거를 켜거나 해당 영상에서 컴프레서를 먼저 사용하세요.";
        return "";
    }

    function syncSoloButtons(current) {
        if (!current.mainEntry || (!current.open && !current.solo)) return;
        const players = soloPlayers(current);
        for (const { row } of players) {
            const button = row.solo;
            const active = current.solo?.button === button;
            const reason = active ? "" : soloReason(players, button);
            button.hidden = players.length < 2;
            button.setAttribute("aria-pressed", String(active));
            button.setAttribute("aria-disabled", String(!!reason));
            const label = active ? "단독 듣기 취소" : "이 영상만 듣기";
            if (button.textContent !== label) button.textContent = label;
            button.title = reason || button.textContent;
            button.setAttribute(
                "aria-label",
                [row.channel.textContent || row.title.textContent, button.textContent, reason]
                    .filter(Boolean)
                    .join(" · ")
            );
        }
    }

    function clearSolo(current) {
        const solo = current.solo;
        if (!solo) return;
        current.solo = null;
        solo.listeners.abort();
        solo.monitor.disconnect();
        for (const release of solo.releases) release();
        syncSoloButtons(current);
    }

    function toggleSolo(current, button, event) {
        if (!event.isTrusted || view !== current || route !== videoNoFromUrl(location.href) || !current.running) return;
        if (current.solo?.button === button) return clearSolo(current);
        const players = soloPlayers(current);
        const reason = soloReason(players, button);
        if (reason || [...current.entries.values()].some((entry) => !readAuxAudio(current, entry))) {
            current.notice.textContent = reason || "연결된 영상을 확인한 뒤 다시 선택하세요.";
            return;
        }
        clearSolo(current);
        const cancel = () => clearSolo(current);
        const listeners = new AbortController();
        const monitor = new MutationObserver((records) => {
            const next = soloPlayers(current);
            if (
                route !== videoNoFromUrl(location.href) ||
                next.length !== players.length ||
                next.some(({ video }, i) => !video?.isConnected || video !== players[i].video) ||
                records.some(
                    (record) => record.attributeName === "src" && players.some(({ video }) => video === record.target)
                )
            )
                cancel();
        });
        const releases = [];
        const solo = (current.solo = { button, listeners, monitor, releases });
        monitor.observe(current.host, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ["src", "data-bcvm-video-no"],
        });
        for (const { row, video } of players) {
            for (const name of ["volumechange", "play", "pause", "ended", "seeking", "emptied", "loadstart", "error"])
                video.addEventListener(name, cancel, { signal: listeners.signal });
            if (row.solo === button || video.muted || video.volume === 0) continue;
            const release = CheeseSpanner.mainAudioOutput?.hold(video, cancel);
            if (!release || current.solo !== solo) {
                release?.();
                cancel();
                current.notice.textContent = "다른 영상의 오디오 연결을 확인한 뒤 다시 선택하세요.";
                return;
            }
            releases.push(release);
        }
        current.notice.textContent = "";
        syncSoloButtons(current);
    }

    function replayIdentity(info) {
        if (!info?.media || !info.channelId) return null;
        const { videoNo, id, startMs, endMs, rewind } = info.media;
        return JSON.stringify([info.channelId, videoNo, id, startMs, endMs, Boolean(rewind)]);
    }

    function forgetRemovedAudio(current) {
        const undo = current.audioUndo;
        if (!undo) return;
        current.audioUndo = null;
        clearTimeout(undo.timer);
        undo.listeners.abort();
        if (document.activeElement === current.audioUndoButton) current.addToggle.focus({ preventScroll: true });
        current.audioUndoButton.hidden = true;
        current.audioUndoButton.textContent = "";
    }

    function rememberRemovedAudio(current, entry) {
        forgetRemovedAudio(current);
        const owned = readAuxAudio(current, entry);
        const mainVideo = current.root.querySelector("video.webplayer-internal-video");
        const mainIdentity = replayIdentity(current.mainInfo);
        const subIdentity = replayIdentity(entry.info);
        if (!owned || !mainVideo || !mainIdentity || !subIdentity) return;
        const undo = {
            no: entry.no,
            mainIdentity,
            subIdentity,
            mainVideo,
            muted: owned.video.muted,
            volume: owned.video.volume,
            expires: Date.now() + 5 * 60 * 1000,
            listeners: new AbortController(),
        };
        current.audioUndo = undo;
        const cancel = () => forgetRemovedAudio(current);
        undo.timer = setTimeout(cancel, 5 * 60 * 1000);
        for (const type of ["emptied", "loadstart"])
            mainVideo.addEventListener(type, cancel, { signal: undo.listeners.signal });
        const sound = undo.muted ? "음소거 유지" : "이전 음량과 같으면 소리 켜기";
        current.audioUndoButton.textContent = `${entry.info.title || "다시보기 " + entry.no} · 이전 음소거 상태로 다시 추가 (${sound})`;
        current.audioUndoButton.hidden = false;
    }

    function restoreRemovedAudio(current, event) {
        const undo = current.audioUndo;
        if (!event.isTrusted || !current.open || !current.addOpen || !undo || undo.entry || !canAdd(current)) return;
        if (
            Date.now() >= undo.expires ||
            undo.mainVideo !== current.root.querySelector("video.webplayer-internal-video") ||
            current.mainId !== videoNoFromUrl(location.href) ||
            current.entries.has(undo.no)
        ) {
            forgetRemovedAudio(current);
            return;
        }
        cancelLookup(current);
        current.audioUndoButton.hidden = true;
        const entry = selectSub(current, undo.no, undo);
        undo.entry = entry;
        // 긴 대기나 메인 시간 이동 뒤 자동 동기화가 뒤늦게 소리를 켜지 않게 해요.
        undo.expires = Math.min(undo.expires, Date.now() + 15000);
        clearTimeout(undo.timer);
        undo.timer = setTimeout(() => forgetRemovedAudio(current), Math.max(0, undo.expires - Date.now()));
        const cancel = () => forgetRemovedAudio(current);
        undo.mainVideo.addEventListener("seeking", cancel, { signal: undo.listeners.signal });
        for (const type of ["pointerdown", "keydown"])
            entry.screen.addEventListener(
                type,
                (event) => {
                    if (event.isTrusted) cancel();
                },
                { capture: true, signal: undo.listeners.signal }
            );
        setAddOpen(current, false);
        void loadSub(current, entry, null);
    }

    function restoreWhenReady(current, entry, status) {
        const undo = current.audioUndo;
        if (undo?.entry !== entry) return;
        if (Date.now() < undo.expires && ["loading", "syncing"].includes(status)) return;
        forgetRemovedAudio(current);
        if (undo.muted) return;
        const owned = readAuxAudio(current, entry);
        const fallback = "이전 음량이나 영상을 확인할 수 없어 음소거로 추가했습니다.";
        if (
            !["synced", "main-paused"].includes(status) ||
            owned?.status !== status ||
            !owned.video.muted ||
            Date.now() >= undo.expires ||
            undo.mainVideo !== current.root.querySelector("video.webplayer-internal-video") ||
            undo.volume <= 0 ||
            Math.abs(owned.video.volume - undo.volume) > 0.0001
        ) {
            current.notice.textContent = fallback;
            return;
        }
        const controls = owned.root.querySelectorAll(
            ".pzp-pc__volume-button:not([data-cheese-spanner-audio-compressor])"
        );
        if (controls.length === 1) controls[0].click();
        if (owned.video.muted || Math.abs(owned.video.volume - undo.volume) > 0.0001) {
            owned.video.muted = true;
            current.notice.textContent = fallback;
        }
    }

    function removeSub(current, entry) {
        clearSolo(current);
        if (current.audioUndo?.entry === entry) forgetRemovedAudio(current);
        entry.pending?.abort();
        if (entry.request) send(current.panel, { action: "stop", request: entry.request });
        current.entries.delete(entry.no);
        syncSoloButtons(current);
        if (!current.entries.size) current.restore?.abort();
        current.windows.delete(entry.no);
        entry.screen.remove();
        entry.row.remove();
        refreshLayout(current, "remove", entry.no);
        refreshTimeline(current);
    }

    function clearAll(current) {
        clearSolo(current);
        forgetRemovedAudio(current);
        setRunning(current, false);
        cancelLookup(current);
        clearFollowing(current);
        current.restore?.abort();
        current.restore = null;
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

    function createListEntry(current, no, main = false) {
        const row = element("li", main ? "bcvm-main-entry" : "bcvm-entry");
        const heading = element("div", "bcvm-row bcvm-entry-heading");
        const copy = element("div", "bcvm-entry-copy");
        const role = element("span", "bcvm-role", main ? "메인" : "");
        const channel = element("span", "bcvm-channel");
        channel.hidden = true;
        const title = element(main ? "span" : "a", "bcvm-title", `다시보기 ${no}`);
        if (!main) {
            title.href = `https://chzzk.naver.com/video/${no}`;
            title.title = "다시보기로 이동";
        }
        copy.append(role, channel, title);
        heading.append(copy);
        const solo = button("이 영상만 듣기", (event) => toggleSolo(current, solo, event));
        solo.className = "bcvm-solo";
        solo.hidden = true;
        row.append(heading, solo);
        return { row, heading, role, channel, title, solo };
    }

    function setListInfo(entry, info) {
        if (info.title) {
            entry.title.textContent = info.title;
            entry.title.title = info.title;
        }
        entry.channel.textContent = info.channelName || "";
        entry.channel.title = info.channelName || "";
        entry.channel.hidden = !info.channelName;
    }

    function setMainInfo(current, main) {
        if (main === current.mainInfo) return;
        current.mainInfo = main;
        setListInfo(current.mainEntry, main);
    }

    function showMainPageTitle(current) {
        if (current.mainInfo) return;
        const pageUrl = document.head.querySelector('meta[property="og:url"]')?.content;
        if (videoNoFromUrl(pageUrl) !== current.mainId) return;
        const label = document.head.querySelector('meta[property="og:title"]')?.content.trim();
        if (!label) return;
        // The native page joins the channel and video title. Keep ambiguous names intact until detail arrives.
        const parts = label.split(" - ");
        setListInfo(
            current.mainEntry,
            parts.length === 2 ? { channelName: parts[0], title: parts[1] } : { title: label }
        );
    }

    function selectSub(current, subNo, undo = null) {
        clearSolo(current);
        if (
            current.audioUndo &&
            current.audioUndo !== undo &&
            (current.audioUndo.no === subNo || current.audioUndo.entry)
        )
            forgetRemovedAudio(current);
        setRunning(current, true);
        const used = new Set([...current.entries.values()].map((entry) => entry.index));
        const index = Array.from({ length: maxAuxiliary }, (_, n) => n).find((n) => !used.has(n));
        const screen = element("div", "bcvm-screen");
        screen.dataset.bcmvVideo = "1";
        screen.dataset.bcvmSlot = String(index);
        const message = element("p", "bcvm-message");
        message.setAttribute("aria-hidden", "true");
        screen.append(message);
        const status = element("span", "bcvm-entry-status");
        status.id = `${PANEL_ID}-status-${subNo}`;
        status.setAttribute("role", "status");
        const entry = {
            ...createListEntry(current, subNo),
            no: subNo,
            index,
            screen,
            message,
            status,
            request: 0,
            syncEnabled: true,
            syncAvailable: false,
        };
        entry.tile = createTile(screen, subNo, `보조 다시보기 ${subNo}`, entry.title.href);
        const removeEntry = (event) => {
            if (view !== current || current.entries.get(subNo) !== entry) return;
            if (event.isTrusted) rememberRemovedAudio(current, entry);
            else forgetRemovedAudio(current);
            const remembered = rememberedReplays.get(current.mainId);
            remembered?.delete(subNo);
            if (remembered?.size === 0) rememberedReplays.delete(current.mainId);
            removeSub(current, entry);
            current.notice.textContent = "";
            (current.open ? current.addToggle : current.launcher).focus({ preventScroll: true });
        };
        const remove = button("", removeEntry);
        remove.setAttribute("aria-label", `다시보기 ${subNo} 빼기`);
        remove.title = "영상 빼기";
        remove.className = "bcvm-remove";
        remove.append(CheeseSpanner.multiviewView.panelIcon("remove"));
        const close = (entry.tile.close = button("", removeEntry));
        close.className = "bcvm-tile-close";
        close.title = "영상 빼기";
        close.setAttribute("aria-label", `다시보기 ${subNo} 빼기`);
        close.append(CheeseSpanner.multiviewView.panelIcon("close"));
        screen.append(close);
        entry.sync = button("", () => {
            if (view !== current || current.entries.get(subNo) !== entry) return;
            if (RETRY.has(entry.state)) {
                if (current.audioUndo?.entry === entry) forgetRemovedAudio(current);
                entry.pending?.abort();
                if (entry.request) send(current.panel, { action: "stop", request: entry.request });
                entry.request = 0;
                entry.info = null;
                entry.syncEnabled = true;
                entry.syncAvailable = false;
                updateStatus(entry, "loading");
                refreshTimeline(current);
                void loadSub(current, entry);
            } else if (entry.syncAvailable) {
                send(current.panel, { action: "sync", request: entry.request, enabled: !entry.syncEnabled });
            }
        });
        entry.sync.className = "bcvm-sync";
        entry.sync.setAttribute("aria-describedby", status.id);
        entry.resync = button("다시 맞추기", () => {
            if (view === current && current.entries.get(subNo) === entry && entry.state === "resync" && entry.request)
                send(current.panel, { action: "resync", request: entry.request });
        });
        entry.resync.className = "bcvm-resync";
        entry.resync.setAttribute("aria-describedby", status.id);
        const actions = element("div", "bcvm-entry-actions");
        actions.append(entry.resync, entry.sync, remove);
        entry.heading.append(actions);
        entry.row.append(status);
        current.entries.set(subNo, entry);
        syncSoloButtons(current);
        current.results.replaceChildren();
        current.list.append(entry.row);
        current.panel.append(screen);
        updateStatus(entry, "loading");
        refreshLayout(current, "add", subNo);
        refreshTimeline(current);
        return entry;
    }

    function startSub(current, entry, main, sub) {
        setListInfo(entry, sub);
        if (sub.channelName || sub.title) labelTile(entry.tile, sub.channelName || sub.title);
        if (main.status !== "ok" || sub.status !== "ok") {
            const status = main.status !== "ok" ? main.status : sub.status;
            const owner = main.status !== "ok" ? "메인" : "보조";
            updateStatus(entry, status, `${owner} 영상 · ${MESSAGES[status]}`);
            return;
        }
        if (
            main.media.id === sub.media.id ||
            [...current.entries.values()].some((item) => item !== entry && item.info?.media.id === sub.media.id)
        ) {
            const remembered = rememberedReplays.get(current.mainId);
            remembered?.delete(entry.no);
            if (remembered?.size === 0) rememberedReplays.delete(current.mainId);
            removeSub(current, entry);
            current.notice.textContent = "이미 화면에 있는 다시보기입니다.";
            return;
        }
        const undo = current.audioUndo;
        if (
            undo?.entry === entry &&
            (undo.mainIdentity !== replayIdentity(main) || undo.subIdentity !== replayIdentity(sub))
        ) {
            forgetRemovedAudio(current);
            current.notice.textContent = "영상 정보가 달라 음소거로 추가했습니다.";
        }
        entry.info = {
            media: sub.media,
            channelId: sub.channelId,
            title: sub.title,
            channelName: sub.channelName,
            channelImageUrl: sub.channelImageUrl,
        };
        refreshTimeline(current);
        const remembered = rememberedReplays.get(current.mainId) || new Set();
        remembered.add(entry.no);
        rememberedReplays.delete(current.mainId);
        rememberedReplays.set(current.mainId, remembered);
        if (rememberedReplays.size > maxRememberedMainVideos)
            rememberedReplays.delete(rememberedReplays.keys().next().value);
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
            rewind: sub.rewind,
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
        setAddOpen(current, false);
        await loadSub(current, entry);
    }

    async function loadSub(current, entry, mainInfo = current.mainInfo) {
        const subNo = entry.no;
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
                mainInfo || loadVideo(mainNo, { signal }),
                loadVideo(subNo, { signal, needsKey: true }),
            ]);
            if (!ownsEntry()) return;
            if (main.status === "ok") setMainInfo(current, main);
            startSub(current, entry, main, sub);
        } catch {
            if (ownsEntry()) updateStatus(entry, "lookup-error");
        } finally {
            if (entry.pending === pending) entry.pending = null;
            if (view === current && current.entries.get(subNo) === entry) refreshTimeline(current);
        }
    }

    async function restoreReplays(current, saved = rememberedReplays.get(current.mainId)) {
        if (!saved || current.entries.size) return;
        const numbers = [...saved].slice(0, maxAuxiliary);
        if (!numbers.length) return;
        const restore = (current.restore = new AbortController());
        const main = current.mainInfo || loadVideo(current.mainId, { signal: restore.signal });
        const entries = numbers.map((no) => selectSub(current, no));
        await Promise.all(entries.map((entry) => loadSub(current, entry, main)));
        if (current.restore === restore) current.restore = null;
    }

    function readPosition(current) {
        let position;
        const receive = (event) => {
            const { id, currentTime, duration } = event.detail || {};
            if (
                typeof id === "string" &&
                Number.isFinite(duration) &&
                duration > 0 &&
                Number.isFinite(currentTime) &&
                currentTime >= 0 &&
                currentTime <= duration
            )
                position = { id, currentTime, duration };
        };
        current.panel.addEventListener(REFERENCE, receive);
        try {
            send(current.panel, { action: "reference", videoNo: current.mainId });
        } finally {
            current.panel.removeEventListener(REFERENCE, receive);
        }
        return position;
    }

    function broadcastTime(main, position) {
        if (!position || position.id !== main.id || Math.abs(main.duration - position.duration) > 2) return;
        return main.startMs + Math.min(position.currentTime, main.duration) * 1000;
    }

    function timelineTime(at, label) {
        const node = element("time", "bcvm-timeline-time");
        const known = Number.isFinite(at);
        node.append(element("small", "", label));
        node.append(element("span", "", known ? formatKstTime(at, { seconds: true }) : "—"));
        if (known) {
            node.dateTime = new Date(at).toISOString();
            node.title = `${label} ${formatKstDateTime(at, { seconds: true })} (KST)`;
            node.setAttribute("aria-label", node.title);
        }
        return node;
    }

    function timelinePerson(info, fallback) {
        const name = info?.channelName || fallback;
        const person = element("div", "bcvm-timeline-person");
        person.title = name;
        const avatar = element("span", "bcvm-timeline-avatar", Array.from(name)[0] || "?");
        avatar.setAttribute("aria-hidden", "true");
        if (info?.channelImageUrl) {
            const image = element("img");
            image.alt = "";
            image.src = info.channelImageUrl;
            image.referrerPolicy = "no-referrer";
            image.addEventListener("error", () => image.replaceWith(avatar), { once: true });
            person.append(image);
        } else person.append(avatar);
        person.append(element("span", "bcvm-timeline-name", name));
        return person;
    }

    function renderTimeline(current) {
        current.timelineDirty = false;
        current.timelineSecond = undefined;
        current.timelineList.replaceChildren();
        current.timelinePoints = [];
        current.timelinePointList = null;
        current.timelineWidth = -1;
        current.timelineList.hidden = true;
        current.timelineRange = null;
        current.timelineJump.hidden = !current.entries.size;
        if (!current.entries.size) {
            current.timelineNote.textContent = "영상을 추가하면 타임라인이 표시됩니다.";
            return;
        }
        const rows = [
            { no: current.mainId, info: current.mainInfo, name: "메인" },
            ...[...current.entries.values()].map((entry) => ({
                no: entry.no,
                info: entry.info,
                name: `다시보기 ${entry.no}`,
            })),
        ];
        const known = rows.filter((row) => row.info?.media);
        const start = Math.min(...known.map(({ info }) => info.media.startMs));
        const end = Math.max(...known.map(({ info }) => info.media.endMs));
        const commonStart = Math.max(...known.map(({ info }) => info.media.startMs));
        const commonEnd = Math.min(...known.map(({ info }) => info.media.endMs));
        const complete = known.length === rows.length;
        const common = complete && commonStart < commonEnd ? { start: commonStart, end: commonEnd } : null;
        if (known.length) {
            current.timelineRange = { start, end, common };
            current.timelineList.hidden = false;
        }
        const position = (at) => `${((at - start) / (end - start)) * 100}%`;
        if (known.length) {
            const points = (current.timelinePointList = element("ul", "bcvm-timeline-points"));
            points.setAttribute("aria-label", "방송별 시작과 종료 지점");
            for (const row of known) {
                for (const [boundary, label, at] of [
                    ["start", "시작", row.info.media.startMs],
                    ["end", "종료", row.info.media.endMs],
                ]) {
                    const item = element("li", "bcvm-timeline-point");
                    item.dataset.videoNo = row.no;
                    item.dataset.main = String(row.no === current.mainId);
                    item.dataset.boundary = boundary;
                    item.tabIndex = 0;
                    item.style.setProperty("--bcvm-position", position(at));
                    item.setAttribute(
                        "aria-label",
                        `${row.no === current.mainId ? "메인 · " : ""}${row.info.channelName || row.name} · ${label} ${formatKstDateTime(at, { seconds: true })} (KST)`
                    );
                    item.title = item.getAttribute("aria-label");
                    item.append(timelinePerson(row.info, row.name), timelineTime(at, label));
                    current.timelinePoints.push({ node: item, at, ratio: (at - start) / (end - start) });
                }
            }
            current.timelinePoints.sort((a, b) => a.at - b.at);
            points.append(...current.timelinePoints.map(({ node }) => node));
            const track = element("div", "bcvm-timeline-track");
            track.setAttribute("aria-hidden", "true");
            if (common) {
                const overlap = element("span", "bcvm-timeline-overlap");
                overlap.style.left = position(common.start);
                overlap.style.width = `${((common.end - common.start) / (end - start)) * 100}%`;
                track.append(overlap);
            }
            track.append(element("span", "bcvm-timeline-marker"));
            const axis = element("div", "bcvm-timeline-axis");
            for (const at of [start, end]) {
                const time = element("time", "", formatKstDateTime(at).slice(5));
                time.dateTime = new Date(at).toISOString();
                axis.append(time);
            }
            const plot = element("div", "bcvm-timeline-plot");
            plot.style.minWidth = `${timelinePointWidth + (current.timelinePoints.length - 1) * timelineMinSpacing}px`;
            plot.append(points, track, axis);
            current.timelineList.append(plot);
            layoutTimelinePoints(current);
        }
        current.timelineNote.textContent = !complete
            ? "방송 시각이 확인된 영상부터 표시합니다."
            : common
              ? `공통 구간 ${formatKstDateTime(common.start).slice(5)} ~ ${formatKstDateTime(common.end).slice(5)}`
              : "모든 영상이 함께 겹치는 구간은 없습니다.";
        current.timelineJump.title = common ? `${formatKstDateTime(common.start, { seconds: true })}로 이동` : "";
    }

    function layoutTimelinePoints(current) {
        if (view !== current || !current.open || !current.timeline.open || document.hidden) return;
        const width = current.timelinePointList?.clientWidth || 0;
        if (!width || current.timelineWidth === width) return;
        current.timelineWidth = width;
        const padding = timelinePointWidth / 2;
        const points = current.timelinePoints;
        const anchors = points.map(({ ratio }) => padding + ratio * (width - timelinePointWidth));
        const groups = [];
        // Pool crowded centers to make the smallest shifts that keep over half of each portrait visible.
        for (let index = 0; index < points.length; index++) {
            groups.push({ first: index, count: 1, total: anchors[index] - index * timelineMinSpacing });
            while (groups.length > 1) {
                const last = groups.at(-1);
                const previous = groups.at(-2);
                if (previous.total / previous.count <= last.total / last.count) break;
                previous.total += last.total;
                previous.count += last.count;
                groups.pop();
            }
        }
        const centers = [];
        const limit = width - padding - (points.length - 1) * timelineMinSpacing;
        for (const group of groups) {
            const center = Math.max(padding, Math.min(limit, group.total / group.count));
            for (let index = group.first; index < group.first + group.count; index++)
                centers[index] = center + index * timelineMinSpacing;
        }
        for (const [index, { node }] of points.entries()) {
            const center = centers[index];
            node.style.left = `${center - timelineAvatarSize / 2}px`;
            node.style.setProperty("--bcvm-point-layer", String(index + 1));
            node.style.setProperty(
                "--bcvm-stem-angle",
                `${Math.atan2(anchors[index] - center, timelinePointHeight - timelineAvatarSize + 2)}rad`
            );
            node.dataset.crowded = String(
                center - centers[index - 1] < timelinePointWidth + 6 ||
                    centers[index + 1] - center < timelinePointWidth + 6
            );
        }
    }

    function updateTimelineCursor(current) {
        if (view !== current || !current.open || !current.timeline.open || document.hidden) return;
        const range = current.timelineRange;
        const at =
            current.mainInfo?.media && range ? broadcastTime(current.mainInfo.media, readPosition(current)) : undefined;
        const known = Number.isFinite(at) && at >= range.start && at <= range.end;
        const disabled =
            !known ||
            !range.common ||
            range.common.start - current.mainInfo.media.startMs >= current.timelineVideo.duration * 1000;
        if (current.timelineJump.disabled !== disabled) current.timelineJump.disabled = disabled;
        const second = known ? Math.floor(at / 1000) : null;
        if (current.timelineSecond === second) return;
        current.timelineSecond = second;
        current.timelineList.dataset.current = String(known);
        current.timelineNow.hidden = !range;
        current.timelineNow.textContent = known ? `현재 ${formatKstTime(at, { seconds: true })}` : "현재 시각 확인 중";
        if (known)
            current.timelineList.style.setProperty(
                "--bcvm-current",
                `${((at - range.start) / (range.end - range.start)) * 100}%`
            );
    }

    function syncTimeline(current) {
        const active =
            view === current && current.open && current.timeline.open && current.panel.isConnected && !document.hidden;
        const video = active ? current.root.querySelector("video.webplayer-internal-video") : null;
        if (video !== current.timelineVideo) {
            current.timelineListeners?.abort();
            current.timelineListeners = null;
            current.timelineVideo = video;
            current.timelineSecond = undefined;
            if (video) {
                current.timelineListeners = new AbortController();
                for (const name of [
                    "timeupdate",
                    "loadedmetadata",
                    "durationchange",
                    "emptied",
                    "seeking",
                    "seeked",
                    "playing",
                    "pause",
                ])
                    video.addEventListener(name, () => updateTimelineCursor(current), {
                        signal: current.timelineListeners.signal,
                    });
            }
        }
        if (!active) {
            current.timelineResize?.disconnect();
            current.timelineObserved = false;
            return;
        }
        if (current.timelineDirty) renderTimeline(current);
        if (current.timelineResize && !current.timelineObserved) {
            current.timelineResize.observe(current.timelineList);
            current.timelineObserved = true;
            layoutTimelinePoints(current);
        }
        updateTimelineCursor(current);
    }

    function refreshTimeline(current) {
        current.timelineDirty = true;
        syncTimeline(current);
    }

    function createTimeline(current) {
        const timeline = element("details", "bcvm-section bcvm-timeline");
        current.timeline = timeline;
        current.timelineDirty = true;
        const summary = element("summary", "", "타임라인");
        summary.append(element("span", "bcvm-timeline-zone", "KST"));
        const body = element("div", "bcvm-timeline-body");
        current.timelineList = element("div", "bcvm-timeline-list");
        current.timelineList.setAttribute("role", "group");
        current.timelineList.setAttribute("aria-label", "영상별 방송 구간");
        current.timelineNow = element("span", "bcvm-timeline-now");
        current.timelineNote = element("p", "bcvm-help");
        current.timelineNote.setAttribute("role", "status");
        current.timelineJump = button("공통 구간으로 이동", () => {
            if (view !== current || !current.open || !timeline.open || !current.timelineRange?.common) return;
            send(current.panel, {
                action: "seek",
                main: current.mainInfo.media,
                at: current.timelineRange.common.start,
            });
            updateTimelineCursor(current);
        });
        current.timelineJump.className = "bcvm-timeline-jump";
        current.timelineJump.disabled = true;
        body.append(current.timelineNow, current.timelineList, current.timelineNote, current.timelineJump);
        timeline.append(summary, body);
        timeline.addEventListener("toggle", () => refreshTimeline(current), { signal: current.listeners.signal });
        document.addEventListener("visibilitychange", () => syncTimeline(current), {
            signal: current.listeners.signal,
        });
        if (typeof ResizeObserver === "function")
            current.timelineResize = new ResizeObserver(() => layoutTimelinePoints(current));
        else
            window.addEventListener("resize", () => layoutTimelinePoints(current), {
                signal: current.listeners.signal,
            });
        return timeline;
    }

    async function addChannel(current, channel) {
        if (!current.open || !current.addOpen || !canAdd(current)) return;
        cancelLookup(current);
        const pending = (current.pending = new AbortController());
        const { signal } = pending;
        const mainNo = route;
        current.notice.textContent = `${channel.name}의 다시보기를 확인하고 있습니다.`;
        try {
            const selectedPosition = readPosition(current);
            const main = current.mainInfo || (await loadVideo(mainNo, { signal }));
            if (!isCurrent(current, pending, mainNo)) return;
            if (main.status !== "ok") {
                current.notice.textContent = `메인 영상 · ${MESSAGES[main.status]}`;
                return;
            }
            setMainInfo(current, main);
            const at = broadcastTime(main.media, selectedPosition);
            const sub = await findReplay(channel.id, main.media, { signal, at, excluded: current.entries.keys() });
            if (!isCurrent(current, pending, mainNo)) return;
            if (sub.status !== "ok") {
                current.notice.textContent = MESSAGES[sub.status];
                return;
            }
            if (!canAdd(current) || current.entries.has(sub.media.videoNo)) return;
            current.notice.textContent = "";
            const entry = selectSub(current, sub.media.videoNo);
            setAddOpen(current, false);
            startSub(current, entry, main, sub);
        } catch {
            if (isCurrent(current, pending, mainNo)) current.notice.textContent = MESSAGES["lookup-error"];
        } finally {
            if (current.pending === pending) current.pending = null;
        }
    }

    function renderChannels(current, list, channels) {
        list.replaceChildren();
        for (const channel of channels) {
            const row = element("li");
            const select = button("", () => void addChannel(current, channel));
            select.append(element("span", "", channel.name));
            if (channel.image) {
                const image = element("img");
                image.alt = "";
                image.src = channel.image;
                image.loading = "lazy";
                image.referrerPolicy = "no-referrer";
                image.addEventListener("error", () => image.remove(), { once: true });
                select.prepend(image);
            }
            row.append(select);
            list.append(row);
        }
    }

    function filterFollowing(current) {
        if (!current.followingChannels) return;
        const keyword = current.followingInput.value.trim().toLocaleLowerCase("ko-KR");
        const channels = current.followingChannels.filter((channel) =>
            channel.name.toLocaleLowerCase("ko-KR").includes(keyword)
        );
        renderChannels(current, current.followingList, channels);
        current.followingStatus.textContent = !current.followingChannels.length
            ? "팔로잉한 채널이 없습니다."
            : !channels.length
              ? "일치하는 팔로잉 채널이 없습니다."
              : `${channels.length}개 채널 · 선택하면 메인과 방송 시간이 겹치는 다시보기를 찾습니다.`;
    }

    async function showFollowing(current) {
        if (view !== current || !current.open || !current.addOpen || current.addTab !== "following") return;
        cancelLookup(current);
        clearFollowing(current);
        const pending = (current.followingPending = new AbortController());
        const mainNo = route;
        const ownsRequest = () =>
            view === current &&
            current.open &&
            current.addOpen &&
            current.addTab === "following" &&
            current.followingPending === pending &&
            !pending.signal.aborted &&
            current.panel.isConnected &&
            route === mainNo &&
            videoNoFromUrl(location.href) === mainNo;
        current.notice.textContent = "";
        current.followingStatus.textContent = "팔로잉 목록을 불러오고 있습니다.";
        current.followingPane.setAttribute("aria-busy", "true");
        current.followingRefresh.disabled = true;
        try {
            const result = await loadFollowing({ signal: pending.signal });
            if (!ownsRequest()) return;
            if (result.status === "ok") {
                current.followingChannels = result.channels;
                filterFollowing(current);
            } else {
                current.followingStatus.textContent =
                    result.status === "login-required"
                        ? "치지직에 로그인한 뒤 새로고침해 주세요."
                        : "팔로잉 목록을 불러오지 못했습니다. 새로고침해 주세요.";
            }
        } catch {
            if (ownsRequest())
                current.followingStatus.textContent = "팔로잉 목록을 불러오지 못했습니다. 새로고침해 주세요.";
        } finally {
            if (current.followingPending === pending) {
                current.followingPending = null;
                current.followingPane.removeAttribute("aria-busy");
                current.followingRefresh.disabled = false;
            }
        }
    }

    function setAddTab(current, name) {
        if (view !== current || !current.addOpen || current.addTab === name) return;
        cancelLookup(current);
        clearFollowing(current);
        current.notice.textContent = "";
        current.results.replaceChildren();
        current.addTab = name;
        for (const tab of current.addTabs.children) {
            const selected = tab.dataset.bcvmAddTab === name;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            document.getElementById(tab.getAttribute("aria-controls")).hidden = !selected;
        }
        if (name === "following" && current.open) void showFollowing(current);
    }

    function setAddOpen(current, open, focus = true) {
        if (view !== current || current.addOpen === open) return;
        current.addOpen = open;
        current.addSection.hidden = !open;
        current.addToggle.setAttribute("aria-expanded", String(open));
        if (open) {
            if (current.open && current.addTab === "following") void showFollowing(current);
        } else {
            cancelLookup(current);
            clearFollowing(current);
            current.results.replaceChildren();
            current.notice.textContent = "";
            current.input.value = "";
            current.submit.textContent = "검색";
        }
        if (current.open) {
            positionToolbar(current);
            if (focus)
                (open
                    ? current.addTab === "following"
                        ? current.followingInput
                        : current.input
                    : current.addToggle
                ).focus({
                    preventScroll: true,
                });
        }
    }

    async function search(current, keyword) {
        if (!current.open || !current.addOpen || !canAdd(current)) return;
        cancelLookup(current);
        const pending = (current.pending = new AbortController());
        const mainNo = route;
        current.results.replaceChildren();
        current.notice.textContent = "채널을 검색하고 있습니다.";
        try {
            const channels = await searchChannels(keyword, { signal: pending.signal });
            if (!isCurrent(current, pending, mainNo)) return;
            renderChannels(current, current.results, channels);
            current.notice.textContent = channels.length
                ? "채널을 선택하면 메인과 같은 방송 시각의 다시보기를 찾습니다."
                : "검색 결과가 없습니다.";
        } catch {
            if (isCurrent(current, pending, mainNo)) current.notice.textContent = "채널을 검색하지 못했습니다.";
        } finally {
            if (current.pending === pending) current.pending = null;
        }
    }

    function observeToolbarAnchors(current, anchors) {
        for (const node of current.toolbarAnchors) {
            if (!anchors.includes(node)) current.toolbarResize?.unobserve(node);
        }
        for (const node of anchors) {
            if (!current.toolbarAnchors.includes(node)) current.toolbarResize?.observe(node);
        }
        current.toolbarAnchors = anchors;
    }

    function positionToolbar(current) {
        if (!current.open || !current.host.isConnected) return;
        const { host, toolbar } = current;
        const video = dockBounds(current);
        const anchors = [];
        let sidebar;
        let top;
        for (const aside of document.querySelectorAll(SIDEBAR)) {
            anchors.push(aside);
            const header = aside.querySelector(SIDEBAR_HEADER);
            if (!header) continue;
            anchors.push(header);
            const bounds = aside.getBoundingClientRect();
            const heading = header.getBoundingClientRect();
            const offset = heading.bottom - bounds.top + 8;
            const style = getComputedStyle(aside);
            const besideVideo =
                bounds.left >= video.right - 1 ||
                bounds.right <= video.left + 1 ||
                bounds.top >= video.bottom - 1 ||
                bounds.bottom <= video.top + 1;
            if (
                !besideVideo ||
                bounds.width < 180 ||
                bounds.left < 0 ||
                bounds.right > window.innerWidth ||
                !heading.height ||
                offset < 8 ||
                bounds.height - offset < 96 ||
                style.position === "static" ||
                style.display === "none" ||
                style.visibility === "hidden"
            )
                continue;
            sidebar = aside;
            top = offset;
            break;
        }
        const previousSidebar = toolbar.parentElement?.matches(SIDEBAR) ? toolbar.parentElement : null;
        if (!sidebar && previousSidebar) {
            const bounds = previousSidebar.getBoundingClientRect();
            const style = getComputedStyle(previousSidebar);
            if (
                !previousSidebar.isConnected ||
                !bounds.width ||
                !bounds.height ||
                style.display === "none" ||
                style.visibility === "hidden"
            ) {
                setOpen(current, false, current.launcher);
                return;
            }
        }
        observeToolbarAnchors(current, anchors);
        const row = host.closest(PLAYER_ROW) || host;
        const focused = toolbar.contains(document.activeElement) ? document.activeElement : null;
        if (sidebar) {
            toolbar.dataset.placement = "sidebar";
            toolbar.style.setProperty("--bcvm-toolbar-top", `${top}px`);
            if (toolbar.parentElement !== sidebar) sidebar.append(toolbar);
        } else {
            toolbar.dataset.placement = "below";
            const rowLeft = row.getBoundingClientRect().left;
            const right = Math.min(video.right, window.innerWidth);
            const width = Math.min(360, right - Math.max(0, rowLeft, video.left) - 16);
            if (width > 0) {
                const left = right - rowLeft - width - 8;
                toolbar.style.setProperty("--bcvm-toolbar-left", `${left}px`);
                toolbar.style.setProperty("--bcvm-toolbar-width", `${width}px`);
            } else {
                toolbar.style.removeProperty("--bcvm-toolbar-left");
                toolbar.style.removeProperty("--bcvm-toolbar-width");
            }
            if (toolbar.previousElementSibling !== row) row.after(toolbar);
        }
        if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }

    function syncChatButton(current) {
        const header = document.querySelector("aside#vod-aside")?.querySelector(SIDEBAR_HEADER);
        const menu = header?.querySelector(CHAT_MENU);
        for (const node of document.querySelectorAll(`#${CHAT_BUTTON_ID}`)) {
            if (node !== current.chatButton) node.remove();
        }
        if (!current.running || !menu) {
            current.chatButton?.remove();
            return;
        }
        if (!current.chatButton) {
            const trigger = (current.chatButton = button("", (event) => {
                event.stopPropagation();
                if (view !== current || !current.running) return;
                setOpen(current, !current.open, trigger);
            }));
            trigger.id = CHAT_BUTTON_ID;
            trigger.dataset.bcvm = "1";
            trigger.title = "다시보기 멀티뷰 설정";
            trigger.setAttribute("aria-label", trigger.title);
            trigger.setAttribute("aria-controls", "bcvm-toolbar");
            const icon = CheeseSpanner.multiviewView?.multiviewIcon();
            if (icon) trigger.append(icon);
        }
        const anchor = menu.closest('[data-bcct-moderator-actions="1"]') || menu;
        if (current.chatButton.nextElementSibling !== anchor) anchor.before(current.chatButton);
        current.chatButton.setAttribute("aria-expanded", String(current.open));
        current.chatButton.disabled = layoutSuspended(current);
    }

    function setRunning(current, running) {
        if (current.running === running) return;
        current.running = running;
        syncChatButton(current);
    }

    function setOpen(current, open, trigger, { focus = true } = {}) {
        if (open && layoutSuspended(current)) return;
        if (trigger) current.toolbarTrigger = trigger;
        current.open = open;
        syncSoloButtons(current);
        current.panel.dataset.open = open ? "1" : "0";
        current.toolbar.hidden = !open;
        current.chatButton?.setAttribute("aria-expanded", String(open));
        refreshTimeline(current);
        if (open) {
            showMainPageTitle(current);
            positionToolbar(current);
        } else {
            setAddOpen(current, false, false);
            observeToolbarAnchors(current, []);
            cancelLookup(current);
            clearFollowing(current);
            current.notice.textContent = "";
        }
        if (focus) {
            const returnFocus = current.toolbarTrigger?.isConnected ? current.toolbarTrigger : current.launcher;
            (open ? current.addToggle : returnFocus).focus({
                preventScroll: !open || current.toolbar.dataset.placement === "sidebar",
            });
        }
    }

    function toggleMultiview(current) {
        if (current.running) {
            clearAll(current);
            current.results.replaceChildren();
            current.notice.textContent = "";
            setOpen(current, false, current.launcher);
            return;
        }
        setRunning(current, true);
        drawLayout(current);
        setOpen(current, true, current.launcher);
        void restoreReplays(current);
    }

    const percent = (n) => `${n * 100}%`;
    const dimensions = ["left", "top", "width", "height"];
    const corners = { nw: "왼쪽 위", ne: "오른쪽 위", sw: "왼쪽 아래", se: "오른쪽 아래" };
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

    function createTile(node, id, label, href) {
        node.dataset.bcvmTile = id;
        const grip = href ? element("a") : button("");
        if (href) {
            grip.href = href;
            grip.draggable = false;
        }
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
        const linked = tile.grip.hasAttribute("href");
        tile.grip.title = linked ? "다시보기로 이동" : "드래그하거나 방향키로 영상 위치 이동";
        tile.grip.setAttribute("aria-label", linked ? `${label} 다시보기로 이동` : `${label} 영상 이동`);
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
        return Boolean(document.fullscreenElement || current.host.matches(".pip_mode, .miniplayer"));
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
            if (!id || current.windows.has(id)) continue;
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
        const cells = model.orderedCells(current.cells, current.mainId);
        const focused = current.list.contains(document.activeElement) ? document.activeElement : null;
        let next = current.mainEntry.row.nextElementSibling;
        for (const [index, { id }] of cells.entries()) {
            if (id === current.mainId) continue;
            const { row, role } = current.entries.get(id);
            const label = `서브 ${index}`;
            if (role.textContent !== label) role.textContent = label;
            if (row !== next) current.list.insertBefore(row, next);
            next = row.nextElementSibling;
        }
        if (focused && document.activeElement !== focused) focused.focus({ preventScroll: true });
    }

    function refreshLayout(current, change, id) {
        endGesture(current, false);
        const subs = [...current.entries.keys()];
        const { mainId } = current;
        current.customLayout = Boolean(change && subs.length && current.customLayout);
        if (current.customLayout) {
            current.tree =
                change === "add" ? model.addTree(current.tree, id, mainId) : model.removeTree(current.tree, id);
        } else {
            current.tree = model.defaultTree([mainId, ...subs].map((id) => ({ id })));
        }
        for (const divider of current.dividers.values()) divider.remove();
        current.dividers.clear();
        drawLayout(current);
    }

    function drawLayout(current) {
        syncViewport(current);
        const { host, panel, launcher, entries, viewport } = current;
        const active = Boolean(entries.size || viewport);
        const suspended = layoutSuspended(current);
        panel.hidden = !active;
        launcher.toggleAttribute("data-active", current.running);
        launcher.setAttribute("aria-pressed", String(current.running));
        const launcherLabel = current.running ? "다시보기 멀티뷰 끄기" : "다시보기 멀티뷰 켜기";
        launcher.setAttribute("aria-label", launcherLabel);
        syncPlayerButtonTooltip(launcher, launcherLabel);
        launcher.disabled = suspended;
        if (current.chatButton) current.chatButton.disabled = suspended;
        current.freeToggle.setAttribute("aria-pressed", String(current.free));
        current.freeToggle.disabled = suspended;
        if (!current.drag) {
            current.equalize.disabled =
                suspended || current.free || !model.equalizeAuxiliaries(current.tree, current.mainId);
            current.equalize.title = current.free
                ? "자유 배치 해제 시 분할 영역별 정렬 가능"
                : current.equalize.disabled
                  ? "같은 영역에 보조 영상 2개 이상일 때 사용 가능"
                  : "메인 영역 유지, 보조 영역 영상들을 동일 크기로 정렬";
        }
        host.toggleAttribute("data-bcvm-split", active);
        host.toggleAttribute("data-bcvm-motion", active && !viewport && !suspended && !current.drag?.handle);
        if (!viewport) host.style.removeProperty("--bcvm-main-layer");
        current.layout = model.splitLayout(current.drag?.previewTree || current.tree);
        current.cells = viewport ? freeCells(current, current.layout.cells) : current.layout.cells;
        if (!current.drag) syncPanelOrder(current);
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
            tile.close?.toggleAttribute("hidden", suspended);
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
            const divider = current.dividers.get(handle.key) || bindDivider(current, handle.key);
            layoutView.drawDivider(divider, handle);
        }
        const drop = current.drag?.drop;
        current.preview.hidden = !drop;
        if (drop) {
            positionRect(current.preview, current.cells.find(({ id }) => id === current.drag.tile.id).rect);
            current.preview.textContent = drop.label;
        }
    }

    function bindDivider(current, key) {
        const divider = key === "bottom" ? element("div") : button("");
        divider.className = "bcvm-divider";
        divider.dataset.bcvmDivider = key;
        divider.setAttribute("role", "separator");
        const getHandle = () => current.layout.handles.find((item) => item.key === key);
        divider.addEventListener("dblclick", () => resizeDivider(current, getHandle(), 0.5));
        current.dividers.set(key, divider);
        current.panel.append(divider);
        if (key === "bottom") return divider;
        divider.addEventListener("keydown", (event) => {
            const handle = getHandle();
            if (!handle || divider.hidden) return;
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
            resizeDivider(current, handle, Math.min(next, handle.upper));
        });
        return divider;
    }

    function resizeDivider(current, handle, ratio) {
        if (!handle) return;
        current.tree = model.resizeSplit(current.tree, handle, ratio);
        current.customLayout = true;
        drawLayout(current);
    }

    function dockTile(current, tree, source, target, side, path) {
        if (target && side === "center" && (source === current.mainId || target === current.mainId)) {
            // Reorder the boxes even when one is the native main. The route still owns playback and chat.
            return model.mapTree(tree, (id) => (id === source ? target : id === target ? source : id));
        }
        return model.dockTree(tree, source, target, target === null ? "fill" : side, current.mainId, path);
    }

    function findDrop(drag, x, y) {
        const row = model.bottomRowDrop(
            drag.tree,
            drag.cells,
            drag.tile.id,
            drag.bounds,
            drag.drop?.side === "bottom-row",
            x,
            y
        );
        if (row) return { ...row, label: "하단에 배치" };
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
        const side = cell.id && distance < 0.25 ? edge : "center";
        const labels = {
            left: "왼쪽에 배치",
            right: "오른쪽에 배치",
            top: "위에 배치",
            bottom: "아래에 배치",
            center: "이 위치로 이동",
        };
        return { id: cell.id, path: cell.path, side, label: labels[side] };
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
            if (handle?.key !== "bottom") current.drag.control.focus({ preventScroll: true });
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
            drag.previewTree = model.resizeSplit(drag.tree, drag.handle, result.value);
        } else if (drag.free) {
            const x = dx / drag.bounds.width;
            const y = dy / drag.bounds.height;
            drag.previewRect = drag.corner
                ? model.resizeWindow(drag.rect, drag.corner, x, y, drag.bounds)
                : model.moveWindow(drag.rect, x, y);
        } else {
            const drop = findDrop(drag, event.clientX, event.clientY);
            if (started && drop?.path === drag.drop?.path && drop?.side === drag.drop?.side) return;
            drag.drop = drop;
            drag.previewTree = drop
                ? drop.tree || dockTile(current, drag.tree, drag.tile.id, drop.id, drop.side, drop.path)
                : null;
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
            current.tree = dockTile(current, current.tree, tile.id, nearest.id, "center", nearest.path);
            current.customLayout = true;
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
            running: false,
            free: false,
            viewport: false,
            toolbarAnchors: [],
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
            toggleMultiview(current);
            // A later seek key must not reveal a focus ring left by a pointer click.
            if (event.detail > 0) launcher.blur();
        }));
        launcher.id = LAUNCHER_ID;
        launcher.className = "pzp-button";
        launcher.dataset.bcvm = "1";
        const icon = CheeseSpanner.multiviewView?.multiviewIcon();
        if (icon) launcher.append(icon);
        launcher.setAttribute("aria-controls", PANEL_ID);
        const toolbar = (current.toolbar = element("div", "bcvm-toolbar"));
        toolbar.id = "bcvm-toolbar";
        toolbar.dataset.bcvm = "1";
        toolbar.setAttribute("role", "group");
        toolbar.setAttribute("aria-label", "다시보기 멀티뷰 조작");
        const heading = element("div", "bcvm-row bcvm-heading");
        const title = element("strong", "", "다시보기 멀티뷰");
        const tools = element("div", "bcvm-heading-tools");
        current.addOpen = false;
        current.addToggle = button("추가", () => setAddOpen(current, !current.addOpen));
        current.addToggle.className = "bcvm-add-toggle";
        current.addToggle.prepend(CheeseSpanner.multiviewView.panelIcon("add"));
        current.addToggle.setAttribute("aria-label", "영상 추가");
        current.addToggle.setAttribute("aria-expanded", "false");
        current.addToggle.setAttribute("aria-controls", `${PANEL_ID}-add`);
        const close = button("", () => setOpen(current, false));
        close.className = "bcvm-close";
        close.title = "패널 닫기";
        close.setAttribute("aria-label", "멀티뷰 패널 닫기");
        close.append(CheeseSpanner.multiviewView.panelIcon("close"));
        const reset = button("기본 배치", () => {
            current.windows.clear();
            refreshLayout(current);
        });
        tools.append(current.addToggle, close);
        heading.append(title, tools);
        const section = (name) => {
            const node = element("section", "bcvm-section");
            node.setAttribute("aria-label", name);
            node.append(element("h3", "bcvm-section-title", name));
            return node;
        };
        const searchSection = (current.addSection = section("영상 추가"));
        searchSection.id = `${PANEL_ID}-add`;
        searchSection.hidden = true;
        current.addTab = "search";
        const addTabs = (current.addTabs = element("div", "bcvm-add-tabs"));
        addTabs.setAttribute("role", "tablist");
        addTabs.setAttribute("aria-label", "영상 추가 방법");
        const searchPane = element("div", "bcvm-add-pane");
        const followingPane = (current.followingPane = element("div", "bcvm-add-pane"));
        for (const [name, label, pane] of [
            ["search", "검색·주소", searchPane],
            ["following", "팔로잉", followingPane],
        ]) {
            const tab = button(label, () => setAddTab(current, name));
            tab.dataset.bcvmAddTab = name;
            tab.id = `${PANEL_ID}-add-${name}-tab`;
            pane.id = `${PANEL_ID}-add-${name}-pane`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", pane.id);
            tab.setAttribute("aria-selected", String(name === current.addTab));
            tab.tabIndex = name === current.addTab ? 0 : -1;
            pane.setAttribute("role", "tabpanel");
            pane.setAttribute("aria-labelledby", tab.id);
            pane.hidden = name !== current.addTab;
            addTabs.append(tab);
        }
        addTabs.addEventListener("keydown", (event) => {
            const tabs = [...addTabs.children];
            const index = tabs.indexOf(event.target);
            if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next =
                event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
            setAddTab(current, tabs[next].dataset.bcvmAddTab);
            tabs[next].focus({ preventScroll: true });
        });
        const layoutSection = section("화면 배치");
        const listSection = section("추가한 영상");
        const layoutRow = element("div", "bcvm-row bcvm-layout");
        current.freeToggle = button("자유 배치", () => {
            endGesture(current, false);
            current.free = !current.free;
            if (current.free) setRunning(current, true);
            current.notice.textContent = "";
            drawLayout(current);
        });
        current.equalize = button("보조 방송 정렬", () => {
            if (current.free || layoutSuspended(current)) return;
            endGesture(current, false);
            const { width, height } = dockBounds(current);
            const arranged = model.equalizeAuxiliaries(current.tree, current.mainId, width / height);
            if (!arranged) return;
            current.tree = arranged.tree;
            current.customLayout = true;
            drawLayout(current);
        });
        current.equalize.className = "bcvm-equalize";
        current.equalize.prepend(CheeseSpanner.multiviewView.panelIcon("align"));
        layoutRow.append(current.freeToggle, reset, current.equalize);
        layoutSection.append(layoutRow, element("p", "bcvm-help", "영상이나 채널명을 끌어 위치를 바꿀 수 있어요."));
        const form = element("form");
        const input = (current.input = element("input"));
        input.type = "search";
        input.required = true;
        input.maxLength = 2048;
        input.placeholder = "채널 이름 또는 다시보기 주소";
        input.setAttribute("aria-label", input.placeholder);
        const submit = (current.submit = button("검색"));
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
            if (!current.open || !current.addOpen || current.addTab !== "search") return;
            const value = input.value.trim();
            if (videoNoFromUrl(value) || /^(?:https?:\/\/|chzzk\.naver\.com\/)/i.test(value)) void add(current, value);
            else if (value && value.length <= 100) void search(current, value);
            else current.notice.textContent = "채널 이름이나 치지직 다시보기 주소를 확인해 주세요.";
        });
        current.notice = element("div", "bcvm-notice");
        current.notice.setAttribute("role", "status");
        current.results = element("ul", "bcvm-results");
        current.results.setAttribute("aria-label", "채널 검색 결과");
        const followingFilter = element("div", "bcvm-following-filter");
        const followingInput = (current.followingInput = element("input"));
        followingInput.type = "search";
        followingInput.maxLength = 100;
        followingInput.placeholder = "팔로잉 채널 찾기";
        followingInput.setAttribute("aria-label", followingInput.placeholder);
        followingInput.addEventListener("input", () => filterFollowing(current));
        current.followingRefresh = button("새로고침", () => void showFollowing(current));
        current.followingRefresh.setAttribute("aria-label", "팔로잉 목록 새로고침");
        followingFilter.append(followingInput, current.followingRefresh);
        current.followingStatus = element("p", "bcvm-help");
        current.followingStatus.setAttribute("role", "status");
        current.followingList = element("ul", "bcvm-results bcvm-following-list");
        current.followingList.setAttribute("aria-label", "팔로잉 채널");
        followingPane.append(followingFilter, current.followingStatus, current.followingList);
        current.list = element("ul", "bcvm-list");
        current.list.setAttribute("aria-label", "다시보기 배치 목록");
        current.mainEntry = createListEntry(current, current.mainId, true);
        const refreshSolo = () => syncSoloButtons(current);
        for (const name of ["volumechange", "playing", "pause", "canplay", "ended", "emptied"])
            host.addEventListener(name, refreshSolo, { capture: true, signal });
        CheeseSpanner.mainAudioOutput?.changes?.addEventListener(
            "change",
            () => {
                clearSolo(current);
                refreshSolo();
            },
            { signal }
        );
        document.addEventListener(
            "visibilitychange",
            () => {
                if (document.hidden) clearSolo(current);
                refreshSolo();
            },
            { signal }
        );
        current.list.append(current.mainEntry.row);
        searchPane.append(form, current.results);
        current.audioUndoButton = button("", (event) => restoreRemovedAudio(current, event));
        current.audioUndoButton.className = "bcvm-restore-audio";
        current.audioUndoButton.hidden = true;
        searchSection.append(addTabs, current.audioUndoButton, searchPane, followingPane);
        listSection.append(
            current.list,
            element(
                "p",
                "bcvm-empty",
                "‘추가’를 눌러 채널 이름을 검색하거나 다시보기 주소를 붙여 넣으세요. (예시 https://chzzk.naver.com/video/123456)"
            )
        );
        toolbar.append(heading, current.notice, searchSection, createTimeline(current), listSection, layoutSection);
        panel.addEventListener(STATUS, (event) => {
            if (view !== current || !Object.hasOwn(MESSAGES, event.detail?.status)) return;
            const entry = [...current.entries.values()].find(
                (item) => item.request && item.request === event.detail.request
            );
            if (entry) {
                if (typeof event.detail.syncEnabled === "boolean") entry.syncEnabled = event.detail.syncEnabled;
                entry.syncAvailable = event.detail.canToggle === true;
                updateStatus(entry, event.detail.status);
                restoreWhenReady(current, entry, event.detail.status);
                if (current.solo && !entry.syncAvailable) clearSolo(current);
                syncSoloButtons(current);
            }
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
            if (current.addOpen) setAddOpen(current, false);
            else setOpen(current, false);
        });
        document.addEventListener(
            "click",
            (event) => {
                if (!current.open) return;
                const close = event.target.closest?.(CHAT_CLOSE);
                const header = close?.closest("aside#vod-aside")?.querySelector(SIDEBAR_HEADER);
                if (header?.contains(close)) {
                    setOpen(current, false, current.launcher);
                }
            },
            { capture: true, signal }
        );
        toolbar.hidden = true;
        reference.before(launcher);
        document.body.append(toolbar);
        host.append(panel);
        view = current;
        syncChatButton(current);
        refreshLayout(current);
        bindLayout(current);
        const displayModeChanged = () => {
            endGesture(current, false);
            if (current.open && layoutSuspended(current)) setOpen(current, false);
            drawLayout(current);
        };
        document.addEventListener("fullscreenchange", displayModeChanged, { signal });
        let floating = host.matches(".pip_mode, .miniplayer");
        current.mode = new MutationObserver(() => {
            const next = host.matches(".pip_mode, .miniplayer");
            if (next === floating) return;
            floating = next;
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
            if (current.viewport || current.drag) displayModeChanged();
            positionToolbar(current);
        };
        if (typeof ResizeObserver === "function") {
            current.resize = new ResizeObserver(resized);
            current.resize.observe(host);
            current.toolbarResize = new ResizeObserver(() => positionToolbar(current));
        } else window.addEventListener("resize", resized, { signal });
    }

    function unmount() {
        if (!view) return;
        clearAll(view);
        view.timelineListeners?.abort();
        view.timelineResize?.disconnect();
        view.listeners.abort();
        view.resize?.disconnect();
        view.toolbarResize?.disconnect();
        view.mode?.disconnect();
        view.panel.remove();
        view.toolbar.remove();
        view.launcher.remove();
        view.chatButton?.remove();
        document.querySelectorAll(`#${CHAT_BUTTON_ID}`).forEach((node) => node.remove());
        view = null;
    }

    function reconcile() {
        const nextRoute = enabled && !hidden ? videoNoFromUrl(location.href) : "";
        if (route !== nextRoute) {
            remountState = null;
            unmount();
            observer?.disconnect();
            observer = null;
            route = nextRoute;
        }
        if (!route) return;
        const host = document.querySelector(HOST);
        const root = host?.querySelector(":scope > .pzp-pc");
        const reference = launcherReference(root);
        if (view?.host === host && view.panel.parentElement === host) {
            // The native root can disappear for a frame while the host and owned slots stay mounted.
            if (!root || !reference) return;
            view.root = root;
            if (view.reference !== reference || view.launcher.parentElement !== reference.parentElement) {
                view.reference = reference;
                reference.before(view.launcher);
            }
            syncChatButton(view);
            positionToolbar(view);
            syncTimeline(view);
            return;
        }
        if (view?.running) remountState = { open: view.open, numbers: [...view.entries.keys()] };
        unmount();
        if (root && reference) {
            mount(host, root, reference);
            if (remountState) {
                const state = remountState;
                remountState = null;
                setRunning(view, true);
                drawLayout(view);
                if (state.open) setOpen(view, true, null, { focus: false });
                void restoreReplays(view, state.numbers);
            }
        }
        if (!observer) {
            observer = createMutationObserverSync({
                shouldSchedule: (mutations) =>
                    !view ||
                    !view.panel.isConnected ||
                    !view.reference.isConnected ||
                    view.panel.parentElement !== view.host ||
                    view.root.parentElement !== view.host ||
                    view.launcher.parentElement !== view.reference.parentElement ||
                    mutations.some((mutation) => mutationMatchesSelector(mutation, CHAT_HEADER_TARGETS)) ||
                    (view.open &&
                        view.timeline.open &&
                        mutations.some(
                            (mutation) =>
                                view.root.contains(mutation.target) &&
                                mutationMatchesSelector(mutation, "video.webplayer-internal-video")
                        )) ||
                    (view.open &&
                        (!view.toolbar.isConnected ||
                            mutations.some(
                                (mutation) =>
                                    mutationMatchesSelector(mutation, SIDEBAR) ||
                                    (view.toolbarAnchors.some((anchor) => anchor.contains(mutation.target)) &&
                                        mutationMatchesSelector(mutation, SIDEBAR_HEADER))
                            ))),
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
            const anchor = player.querySelector(".pzp-pc__bottom-buttons > .pzp-pc__bottom-buttons-right");
            if (!anchor) continue;
            const node = element("time", "bcvm-clock");
            const value = element("span");
            node.append(element("span", "bcvm-clock-label", "방송시각"), value);
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
                    if (value.textContent !== text) {
                        value.textContent = text;
                        node.dateTime = text;
                        node.setAttribute("aria-label", `현재 방송 시각 ${text} (KST)`);
                    }
                }
            };
            for (const name of ["timeupdate", "loadedmetadata", "emptied"])
                video.addEventListener(name, update, { signal: listeners.signal });
            anchor.before(node);
            clocks.set(video, { no: media.videoNo, node, listeners });
            update();
        }
    }

    document.addEventListener(AUXILIARY, syncClocks);

    bindFeatureOptions((options) => {
        if (view && compressorOption !== options.audioCompressorEnabled) clearSolo(view);
        compressorOption = options.audioCompressorEnabled;
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
