/**
 * 라이브 멀티뷰. isolated world; model.js와 패키지 Hls 다음에 로드한다.
 * 네이티브 플레이어는 원래 부모에 두고 크기만 조절한다. 채팅·하단 정보는 치지직 라우터가 소유한다.
 * 2026-09-05 /live/64a90ba95d1f9feb0a798a20bbf0f40c에서 .chzzk_player.type_live와
 * 그 부모의 고정된 영상 영역, .pzp-pc--adbreak, HLS/LLHLS live-detail 응답을 확인했다.
 */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.liveMultiview) return;
    const model = root.multiviewModel;
    const {
        bindFeatureOptions,
        startPageChangeDetection,
        injectStyleOnce,
        fetchJson,
        storageGet,
        storageSet,
        normalizeChzzkMediaUrl,
        mutationMatchesSelector,
    } = root.utils;
    const ID = "betterchzzk-multiview";
    const PANEL_ID = `${ID}-panel`;
    const CHAT = "aside#aside-chatting";
    const CHAT_BUTTON_ID = `${ID}-chat-settings`;
    const CHAT_ACTIONS = "[data-bcmv-chat-actions]";
    const MODERATOR_ACTIONS = "[data-bcct-moderator-actions]";
    const STYLE_ID = `${ID}-style`;
    const NATIVE = ".chzzk_player.type_live";
    const MEDIA_EVENTS = [
        "loadedmetadata",
        "durationchange",
        "progress",
        "canplay",
        "seeked",
        "timeupdate",
        "emptied",
        "error",
        "ended",
        "play",
        "pause",
        "resize",
    ];
    const STATES = {
        waiting: "복원 대기",
        range: "복원 대기 · 재생 범위 부족",
        seeking: "딜레이 적용 중",
        applied: "적용 완료",
        unsupported: "적용 불가",
        changed: "재생 위치 변경 · 다시 적용 가능",
    };
    const state = model.readSession(window.sessionStorage);
    let featureOptions = null;
    let applyingSlotAudio = false;
    let enabled = false,
        host = null,
        native = null,
        overlay = null,
        panel = null,
        panelAnchor = null,
        panelObserver = null,
        launcher = null;
    let chatButton = null,
        chatActions = null,
        chatHeader = null;
    let incomingDrag = null,
        addDropHint = null;
    let panelDrag = null,
        panelScrollFrame = 0,
        panelNavigation = null,
        panelFocusId = null,
        suppressPanelClick = false;
    let observer = null,
        modeObserver = null,
        sizeObserver = null,
        stopRoute = null,
        frame = 0,
        generation = 0,
        dragId = null,
        dragState = null,
        pointerDrag = null,
        suppressDragClick = false,
        resize = null;
    let routeId = model.channelFromUrl(location.href),
        panelId = null,
        oldMedia = null;
    let message = "",
        saveQueue = Promise.resolve();
    const players = new Map();
    const css = `
[data-bcmv-host],#${PANEL_ID}{isolation:isolate;--bcmv-font:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",sans-serif;--bcmv-fallback-surface:#fff;--bcmv-fallback-content:#202124;--bcmv-fallback-border:#d2d4d6;--bcmv-surface:var(--sem-color-surface-neutral-weaker,var(--Surface-neutral,var(--bcmv-fallback-surface)));--bcmv-content:var(--sem-color-content-neutral-primary,var(--Content-emphasized,var(--bcmv-fallback-content)));--bcmv-border:var(--sem-color-border-neutral-base,var(--Border-neutral,var(--bcmv-fallback-border)))}
html.theme_dark :is([data-bcmv-host],#${PANEL_ID}){--bcmv-fallback-surface:#23252b;--bcmv-fallback-content:#eee;--bcmv-fallback-border:#5e6069}
[data-bcmv-host="active"] > [data-bcmv-native]{position:absolute!important;left:var(--bcmv-main-left,0)!important;top:var(--bcmv-main-top,0)!important;width:var(--bcmv-main-width)!important;height:calc(100% * var(--bcmv-main-height))!important;min-width:0!important;min-height:0!important}
[data-bcmv-host="active"] [data-bcmv-native] :is(.pzp-pc__video,.webplayer-internal-video){touch-action:none;-webkit-user-drag:none}
[data-bcmv-host="active"] > [data-bcmv-native] .pzp-pc__mute-indicator{display:none!important}
#${ID}{position:absolute;inset:0;z-index:20;pointer-events:none;color:var(--bcmv-content);font:12px/1.4 var(--bcmv-font)}
:is(#${ID},#${PANEL_ID}) *{box-sizing:border-box}
:is(#${ID},#${PANEL_ID}) :is(button,input,a){font:inherit;color:inherit}
:is(#${ID},#${PANEL_ID}) :is(button,a){border:1px solid var(--bcmv-border);border-radius:4px;background:var(--bcmv-surface);padding:3px 6px;cursor:pointer;text-decoration:none;white-space:nowrap}
:is(#${ID},#${PANEL_ID}) :focus-visible{outline:2px solid #00c894;outline-offset:-2px}
:is(#${ID},#${PANEL_ID}) button:disabled{opacity:.55;cursor:default}
.bcmv-grid{position:absolute;inset:0;pointer-events:none}
.bcmv-position-guide{position:absolute;pointer-events:none;border:2px dashed #00c894;background:rgba(0,200,148,.06);z-index:4;color:#fff;text-shadow:0 1px 3px #000;padding:6px}
[data-bcmv-positioning] video{cursor:grabbing}
.bcmv-cell{position:absolute;pointer-events:auto;min-width:0;min-height:0;overflow:hidden;background:#000;border:0;outline:1px solid var(--bcmv-border);outline-offset:-1px;container-type:inline-size}
.bcmv-corner{position:absolute;width:16px;height:16px;z-index:4;opacity:0;pointer-events:none;touch-action:none}
.bcmv-corner::after{content:"";position:absolute;inset:3px;border:2px solid #fff;filter:drop-shadow(0 0 1px #000)}
.bcmv-corner[data-corner="nw"]{top:0;left:0;cursor:nwse-resize}.bcmv-corner[data-corner="nw"]::after{border-right:0;border-bottom:0}
.bcmv-corner[data-corner="ne"]{top:0;right:0;cursor:nesw-resize}.bcmv-corner[data-corner="ne"]::after{border-left:0;border-bottom:0}
.bcmv-corner[data-corner="sw"]{bottom:0;left:0;cursor:nesw-resize}.bcmv-corner[data-corner="sw"]::after{border-right:0;border-top:0}
.bcmv-corner[data-corner="se"]{bottom:0;right:0;cursor:nwse-resize}.bcmv-corner[data-corner="se"]::after{border-left:0;border-top:0}
.bcmv-cell:hover .bcmv-corner,.bcmv-cell:focus-within .bcmv-corner,[data-bcmv-host]:has([data-bcmv-native] .pzp-pc--controls) .bcmv-cell[data-main="1"] .bcmv-corner{opacity:1;pointer-events:auto}
#${ID}[data-dragging] .bcmv-separator,#${ID}[data-dragging] .bcmv-corner{pointer-events:none;opacity:0}
.bcmv-cell[data-main="1"]{pointer-events:none;background:transparent;border:0;outline:0}
#${ID}[data-dragging] .bcmv-cell[data-main="1"]{pointer-events:auto}
#${ID}[data-dragging] .bcmv-cell{cursor:grabbing}
.bcmv-cell video[data-bcmv-video]{cursor:grab}
.bcmv-cell video[data-bcmv-video],.bcmv-name{touch-action:none;user-select:none;-webkit-user-drag:none}
#${ID}[data-dragging] .bcmv-cell{transition:left .14s ease,top .14s ease,width .14s ease,height .14s ease}
#${ID}[data-dragging] .bcmv-cell[data-drag-source]{opacity:.22}
.bcmv-drop-preview{position:absolute;z-index:4;pointer-events:none;border:2px solid #00ffa3;background:rgba(0,255,163,.15);display:flex;align-items:center;justify-content:center;color:#fff;text-shadow:0 1px 3px #000;font-weight:600;box-sizing:border-box}
.bcmv-drop-preview span{padding:5px 10px;background:rgba(0,0,0,.7);border-radius:12px}
.bcmv-drop-preview[hidden]{display:none}
.bcmv-add-drop{position:absolute;inset:0;z-index:7;pointer-events:none;display:flex;align-items:center;justify-content:center;border:2px solid #00c894;background:rgba(0,200,148,.12);color:#fff;font-size:14px;font-weight:600}
.bcmv-add-drop span{max-width:90%;padding:8px 14px;border-radius:16px;background:rgba(0,0,0,.8);text-align:center}
.bcmv-add-drop[data-invalid="1"]{border-color:#a6acb8;background:rgba(0,0,0,.18)}
.bcmv-snap-guide{position:absolute;z-index:4;pointer-events:none;background:#00ffa3}
.bcmv-snap-guide[data-axis="columns"]{top:0;bottom:0;width:2px;transform:translateX(-1px)}
.bcmv-snap-guide[data-axis="rows"]{left:0;right:0;height:2px;transform:translateY(-1px)}
@media(prefers-reduced-motion:reduce){#${ID}[data-dragging] .bcmv-cell{transition:none}}
.bcmv-head{position:absolute;inset:0 0 auto;display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:6px;background:linear-gradient(#000b,transparent);color:#fff;pointer-events:none;opacity:0;z-index:2;transition:opacity .2s}
.bcmv-cell:hover .bcmv-head,.bcmv-cell:focus-within .bcmv-head,.bcmv-cell:hover .bcmv-controls,.bcmv-cell:focus-within .bcmv-controls{opacity:1;pointer-events:auto}
/* Native player measurements, 2026-09-06: 36px controls, 2px track, 10px thumb. */
.bcmv-controls{position:absolute;inset:auto 0 0;display:flex;align-items:center;gap:0;padding:0 8px 8px;color:#fff;opacity:0;pointer-events:none;z-index:2;transition:opacity .2s;font-family:inherit}
.bcmv-controls::before{content:"";position:absolute;inset:auto 0 0;height:100px;background:linear-gradient(transparent,rgba(0,0,0,.6));pointer-events:none;z-index:-1}
#${ID} .bcmv-controls button{position:relative;display:flex;align-items:center;justify-content:center;flex:none;width:36px;height:36px;margin:0;padding:0;border:0;background:transparent;color:#fff;border-radius:50%;font-family:inherit}
#${ID} .bcmv-controls :is([data-action="toggle-play"],[data-action="reset-delay"]){margin-right:5px}
#${ID} .bcmv-controls [data-action="mute"]{margin-right:10px}
.bcmv-controls svg{width:36px;height:36px;pointer-events:none}
/* The existing main fast-forward uses a 24px glyph inside its 36px button. */
#${ID} .bcmv-controls [data-action="reset-delay"] svg{width:24px;height:24px}
#${ID} .bcmv-controls button::after{content:attr(aria-label);position:absolute;bottom:calc(100% + 8px);left:0;padding:6px 12px;border-radius:14px;background:rgba(0,0,0,.6);color:#fff;font-size:13px;font-weight:400;white-space:nowrap;pointer-events:none;opacity:0}
#${ID} .bcmv-controls button:hover::after,#${ID} .bcmv-controls button:focus-visible::after{opacity:1}
#${ID} .bcmv-controls [data-action="delay"]::after{left:auto;right:0}
.bcmv-controls input[type="range"]{appearance:none;-webkit-appearance:none;width:64px;min-width:12px;flex:0 1 64px;height:18px;padding:0;border:0;background:transparent;margin:0 10px 0 0;cursor:pointer}
.bcmv-controls input[type="range"]::-webkit-slider-runnable-track{height:2px;border:0;background:linear-gradient(to right,#fff var(--bcmv-volume,30%),rgba(255,255,255,.5) var(--bcmv-volume,30%))}
.bcmv-controls input[type="range"]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:10px;height:10px;border:0;border-radius:50%;background:#fff;margin-top:-4px;box-shadow:none}
#${ID} .bcmv-controls [data-action="delay"]{width:44px;font-size:13px;font-weight:500;padding:0;text-shadow:0 1px 2px #0006}
#${ID} .bcmv-controls [data-delta="-0.1"]{margin-left:auto}
@container(max-width:260px){#${ID} .bcmv-controls{padding:0 6px 4px}#${ID} .bcmv-controls button{width:28px;height:28px}#${ID} .bcmv-controls svg{width:28px;height:28px}#${ID} .bcmv-controls [data-action="reset-delay"] svg{width:20px;height:20px}#${ID} .bcmv-controls :is([data-action="toggle-play"],[data-action="reset-delay"]){margin-right:1px}#${ID} .bcmv-controls [data-action="mute"]{margin-right:4px}#${ID} .bcmv-controls [data-action="delay"]{width:36px;font-size:11px}.bcmv-controls input[type="range"]{width:44px;flex-basis:44px;margin-right:4px}}
@container(max-width:190px){.bcmv-controls input[type="range"]{display:none}}
@container(max-width:170px){.bcmv-controls{flex-wrap:wrap;justify-content:center}#${ID} .bcmv-controls [data-delta="-0.1"]{margin-left:0}}
#${ID} .bcmv-head .bcmv-name{background:transparent;border:0;color:#fff;text-align:left;padding:0;overflow:hidden;text-overflow:ellipsis}
#${ID} .bcmv-head [data-action="remove"]{flex:none;width:28px;height:28px;padding:0!important;border:0;border-radius:50%;background:transparent;color:#fff;font-size:24px;line-height:28px;text-shadow:0 1px 2px #000}
#${ID} .bcmv-head [data-action="remove"]:hover{background:rgba(255,255,255,.15)}
.bcmv-head .bcmv-name{flex-basis:80px;text-shadow:0 1px 3px #000}
.bcmv-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:grab}
.bcmv-head button{padding:1px 3px!important}
.bcmv-cell video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.bcmv-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.bcmv-error{position:absolute;inset:0;display:flex;overflow:auto;overscroll-behavior:contain;margin:0;padding:16px;color:var(--sem-color-content-neutral-primary-static,#fff);background:var(--sem-color-surface-neutral-black-static,#000);text-align:center}
#${ID} .bcmv-error[hidden],#${ID} .bcmv-error [hidden]{display:none}
.bcmv-error-content{flex:none;display:flex;flex-direction:column;align-items:center;gap:12px;width:100%;max-width:320px;margin:auto}
.bcmv-error p{width:100%;margin:0;font-size:13px;font-weight:500;line-height:1.55;word-break:keep-all;overflow-wrap:anywhere;text-wrap:pretty}
.bcmv-error-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;max-width:100%}
#${ID} .bcmv-error button{display:inline-flex;align-items:center;justify-content:center;min-height:32px;max-width:100%;margin:0;padding:6px 16px;border:0;border-radius:18px;background:var(--sem-color-surface-neutral-base-static,#2e3033);color:inherit;font-size:12px;font-weight:600;line-height:20px;white-space:normal;overflow-wrap:anywhere;transition:background-color .15s}
#${ID} .bcmv-error button:hover{background:var(--sem-color-surface-neutral-strong-static,#4d4d4d)}
#${ID} .bcmv-error button:active{background:var(--sem-color-surface-neutral-weaker-static,#1c1d1f)}
@container(max-width:260px){.bcmv-error{padding:12px}.bcmv-error-content{gap:8px}.bcmv-error p{font-size:12px}#${ID} .bcmv-error button{min-height:28px;padding:4px 12px}}
.bcmv-separator{position:absolute;pointer-events:auto;touch-action:none;background:transparent;z-index:3}
.bcmv-separator:hover,.bcmv-separator:focus-visible{background:#00c894}
.bcmv-separator[data-axis="columns"]{width:6px;transform:translateX(-3px);cursor:col-resize}
.bcmv-separator[data-axis="rows"]{height:6px;transform:translateY(-3px);cursor:row-resize}
.bcmv-panel{position:fixed;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--bcmv-border) transparent;padding:10px;background:var(--bcmv-surface);color:var(--bcmv-content);border:1px solid var(--bcmv-border);border-radius:10px;box-shadow:0 4px 16px #0003;pointer-events:auto;z-index:100;font:12px/1.4 var(--bcmv-font)}
.bcmv-panel[hidden]{display:none}
.bcmv-panel{--bcmv-accent:#087f5b;--bcmv-danger:#c43748;--bcmv-tool-fallback:#f1f3f5;--bcmv-tool-surface:var(--sem-color-surface-neutral-weak,var(--bcmv-tool-fallback));--bcmv-brand-fill:var(--sem-color-surface-brand-strongest-static,#00ffa3)}
html.theme_dark .bcmv-panel{--bcmv-accent:var(--sem-color-content-brand-strong,#00ffa3);--bcmv-danger:#ff7b88;--bcmv-tool-fallback:#2b2d33}
#${PANEL_ID} button{margin:0}
.bcmv-panel-header{display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:6px}
.bcmv-panel-tools{display:flex;gap:2px}
.bcmv-panel h3{margin:0;font-size:13px;font-weight:600}
#${PANEL_ID} .bcmv-panel-header button{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;padding:0;width:24px;height:24px;border-radius:4px}
.bcmv-panel-icon{display:block;flex:none;width:16px;height:16px;pointer-events:none}
#${PANEL_ID} button:not(:disabled):hover{background:rgba(127,127,127,.12)}
#${PANEL_ID} .bcmv-panel-header [data-action="add"],#${PANEL_ID} [data-action="submit-add"]{border:0;background:var(--bcmv-brand-fill);color:var(--sem-color-content-neutral-inverse-static,#0e0f10);font-weight:600}
#${PANEL_ID} .bcmv-panel-header [data-action="add"]:hover,#${PANEL_ID} [data-action="submit-add"]:hover{background:var(--sem-color-surface-brand-stronger-static,#00e693)}
.bcmv-panel label{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:8px 0;font-size:11px}
.bcmv-panel input[type="url"]{width:100%;min-width:0;height:30px;background:var(--bcmv-surface);border:1px solid var(--bcmv-border);border-radius:6px;padding:6px 8px;font-size:12px}
#${PANEL_ID} [data-action="submit-add"]{min-height:26px;padding:3px 12px;border-radius:4px}
.bcmv-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:2px;margin:0 0 8px;padding:2px;background:var(--bcmv-tool-surface);border-radius:4px}
#${PANEL_ID} .bcmv-actions button{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;min-height:26px;padding:4px 2px;border:0;border-radius:2px;background:transparent;font-size:11px;font-weight:500;white-space:normal;word-break:keep-all}
.bcmv-actions .bcmv-panel-icon{width:14px;height:14px;color:var(--bcmv-accent)}
#${PANEL_ID} .bcmv-actions button:disabled .bcmv-panel-icon{color:inherit}
.bcmv-streams{list-style:none;margin:0;padding:0;border-top:1px solid var(--bcmv-border)}
.bcmv-stream{display:grid;grid-template-columns:minmax(0,1fr) 24px;align-items:center;gap:3px 4px;padding:7px 0;border-bottom:1px solid var(--bcmv-border)}
.bcmv-stream{position:relative}
.bcmv-stream[data-main="1"]{padding:5px 0}
#${PANEL_ID} .bcmv-stream-move{grid-column:1;grid-row:1;display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;min-height:24px;border:0;padding:2px 0;background:transparent;text-align:left;cursor:grab;touch-action:none;user-select:none;-webkit-user-drag:none}
.bcmv-stream-role{flex:none;font-size:11px;font-weight:400;opacity:.7}
.bcmv-stream[data-main="1"] .bcmv-stream-role{color:#00a879;opacity:1}
.bcmv-stream-grip{flex:none;width:8px;height:12px;background:radial-gradient(circle,currentColor .8px,transparent 1px) 0 0/4px 4px;opacity:.4}
.bcmv-stream[data-moving]{opacity:.45}
.bcmv-stream[data-drop="swap"]{outline:2px solid #00c894;outline-offset:-2px;border-radius:4px;background:rgba(0,200,148,.1)}
.bcmv-stream[data-drop="before"]::before,.bcmv-stream[data-drop="after"]::after{content:"";position:absolute;left:0;right:0;height:2px;background:#00c894;pointer-events:none}
.bcmv-stream[data-drop="before"]::before{top:0}.bcmv-stream[data-drop="after"]::after{bottom:0}
#${PANEL_ID}[data-list-dragging] .bcmv-stream-move{cursor:grabbing}
.bcmv-move-status{position:absolute;inset:0;width:1px;height:1px;margin:0;padding:0;border:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.bcmv-stream:last-child{border-bottom:0;padding-bottom:0}
.bcmv-stream-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}
.bcmv-stream-timing{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:2px 6px;min-width:0;font-size:11px;font-variant-numeric:tabular-nums}
.bcmv-stream [data-bcmv-delay]{opacity:.7}
.bcmv-stream-detail{grid-column:1/-1;display:flex;align-items:center;gap:6px;min-width:0}
.bcmv-stream-sync{display:flex;flex:none;gap:3px}
#${PANEL_ID} .bcmv-stream-sync button{min-width:40px;min-height:24px;padding:2px 5px;border:0;border-radius:3px;color:var(--bcmv-accent);background:rgba(0,200,148,.09);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums}
#${PANEL_ID} .bcmv-stream-sync button:not(:disabled):hover{background:rgba(0,200,148,.2)}
.bcmv-stream [data-bcmv-status]{flex:1;min-width:0;margin:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7}
#${PANEL_ID} .bcmv-stream [data-action="remove"]{grid-column:2;grid-row:1;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--bcmv-danger);opacity:.8}
#${PANEL_ID} .bcmv-stream [data-action="remove"]:hover{background:rgba(232,70,90,.12);opacity:1}
.bcmv-notice{margin:5px 0;white-space:normal;overflow-wrap:anywhere}
.bcmv-panel [data-bcmv-notice]:empty{display:none}
.bcmv-banner{position:absolute;top:0;left:0;right:0;z-index:6;background:var(--bcmv-surface);padding:8px;pointer-events:auto}
.bcmv-banner:empty{display:none}
/* Keep the launcher in the native button flow with its own predictable box. */
#betterchzzk-multiview-launcher{position:relative;inset:auto;transform:none;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:36px;height:36px;margin:0;padding:6px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
#betterchzzk-multiview-launcher svg{width:24px;height:24px;pointer-events:none}
#betterchzzk-multiview-launcher[aria-pressed="true"]{color:#00c894;background:rgba(0,200,148,.14)}
#betterchzzk-multiview-launcher:focus-visible{outline:2px solid #00c894;outline-offset:-2px}
/* Native pzp buttons fade individually with --controls (2026-09-06 player CSS). */
.pzp-pc #betterchzzk-multiview-launcher{opacity:0;pointer-events:none;transition:opacity .2s}
.pzp-pc.pzp-pc--controls #betterchzzk-multiview-launcher{opacity:1;pointer-events:auto}
${CHAT_ACTIONS}{display:inline-flex!important;align-items:center!important;vertical-align:top;gap:0!important;line-height:0;white-space:nowrap;margin-left:auto}
${CHAT_ACTIONS} > ${MODERATOR_ACTIONS}{height:auto!important;margin-left:0!important;transform:none!important}
#${CHAT_BUTTON_ID}{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;margin:0 2px 0 0;padding:0;border:0;border-radius:8px;background:transparent;--bcmv-chat-fallback:#69737f;color:var(--sem-color-content-neutral-cool-base,var(--bcmv-chat-fallback));cursor:pointer}
html.theme_dark #${CHAT_BUTTON_ID}{--bcmv-chat-fallback:#9da5b6}
#${CHAT_BUTTON_ID}:hover,#${CHAT_BUTTON_ID}[aria-expanded="true"]{color:var(--sem-color-content-brand-base,#00c894);background:rgba(0,200,148,.1)}
#${CHAT_BUTTON_ID}:focus-visible{outline:2px solid #00c894;outline-offset:-2px}
#${CHAT_BUTTON_ID} svg{width:19px;height:19px;pointer-events:none}
`;

    function text(node, value) {
        if (node && node.textContent !== value) node.textContent = value;
    }
    function el(tag, className, value) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value) node.textContent = value;
        return node;
    }
    function button(label, action, id) {
        const node = el("button", "", label);
        node.type = "button";
        node.dataset.action = action;
        if (id) node.dataset.channel = id;
        return node;
    }
    function delayButton(delta, id) {
        const control = button(`${delta < 0 ? "−" : "+"}${Math.abs(delta)}s`, "delay", id);
        control.dataset.delta = String(delta);
        control.setAttribute("aria-label", `싱크 ${delta < 0 ? "앞으로" : "늦추기"} ${Math.abs(delta)}s`);
        return control;
    }
    function panelIcon(kind) {
        const paths = {
            add: "M8 3v10M3 8h10",
            close: "m4 4 8 8M12 4l-8 8",
            layout: "M2 2.5h7v11H2zM11.5 2.5H14v4h-2.5zM11.5 9.5H14v4h-2.5z",
            align: "M2 2.5h12v3H2zM2 10.5h12v3H2zM5 8h6",
            remove: "M3 4.5h10M6 2.5h4M4 4.5l.5 9h7l.5-9M6.5 7v4M9.5 7v4",
        };
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
            path = document.createElementNS(svg.namespaceURI, "path");
        svg.classList.add("bcmv-panel-icon");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.5");
        svg.setAttribute("stroke-linecap", "round");
        svg.setAttribute("stroke-linejoin", "round");
        path.setAttribute("d", paths[kind]);
        svg.append(path);
        return svg;
    }
    function multiviewIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("fill", "none");
        svg.setAttribute("stroke", "currentColor");
        svg.setAttribute("stroke-width", "1.6");
        for (const [x, y, width, height] of [
            [3, 3, 11, 11],
            [17, 3, 4, 4],
            [17, 10, 4, 4],
            [3, 17, 4, 4],
            [10, 17, 4, 4],
            [17, 17, 4, 4],
        ]) {
            const rect = document.createElementNS(svg.namespaceURI, "rect");
            for (const [name, value] of Object.entries({ x, y, width, height, rx: 0.6 }))
                rect.setAttribute(name, String(value));
            svg.append(rect);
        }
        return svg;
    }
    function setControlIcon(node, kind, label) {
        if (!node) return;
        node.setAttribute("aria-label", label);
        if (node.dataset.icon === kind) return;
        node.dataset.icon = kind;
        // Playback/volume glyphs measured on CHZZK, 2026-09-06; fast-forward matches skipControl.js.
        // No page scripts or animation IDs are copied.
        const speaker =
            "M13.0632 13.9352H9.7C9.3134 13.9352 9 14.2486 9 14.6352V21.1928C9 21.5794 9.3134 21.8928 9.7 21.8928H13.0633L18.5407 25.3447C19.0069 25.6385 19.614 25.3035 19.614 24.7525V11.0755C19.614 10.5245 19.0069 10.1895 18.5407 10.4832L13.0632 13.9352Z";
        const paths = {
            fastForward: "M9 27V9l12.75 9L9 27Zm15-18h3v18h-3V9Z",
            play: "M13.5 11.04C13.5 10.21 14.49 9.71 15.22 10.18L26.02 17.14C26.2 17.26 26.34 17.42 26.41 17.59C26.52 17.84 26.53 18.11 26.44 18.35C26.36 18.55 26.22 18.73 26.02 18.86L15.22 25.82C14.49 26.29 13.5 25.79 13.5 24.96Z",
            pause: "M13.11 10.01h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1ZM22.01 10.01h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-14a1 1 0 0 1 1-1Z",
            quiet:
                speaker +
                "M23.0862 13.9364C24.1983 14.9695 24.8596 16.4612 24.8596 18.0107C24.8596 19.5611 24.1978 21.0454 23.0858 22.0782C22.868 22.2861 22.5558 22.3645 22.2666 22.2997C21.9751 22.2345 21.7233 22.0262 21.6315 21.7295C21.5384 21.4288 21.6341 21.1134 21.8599 20.9055C22.6219 20.1982 23.1176 19.113 23.1176 18.0107C23.1176 16.9081 22.6216 15.816 21.8603 15.1091C21.6153 14.8848 21.5249 14.5369 21.6523 14.2211C21.7774 13.9112 22.0762 13.718 22.3964 13.6937C22.6475 13.6747 22.9018 13.7594 23.0862 13.9364Z",
            sound:
                speaker +
                "M25.7049 11.4235C27.2959 13.0511 28.4737 15.4943 28.4737 18.0108C28.4737 20.5278 27.2955 22.9637 25.7045 24.5911C25.512 24.7936 25.2257 24.8776 24.9542 24.8107C24.6816 24.7434 24.4666 24.5347 24.3907 24.2646C24.3149 23.9949 24.3895 23.7051 24.5862 23.5055C25.9114 22.1505 26.9162 20.0429 26.9162 18.0108C26.9162 15.9786 25.9113 13.8639 24.5866 12.5091C24.3735 12.2942 24.3039 11.9753 24.408 11.6912C24.5122 11.4064 24.7721 11.2077 25.0745 11.1824C25.3105 11.1628 25.5424 11.2516 25.7049 11.4235ZM23.0552 13.9692C24.1584 14.9938 24.8145 16.4737 24.8145 18.0108C24.8145 19.5486 24.1579 21.0211 23.0548 22.0455C22.8485 22.2426 22.5517 22.3175 22.2763 22.2558C21.9989 22.1938 21.761 21.996 21.6744 21.7162C21.5867 21.4329 21.6766 21.1353 21.8904 20.9386C22.6614 20.2229 23.1625 19.1258 23.1625 18.0108C23.1625 16.8954 22.6612 15.7913 21.8907 15.0761C21.6588 14.8638 21.5739 14.5355 21.694 14.238C21.8119 13.9456 22.0948 13.7617 22.3997 13.7386C22.6389 13.7205 22.8805 13.8013 23.0552 13.9692Z",
            muted:
                speaker +
                "M22.929 15.9741C22.612 15.6585 22.6107 15.1456 22.9263 14.8286C23.2419 14.5115 23.7548 14.5103 24.0718 14.8259L26.3136 17.0571L28.5554 14.8259C28.8725 14.5103 29.3853 14.5115 29.7009 14.8286C30.0165 15.1456 30.0153 15.6585 29.6982 15.9741L27.4618 18.2L29.6982 20.4259C30.0153 20.7414 30.0165 21.2543 29.7009 21.5714C29.3853 21.8884 28.8725 21.8896 28.5554 21.5741L26.3136 19.3428L24.0718 21.5741C23.7548 21.8896 23.2419 21.8884 22.9263 21.5714C22.6108 21.2543 22.612 20.7414 22.929 20.4259L25.1654 18.2L22.929 15.9741Z",
        };
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"),
            path = document.createElementNS(svg.namespaceURI, "path");
        svg.setAttribute("viewBox", "0 0 36 36");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("fill", "currentColor");
        path.setAttribute("d", paths[kind]);
        path.setAttribute("stroke-linejoin", "round");
        path.setAttribute("fill-rule", "evenodd");
        path.setAttribute("stroke", "#000");
        path.setAttribute("stroke-opacity", "0.1");
        path.setAttribute("stroke-width", "2");
        path.style.paintOrder = "stroke";
        svg.append(path);
        node.replaceChildren(svg);
    }
    function current(player) {
        return enabled && state.active && players.get(player.id) === player && !player.abort.signal.aborted;
    }
    function notice(value) {
        message = value;
        text(panel?.querySelector("[data-bcmv-notice]"), value);
        text(overlay?.querySelector(".bcmv-banner"), panelId ? "" : value);
    }
    function persistSession() {
        try {
            sessionStorage.setItem(model.SESSION_KEY, JSON.stringify(state));
        } catch {
            notice("탭 구성을 저장하지 못했어요. 새로고침 후 구성이 복원되지 않을 수 있어요.");
        }
    }
    function captureAudio(player) {
        if (applyingSlotAudio) return;
        const entry = state.channels.find((item) => item.id === player.id);
        if (!entry || !player.video) return;
        if (entry.volume === player.video.volume && entry.muted === player.video.muted) {
            updatePlayerUi(player);
            return;
        }
        entry.volume = player.video.volume;
        entry.muted = player.video.muted;
        persistSession();
        updatePlayerUi(player);
    }
    function transferSlotAudio(assignments) {
        // Entries cache the sound of the occupied slot; take every source before changing any occupant.
        const sounds = new Map(
            state.channels.map((entry) => {
                const player = players.get(entry.id);
                const video = player && current(player) && player.video;
                return [
                    entry.id,
                    { volume: video ? video.volume : entry.volume, muted: video ? video.muted : entry.muted },
                ];
            })
        );
        const changed = [];
        for (const [id, previousId] of assignments) {
            const entry = state.channels.find((item) => item.id === id);
            if (!entry) continue;
            const sound = sounds.get(previousId) || { volume: 0.3, muted: true };
            entry.volume = sound.volume;
            entry.muted = sound.muted;
            changed.push(entry);
        }
        // Volume setters can synchronously emit volumechange; never capture an intermediate assignment.
        applyingSlotAudio = true;
        try {
            // Silence outgoing occupants before enabling the sound of incoming ones.
            for (const entry of changed) {
                const player = players.get(entry.id);
                if (player && current(player) && player.video && entry.muted) player.video.muted = true;
            }
            for (const entry of changed) {
                const player = players.get(entry.id);
                if (!player || !current(player) || !player.video) continue;
                player.video.volume = entry.volume;
                player.video.muted = entry.muted;
                updatePlayerUi(player);
            }
        } finally {
            applyingSlotAudio = false;
        }
    }
    function moveSlotAudio(before, after, source, target, side) {
        if (side === "center") {
            const oldSlots = new Map(model.treeLayout(before).cells.map((cell) => [cell.path, cell.id]));
            transferSlotAudio(
                model
                    .treeLayout(after)
                    .cells.filter((cell) => cell.id)
                    .map((cell) => [cell.id, oldSlots.get(cell.path)])
            );
        } else {
            // Splitting a destination or moving a group exchanges the two selected places.
            transferSlotAudio([
                [source, target],
                [target, source],
            ]);
        }
    }
    function updatePlayerUi(player) {
        const cell = overlay?.querySelector(`[data-bcmv-channel="${player.id}"]`);
        text(cell?.querySelector(".bcmv-name"), player.name || player.id.slice(0, 8));
        const error = cell?.querySelector(".bcmv-error");
        if (error) {
            error.hidden = !player.error && !player.saveError;
            text(error.querySelector("p"), player.error || player.saveError || "");
            error.querySelector('[data-action="retry"]').hidden = !player.error;
            error.querySelector('[data-action="apply-delay"]').hidden = !player.saveError || !player.loaded;
        }
        const mute = cell?.querySelector('[data-action="mute"]');
        const muted = player.video?.muted !== false || player.video?.volume === 0;
        const soundIcon = muted ? "muted" : player.video.volume > 0.5 ? "sound" : "quiet";
        setControlIcon(mute, soundIcon, muted ? "음소거 해제" : "음소거");
        mute?.setAttribute("aria-pressed", String(muted));
        const playback = cell?.querySelector('[data-action="toggle-play"]');
        setControlIcon(playback, player.video?.paused ? "play" : "pause", player.video?.paused ? "재생" : "일시 정지");
        const inlineVolume = cell?.querySelector('input[type="range"]');
        if (inlineVolume && document.activeElement !== inlineVolume)
            inlineVolume.value = muted ? 0 : Math.round((player.video?.volume ?? 0.3) * 100);
        inlineVolume?.style.setProperty(
            "--bcmv-volume",
            `${muted ? 0 : Math.round((player.video?.volume ?? 0.3) * 100)}%`
        );
        for (const control of cell?.querySelectorAll("[data-delta], [data-action='reset-delay']") || [])
            control.disabled = !player.loaded;
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
        row.querySelector(".bcmv-stream-sync").setAttribute("aria-label", `${name} 싱크 조절`);
        for (const control of row.querySelectorAll("[data-delta]")) control.disabled = !player.loaded;
        const delay = row.querySelector("[data-bcmv-delay]");
        const timing = !player.error && measureTiming(player);
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
    function isAd(player) {
        return player.main && Boolean(native?.querySelector(".pzp-pc--adbreak"));
    }
    function measureTiming(player) {
        const video = player.video;
        if (
            !video ||
            !video.readyState ||
            Number.isFinite(video.duration) ||
            video.error ||
            video.ended ||
            isAd(player)
        ) {
            player.liveClock = null;
            return null;
        }
        if (!player.main) return model.hlsTiming(video, player.hls?.latestLevelDetails);
        const observation = model.nativeTiming(video, player.liveClock, performance.now());
        player.liveClock = observation.clock;
        return observation.timing;
    }
    function applyDelay(player, eventType) {
        if (!current(player) || !player.loaded || !player.video) return;
        const video = player.video;
        if (eventType === "emptied") player.liveClock = null;
        const timing = measureTiming(player);
        if (video.error || video.ended) {
            player.pending = null;
            player.status = "unsupported";
            player.applied = true;
            updatePlayerUi(player);
            return;
        }
        if (isAd(player)) {
            player.status = "waiting";
            updatePlayerUi(player);
            return;
        }
        if (eventType === "emptied") {
            player.applied = false;
            player.pending = null;
        }
        if (player.pending) {
            if (eventType === "seeked" || (!video.seeking && eventType === "timeupdate")) {
                const elapsed = video.paused ? 0 : (performance.now() - player.pending.at) / 1000;
                const arrived = Math.abs(video.currentTime - player.pending.time - elapsed) < 0.75;
                player.status = arrived ? "applied" : "unsupported";
                player.applied = true;
                player.pending = null;
            }
            updatePlayerUi(player);
            return;
        }
        if (player.applied) {
            if (video.error || video.ended) player.status = "unsupported";
            updatePlayerUi(player);
            return;
        }
        if (player.delay > 0 && player.delayBasis !== "legacy" && !timing) {
            player.status = "waiting";
            updatePlayerUi(player);
            return;
        }
        const result = model.seekTarget(
            video,
            player.delay,
            player.hls?.liveSyncPosition,
            player.delay > 0 && player.delayBasis !== "legacy" ? timing?.edge : undefined
        );
        if (result.state !== "ready") {
            player.status = result.state;
            updatePlayerUi(player);
            return;
        }
        try {
            player.pending = { time: result.target, at: performance.now() };
            player.status = "seeking";
            video.currentTime = result.target;
        } catch {
            player.pending = null;
            player.applied = true;
            player.status = "unsupported";
        }
        updatePlayerUi(player);
    }
    function tuneHls(player) {
        if (!player.hls) return;
        // Hls.targetLatency is a public setter; keep automatic catch-up from undoing the chosen delay.
        if (player.delay > 0) player.hls.targetLatency = player.delay;
        else if (Number.isFinite(player.defaultLatency)) player.hls.targetLatency = player.defaultLatency;
    }
    function setDelay(player, value, basis = "live-edge-clock") {
        if (!player?.loaded || !model.validDelay(value)) return;
        player.delay = Math.round(value * 10) / 10;
        player.delayBasis = basis;
        player.applied = false;
        player.pending = null;
        player.saveError = "";
        player.saving = true;
        const delay = player.delay,
            revision = ++player.revision;
        tuneHls(player);
        applyDelay(player);
        saveQueue = saveQueue
            .catch(() => {})
            .then(async () => {
                if (!chrome.storage?.local) throw new Error("저장소를 사용할 수 없어요.");
                await storageSet(chrome.storage.local, {
                    [model.delayKey(player.id)]:
                        basis === "legacy"
                            ? { version: 1, delaySeconds: delay }
                            : { version: 2, basis: "live-edge-clock", delaySeconds: delay },
                });
            })
            .then(() => {
                if (player.revision !== revision) return;
                player.savedDelay = delay;
                player.savedBasis = basis;
                player.saving = false;
                if (current(player)) updatePlayerUi(player);
            })
            .catch(() => {
                if (player.revision !== revision) return;
                player.saving = false;
                player.saveError =
                    "딜레이 저장 실패 · 조절 값은 이번 재생에만 적용돼요. 다시 저장을 눌러 저장할 수 있어요.";
                if (current(player)) updatePlayerUi(player);
            });
    }
    function bindVideo(player, video) {
        if (player.video === video) return;
        player.unbind?.();
        player.video = video;
        player.liveClock = null;
        player.applied = false;
        player.pending = null;
        if (!video) return;
        const entry = state.channels.find((item) => item.id === player.id);
        video.volume = entry.volume;
        video.muted = entry.muted;
        const onMedia = (event) => {
            if (!current(player) || player.video !== video) return;
            applyDelay(player, event.type);
            if (event.type === "loadedmetadata" || event.type === "resize") positionCells();
        };
        const onVolume = () => {
            if (current(player)) captureAudio(player);
        };
        const onSeeking = () => {
            if (current(player) && player.applied && !player.pending) {
                player.status = "changed";
                updatePlayerUi(player);
            }
        };
        for (const type of MEDIA_EVENTS) video.addEventListener(type, onMedia);
        video.addEventListener("volumechange", onVolume);
        video.addEventListener("seeking", onSeeking);
        player.unbind = () => {
            for (const type of MEDIA_EVENTS) video.removeEventListener(type, onMedia);
            video.removeEventListener("volumechange", onVolume);
            video.removeEventListener("seeking", onSeeking);
        };
        applyDelay(player);
    }
    async function play(player) {
        try {
            await player.video?.play();
            if (current(player)) {
                player.error = "";
                updatePlayerUi(player);
            }
        } catch {
            if (current(player)) {
                player.error = "재생 버튼을 눌러 시작해 주세요.";
                updatePlayerUi(player);
            }
        }
    }
    async function loadPlayer(player) {
        const key = model.delayKey(player.id);
        try {
            if (!chrome.storage?.local) throw new Error("저장소 없음");
            const record = await storageGet(chrome.storage.local, key);
            if (!current(player)) return;
            player.delay = player.savedDelay = model.readDelay(record[key]);
            player.delayBasis = player.savedBasis = model.delayBasis(record[key]);
            player.loaded = true;
        } catch {
            if (!current(player)) return;
            player.saveError = "저장된 딜레이를 읽지 못했어요. 재생 재시도로 다시 불러올 수 있어요.";
        }
        if (!current(player)) return;
        updatePlayerUi(player);
        try {
            const response = await fetchJson(
                `https://api.chzzk.naver.com/service/v3/channels/${player.id}/live-detail`,
                { signal: player.abort.signal, timeoutMs: 10000 }
            );
            if (!current(player)) return;
            const content = response?.content;
            if (content?.channel?.channelId !== player.id) throw new Error("요청한 방송의 정보를 확인하지 못했어요.");
            player.name = content.channel.channelName;
            if (player.main) {
                player.metaReady = content.status === "OPEN";
                if (!player.metaReady) throw new Error("방송이 종료되었거나 시청할 수 없어요.");
                syncNative();
            } else {
                const source = model.source(content, normalizeChzzkMediaUrl);
                if (!window.Hls?.isSupported?.()) throw new Error("이 환경에서는 보조 방송 재생을 지원하지 않아요.");
                const hls = new window.Hls({
                    enableWorker: false,
                    lowLatencyMode: source.lowLatency,
                    capLevelToPlayerSize: true,
                    maxBufferLength: 30,
                    backBufferLength: 60,
                    liveDurationInfinity: true,
                    maxLiveSyncPlaybackRate: 1,
                    liveSyncOnStallIncrease: 0,
                });
                player.hls = hls;
                const events = window.Hls.Events;
                hls.on(events.MANIFEST_PARSED, () => {
                    if (current(player)) play(player);
                });
                hls.on(events.LEVEL_UPDATED, () => {
                    if (!current(player)) return;
                    if (!Number.isFinite(player.defaultLatency) && Number.isFinite(hls.targetLatency))
                        player.defaultLatency = hls.targetLatency;
                    tuneHls(player);
                    applyDelay(player, "progress");
                });
                hls.on(events.ERROR, (_event, data) => {
                    if (!data?.fatal || !current(player)) return;
                    player.error = "방송 재생에 실패했어요. 재생 재시도를 눌러 주세요.";
                    player.status = "unsupported";
                    player.pending = null;
                    player.applied = true;
                    hls.stopLoad();
                    updatePlayerUi(player);
                });
                hls.attachMedia(player.video);
                hls.loadSource(source.url);
            }
            updatePlayerUi(player);
        } catch (error) {
            if (!current(player)) return;
            player.error = error?.message || "방송 정보를 불러오지 못했어요.";
            player.status = "unsupported";
            updatePlayerUi(player);
        }
    }
    function dispose(player) {
        player.abort.abort();
        player.unbind?.();
        player.hls?.destroy();
        if (!player.main && player.video) {
            player.video.pause();
            player.video.removeAttribute("src");
            player.video.load();
            player.video.remove();
        }
        players.delete(player.id);
    }
    function ensurePlayers() {
        for (const player of [...players.values()]) {
            if (!state.channels.some((entry) => entry.id === player.id) || player.main !== (player.id === routeId))
                dispose(player);
        }
        for (const entry of state.channels) {
            if (players.has(entry.id)) continue;
            const player = {
                id: entry.id,
                main: entry.id === routeId,
                abort: new AbortController(),
                video: null,
                loaded: false,
                savedDelay: 0,
                delay: 0,
                status: "waiting",
                revision: 0,
                error: "",
            };
            players.set(entry.id, player);
            if (!player.main) {
                const video = el("video");
                video.setAttribute("data-bcmv-video", "1");
                video.playsInline = true;
                bindVideo(player, video);
            }
            void loadPlayer(player);
        }
        syncNative();
    }
    function syncNative() {
        const player = players.get(routeId);
        if (!player?.metaReady || !native?.isConnected) return;
        const video = native.querySelector("video.webplayer-internal-video");
        if (!video || (oldMedia?.video === video && oldMedia.src === video.currentSrc)) return;
        oldMedia = null;
        bindVideo(player, video);
        applyDelay(player);
    }
    function boxRect(id, rect, bounds = host?.getBoundingClientRect()) {
        const video = players.get(id)?.video;
        if (!bounds?.width || !bounds.height) return rect;
        const ratio = video?.videoWidth > 0 && video?.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
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
                    ? { left: item.position * 100 + "%", top: item.start * 100 + "%", height: item.length * 100 + "%" }
                    : { top: item.position * 100 + "%", left: item.start * 100 + "%", width: item.length * 100 + "%" }
            );
        }
        if (!pointerDrag && !resize && tree === state.dockTree) syncPanelOrder(layout.cells);
    }
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
        panel?.querySelector(`.bcmv-stream[data-channel="${id}"] .bcmv-stream-move`)?.focus({ preventScroll: true });
    }
    function validPanelDrag() {
        return (
            panelDrag &&
            enabled &&
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
        if (["pointercancel", "lostpointercapture"].includes(event?.type) && event.pointerId !== panelDrag?.pointerId)
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
        if (gesture && panel?.hasPointerCapture?.(gesture.pointerId)) panel.releasePointerCapture(gesture.pointerId);
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
        const control = event.target.closest("button");
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
        const next = Math.max(0, Math.min(panel.scrollHeight - panel.clientHeight, panel.scrollTop + direction * 6));
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
        text(overlay?.querySelector(".bcmv-banner"), id ? "" : message);
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
            const equalize = button("보조 방송 정렬", "equalize-layout", id);
            equalize.prepend(panelIcon("align"));
            equalize.disabled = !equalLayout(id);
            equalize.title = equalize.disabled
                ? "같은 영역에 보조 방송이 2개 이상 있을 때 사용할 수 있어요."
                : "메인 영역을 유지하고 같은 영역의 보조 방송들을 같은 크기로 정렬해요.";
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
                if (entry.id === routeId) continue;
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
            for (const player of players.values()) updatePlayerUi(player);
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
    function render() {
        if (!host || !state.active) return;
        endDrag();
        const videos = [...players.values()].filter((player) => !player.main).map((player) => player.video);
        videos.forEach((video) => video?.remove());
        overlay?.remove();
        overlay = el("div");
        overlay.id = ID;
        const grid = el("div", "bcmv-grid");
        for (let index = 0; index < state.channels.length; index += 1) {
            const entry = state.channels[index],
                cell = el("section", "bcmv-cell"),
                header = el("div", "bcmv-head");
            if (entry) {
                const player = players.get(entry.id);
                cell.dataset.bcmvChannel = entry.id;
                if (!index) cell.dataset.main = "1";
                const name = el("span", "bcmv-name", player?.name || entry.id.slice(0, 8));
                name.dataset.channel = entry.id;
                name.title = "우클릭으로 음소거 전환 · 드래그하여 위치 이동 · Alt + 드래그로 박스 안 이동";
                if (index) {
                    const remove = button("×", "remove", entry.id);
                    remove.setAttribute("aria-label", "방송 제거");
                    remove.title = "방송 제거";
                    header.append(name, remove);
                    cell.append(header);
                    const controls = el("div", "bcmv-controls"),
                        playback = button("", "toggle-play", entry.id),
                        mute = button("", "mute", entry.id),
                        volume = el("input");
                    controls.setAttribute("role", "group");
                    controls.setAttribute("aria-label", "보조 방송 재생 조작");
                    volume.type = "range";
                    volume.min = "0";
                    volume.max = "100";
                    volume.step = "1";
                    volume.dataset.channel = entry.id;
                    volume.setAttribute("aria-label", "볼륨");
                    const reset = button("", "reset-delay", entry.id);
                    setControlIcon(reset, "fastForward", "빨리 감기");
                    controls.append(playback, reset, mute, volume);
                    controls.append(delayButton(-0.1, entry.id), delayButton(0.1, entry.id));
                    cell.append(controls);
                }
                if (index && player?.video) {
                    player.video.draggable = false;
                    player.video.dataset.channel = entry.id;
                    cell.append(player.video);
                }
                if (index) {
                    const error = el("div", "bcmv-error"),
                        content = el("div", "bcmv-error-content"),
                        notice = el("p"),
                        actions = el("div", "bcmv-error-actions");
                    error.hidden = true;
                    notice.setAttribute("role", "status");
                    actions.append(
                        button("재생 재시도", "retry", entry.id),
                        button("다시 저장", "apply-delay", entry.id)
                    );
                    content.append(notice, actions);
                    error.append(content);
                    cell.append(error);
                }
            }
            grid.append(cell);
        }
        if (!panel?.isConnected) {
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
        const banner = el("div", "bcmv-banner", panelId ? "" : message);
        banner.setAttribute("role", "status");
        overlay.append(grid, banner);
        host.append(overlay);
        overlay.addEventListener("click", onClick, true);
        overlay.addEventListener("input", onInput);
        overlay.addEventListener("wheel", onVolumeWheel, { capture: true, passive: false });
        overlay.addEventListener("keydown", onKey);
        overlay.addEventListener("dragstart", (event) => event.preventDefault());
        // Receive owned-player input before document-level right-click unblockers stop propagation.
        window.addEventListener("contextmenu", onContextMenu, true);
        positionCells();
        for (const player of players.values()) updatePlayerUi(player);
        renderPanel(panelId);
    }
    function swap(a, b, fromPanel = false) {
        const first = state.channels.findIndex((entry) => entry.id === a),
            second = state.channels.findIndex((entry) => entry.id === b);
        if (first < 0 || second < 0 || first === second) return;
        if (!first || !second) {
            const id = first ? a : b;
            const link = el("a");
            link.href = `/live/${id}`;
            link.dataset.channel = id;
            link.dataset.action = "main";
            overlay.append(link);
            if (fromPanel) panelNavigation = { from: routeId, to: id, generation, focusId: a };
            if (!navigate(link)) panelNavigation = null;
            link.remove();
            return;
        }
        const next = model.dockTree(state.dockTree, a, b, "center", routeId);
        moveSlotAudio(state.dockTree, next, a, b, "center");
        state.dockTree = next;
        state.customLayout = true;
        persistSession();
        positionCells();
        if (panelId) renderPanel(panelId);
    }
    function navigate(link) {
        const id = link.dataset.channel;
        if (!state.channels.some((entry) => entry.id === id) || id === routeId) return false;
        persistSession();
        const accepted = !link.dispatchEvent(
            new CustomEvent("betterchzzk:multiview-navigate", { bubbles: true, cancelable: true })
        );
        if (!accepted) notice("페이지 내부 이동을 사용할 수 없어요. 현재 방송은 유지돼요.");
        return accepted;
    }
    function equalLayout(id) {
        const bounds = host?.getBoundingClientRect();
        return model.equalizeTree(state.dockTree, id, routeId, bounds?.width / bounds?.height);
    }
    function onClick(event) {
        if (panel?.contains(event.target) && suppressPanelClick && event.detail !== 0) {
            suppressPanelClick = false;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        const control = event.target.closest("[data-action]");
        if (!control || (control !== chatButton && !overlay?.contains(control) && !panel?.contains(control))) return;
        const action = control.dataset.action,
            player = players.get(control.dataset.channel);
        if (action === "main") {
            event.preventDefault();
            navigate(control);
            return;
        }
        if (action === "add") {
            notice("");
            renderPanel("add", true);
        } else if (action === "close-panel") {
            closePanel();
        } else if (action === "controls" && control === chatButton && state.active) {
            event.preventDefault();
            event.stopPropagation();
            notice("");
            if (panelId) closePanel();
            else renderPanel(state.channels[1]?.id || "settings", true);
        } else if (action === "stop") {
            state.active = false;
            persistSession();
            teardown(false);
            mount();
        } else if (action === "reset-layout") {
            Object.assign(state, model.autoSplits(state.channels.length));
            state.dockTree = model.defaultTree(state.channels);
            state.customLayout = false;
            for (const entry of state.channels) entry.position = [0.5, 0.5];
            positionCells();
            persistSession();
            if (panelId) {
                renderPanel(panelId);
                panel.querySelector('[data-action="reset-layout"]')?.focus({ preventScroll: true });
            }
        } else if (action === "equalize-layout" && player && !player.main) {
            cancelResize();
            endDrag();
            const arranged = equalLayout(player.id);
            if (!arranged || !model.validTree(arranged.tree, state.channels)) return;
            state.dockTree = arranged.tree;
            state.customLayout = true;
            for (const entry of state.channels) if (arranged.ids.includes(entry.id)) entry.position = [0.5, 0.5];
            positionCells();
            persistSession();
            renderPanel(panelId);
            panel.querySelector('[data-action="equalize-layout"]')?.focus({ preventScroll: true });
        } else if (action === "remove" && player && !player.main) {
            const fromPanel = panel?.contains(control);
            state.channels = state.channels.filter((entry) => entry.id !== player.id);
            state.dockTree = state.customLayout
                ? model.removeTree(state.dockTree, player.id)
                : model.defaultTree(state.channels);
            if (state.channels.length === 1) state.dockTree = state.channels[0].id;
            dispose(player);
            if (panelId === player.id) panelId = state.channels[1]?.id || "settings";
            persistSession();
            render();
            if (fromPanel)
                (
                    panel.querySelector('[data-action="remove"]') || panel.querySelector('[data-action="close-panel"]')
                )?.focus({ preventScroll: true });
        } else if (action === "mute" && player?.video) {
            toggleMute(player);
        } else if (action === "toggle-play" && player?.video) {
            if (player.video.paused) void play(player);
            else player.video.pause();
            updatePlayerUi(player);
        } else if (action === "retry" && player) {
            dispose(player);
            ensurePlayers();
            render();
        } else if (action === "delay" && player) {
            // Establish a measured target only when leaving live mode or migrating
            // the old basis. Subsequent steps must not accumulate observation drift.
            const needsMeasuredTarget = player.delay === 0 || player.delayBasis === "legacy";
            const timing = needsMeasuredTarget && player.applied && !player.pending ? measureTiming(player) : null;
            const measured = timing ? timing.latency : player.delay;
            setDelay(
                player,
                Math.max(0, measured + Number(control.dataset.delta)),
                timing ? "live-edge-clock" : player.delayBasis
            );
        } else if (action === "reset-delay" && player) setDelay(player, 0);
        else if (action === "apply-delay" && player) setDelay(player, player.delay, player.delayBasis);
    }
    function addProblem(id) {
        if (!id) return "올바른 치지직 라이브 URL을 입력해 주세요.";
        if (state.channels.some((entry) => entry.id === id)) return "이미 추가된 방송이에요.";
        if (state.channels.length >= 6) return "방송은 최대 6개까지 추가할 수 있어요.";
        return "";
    }
    function addStreamFromUrl(value) {
        if (!enabled || !state.active || !routeId || !host) return false;
        notice("");
        const id = model.channelFromUrl(value),
            problem = addProblem(id);
        if (problem) {
            notice(problem);
            return false;
        }
        state.channels.push({ id, volume: 0.3, muted: true });
        state.dockTree = state.customLayout
            ? model.addTree(state.dockTree, id, routeId)
            : model.defaultTree(state.channels);
        panelId = null;
        persistSession();
        ensurePlayers();
        render();
        return true;
    }
    function onSubmit(event) {
        event.preventDefault();
        addStreamFromUrl(event.target.querySelector('input[name="liveUrl"]')?.value);
    }
    function isLinkTransfer(transfer) {
        const types = Array.from(transfer?.types || []);
        return !types.includes("Files") && (types.includes("text/uri-list") || types.includes("text/plain"));
    }
    function transferredUrl(transfer) {
        const uri = transfer.getData("text/uri-list");
        const value = uri || transfer.getData("text/plain");
        if (typeof value !== "string" || value.length > 4096) return "";
        const lines = value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && (!uri || !line.startsWith("#")));
        return lines.length === 1 ? lines[0] : "";
    }
    function hideAddDropHint() {
        addDropHint?.remove();
        addDropHint = null;
    }
    function clearIncomingDrag() {
        incomingDrag = null;
        hideAddDropHint();
    }
    function trackIncomingDrag(event) {
        clearIncomingDrag();
        const link = event.target instanceof Element && event.target.closest("a[href]");
        if (link instanceof HTMLAnchorElement && !host?.contains(link))
            incomingDrag = { link, href: link.href, generation, route: routeId };
    }
    function incomingDragProblem() {
        if (!incomingDrag) return "";
        if (
            incomingDrag.invalid ||
            incomingDrag.generation !== generation ||
            incomingDrag.route !== routeId ||
            !incomingDrag.link.isConnected ||
            incomingDrag.link.href !== incomingDrag.href
        )
            return "방송 구성이 바뀌었어요. 링크를 다시 끌어 주세요.";
        return addProblem(model.channelFromUrl(incomingDrag.href));
    }
    function onAddDragOver(event) {
        if (!enabled || !state.active || !overlay || pointerDrag || resize || !isLinkTransfer(event.dataTransfer))
            return;
        event.preventDefault();
        event.stopPropagation();
        // The URL itself is protected until drop for drags from another tab/app.
        const problem =
            incomingDragProblem() || (state.channels.length >= 6 ? "방송은 최대 6개까지 추가할 수 있어요." : "");
        event.dataTransfer.dropEffect = problem
            ? "none"
            : ["link", "linkMove"].includes(event.dataTransfer.effectAllowed)
              ? "link"
              : "copy";
        if (!addDropHint?.isConnected) {
            addDropHint = el("div", "bcmv-add-drop");
            addDropHint.setAttribute("role", "status");
            addDropHint.append(el("span"));
            overlay.append(addDropHint);
        }
        addDropHint.dataset.invalid = problem ? "1" : "0";
        text(addDropHint.firstElementChild, problem || "여기에 놓아 방송 추가");
    }
    function onAddDragLeave(event) {
        if (!host?.contains(event.relatedTarget)) hideAddDropHint();
    }
    function onAddDrop(event) {
        if (!enabled || !state.active || pointerDrag || resize || !isLinkTransfer(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const value = transferredUrl(event.dataTransfer),
            problem = incomingDragProblem();
        const changed =
            incomingDrag && !problem && model.channelFromUrl(value) !== model.channelFromUrl(incomingDrag.href);
        clearIncomingDrag();
        if (problem || changed) {
            notice(problem || "끌어온 방송 주소가 바뀌었어요. 다시 끌어 주세요.");
            return;
        }
        addStreamFromUrl(value);
    }
    function onVolumeWheel(event) {
        if (!enabled || !state.active || !featureOptions?.volumeWheelEnabled) return;
        if (!Number.isFinite(event.deltaY) || !event.deltaY || !(event.target instanceof Element)) return;
        const control = event.target.closest('.bcmv-controls [data-action="mute"], .bcmv-controls input[type="range"]');
        if (!control || !overlay?.contains(control)) return;
        const player = players.get(control.dataset.channel);
        const cell = control.closest(".bcmv-cell");
        if (
            !player ||
            player.main ||
            !current(player) ||
            cell?.dataset.bcmvChannel !== player.id ||
            !cell.contains(player.video)
        )
            return;
        event.preventDefault();
        event.stopPropagation();
        const step = featureOptions.volumeWheelStep / 100;
        const before = player.video.muted ? 0 : player.video.volume;
        const volume = Math.round(Math.max(0, Math.min(1, before + (event.deltaY < 0 ? step : -step))) * 10000) / 10000;
        player.video.volume = volume;
        player.video.muted = volume === 0;
        // A focused slider skips passive UI updates, so update it for this explicit gesture too.
        cell.querySelector('input[type="range"]').value = Math.round(volume * 100);
        captureAudio(player);
    }
    function onInput(event) {
        if (!event.target.matches('input[type="range"]')) return;
        const player = players.get(event.target.dataset.channel);
        if (player?.video) {
            player.video.volume = Number(event.target.value) / 100;
            if (player.video.volume > 0) player.video.muted = false;
            captureAudio(player);
        }
    }
    function adjustSplit(path, value) {
        const handle = model.treeLayout(state.dockTree).handles.find((item) => item.key === path);
        if (!handle) return;
        state.dockTree = model.resizeTree(state.dockTree, path, Math.min(handle.upper, Math.max(handle.lower, value)));
        state.customLayout = true;
        positionCells();
    }
    function onKey(event) {
        const move = event.target.closest(".bcmv-stream-move");
        if (move && panel?.contains(move) && (event.key === " " || event.key === "Enter")) {
            event.preventDefault();
            event.stopPropagation();
            if (!move.disabled) startPanelDrag(move.closest(".bcmv-stream"), event, true);
            return;
        }
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
        if (event.key === "Escape" && panelId) {
            event.preventDefault();
            event.stopPropagation();
            closePanel();
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
                adjustSplit(handle.key, handle.value + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -0.01 : 0.01));
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
    function toggleMute(player) {
        player.video.muted = !(player.video.muted || player.video.volume === 0);
        if (!player.video.muted && player.video.volume === 0) player.video.volume = 0.3;
        captureAudio(player);
    }
    function onContextMenu(event) {
        if (panelDrag) {
            event.preventDefault();
            event.stopPropagation();
            endPanelDrag();
            return;
        }
        if (pointerDrag) {
            event.preventDefault();
            event.stopPropagation();
            endDrag();
            return;
        }
        if (!(event.target instanceof Element)) return;
        const cell = event.target.closest(".bcmv-cell[data-bcmv-channel]");
        const player = cell && players.get(cell.dataset.bcmvChannel);
        if (!player || player.main || !current(player) || !overlay?.contains(cell)) return;
        if (!player.video || !cell.contains(player.video)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleMute(player);
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
            !event.target.closest('button, a, input, select, textarea, [role="button"], [role="slider"], [role="menu"]')
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
            space: fitted && [(leaf.rect[2] - fitted[2]) * bounds.width, (leaf.rect[3] - fitted[3]) * bounds.height],
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
                    (current.region[vertical ? 0 : 1] + current.region[vertical ? 2 : 3] * result.value) * 100 + "%";
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
            ((horizontal ? region[0] : region[1]) + (horizontal ? region[2] : region[3]) * result.value) * 100 + "%";
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
    function releaseHost() {
        hideAddDropHint();
        if (incomingDrag) incomingDrag = { invalid: true };
        removeChatButton();
        stopPanelTracking();
        panel?.remove();
        panel = null;
        window.removeEventListener("contextmenu", onContextMenu, true);
        modeObserver?.disconnect();
        modeObserver = null;
        sizeObserver?.disconnect();
        sizeObserver = null;
        cancelResize();
        endDrag();
        host?.removeEventListener("pointerdown", onPointerDown, true);
        host?.removeEventListener("click", onHostClick, true);
        host?.removeEventListener("dragstart", onNativeDragStart, true);
        host?.removeEventListener("dragenter", onAddDragOver, true);
        host?.removeEventListener("dragover", onAddDragOver, true);
        host?.removeEventListener("dragleave", onAddDragLeave, true);
        host?.removeEventListener("drop", onAddDrop, true);
        overlay?.remove();
        launcher?.remove();
        overlay = launcher = null;
        host?.removeAttribute("data-bcmv-host");
        host?.style.removeProperty("--bcmv-main-left");
        host?.style.removeProperty("--bcmv-main-top");
        host?.style.removeProperty("--bcmv-main-width");
        host?.style.removeProperty("--bcmv-main-height");
        native?.removeAttribute("data-bcmv-native");
        host = native = null;
    }
    function teardown(clearMediaGuard) {
        generation += 1;
        for (const player of [...players.values()]) dispose(player);
        releaseHost();
        panelId = null;
        panelNavigation = panelFocusId = null;
        if (clearMediaGuard) oldMedia = null;
    }
    function alignRoute() {
        if (!routeId) return;
        const index = state.channels.findIndex((entry) => entry.id === routeId);
        if (index > 0) {
            const previous = state.channels[0].id;
            transferSlotAudio([
                [previous, routeId],
                [routeId, previous],
            ]);
            state.dockTree = model.mapTree(state.dockTree, (id) =>
                id === previous ? routeId : id === routeId ? previous : id
            );
            [state.channels[0], state.channels[index]] = [state.channels[index], state.channels[0]];
        } else if (index < 0) {
            const video = document.querySelector(`${NATIVE} video.webplayer-internal-video`);
            const previous = state.channels[0];
            state.channels.unshift({
                id: routeId,
                volume: previous?.volume ?? video?.volume ?? 0.3,
                muted: previous?.muted ?? video?.muted ?? true,
            });
            if (previous) Object.assign(previous, { volume: 0.3, muted: true });
            state.channels = state.channels.slice(0, 6);
            state.dockTree = model.defaultTree(state.channels);
            state.customLayout = false;
        }
        persistSession();
    }
    function removeChatButton() {
        chatButton?.remove();
        // React may clone the header, including our wrapper; preserve every native/moderator child.
        for (const group of new Set([chatActions, ...document.querySelectorAll(CHAT_ACTIONS)])) {
            if (!group) continue;
            group.querySelectorAll(`#${CHAT_BUTTON_ID}`).forEach((node) => node.remove());
            while (group.firstChild && group.parentElement) group.parentElement.insertBefore(group.firstChild, group);
            group.remove();
        }
        chatButton = chatActions = chatHeader = null;
    }
    function syncChatButton() {
        const chat = document.querySelector(CHAT);
        // Measured 2026-09-06: direct header with h2 "채팅", a fold wrapper and a right menu wrapper.
        const title = chat?.querySelector("h2");
        const header = title?.textContent.trim() === "채팅" ? title.parentElement : null;
        const menu = header?.querySelector('button[aria-label="더보기 메뉴"]');
        if (!enabled || !state.active || !menu) {
            if (chatActions || document.getElementById(CHAT_BUTTON_ID)) removeChatButton();
            return;
        }
        const anchor = menu.closest(MODERATOR_ACTIONS) || menu;
        if (!chatButton?.isConnected || !chatActions?.isConnected || anchor.parentElement !== chatActions) {
            removeChatButton();
            chatActions = el("span");
            chatActions.setAttribute("data-bcmv-chat-actions", "1");
            anchor.before(chatActions);
            chatButton = button("", "controls");
            chatButton.id = CHAT_BUTTON_ID;
            chatButton.title = "멀티뷰 설정";
            chatButton.setAttribute("aria-label", "멀티뷰 설정");
            chatButton.setAttribute("aria-haspopup", "dialog");
            chatButton.setAttribute("aria-controls", PANEL_ID);
            chatButton.append(multiviewIcon());
            chatButton.addEventListener("click", onClick);
            chatActions.append(chatButton, anchor);
        }
        chatHeader = header;
        chatButton.setAttribute("aria-expanded", String(Boolean(panelId)));
    }
    function syncLauncher() {
        const reference = native?.querySelector(".pzp-pc__viewmode-button");
        if (!reference?.parentElement) {
            launcher?.remove();
            launcher = null;
            return;
        }
        if (!launcher?.isConnected || launcher.parentElement !== reference.parentElement) {
            launcher?.remove();
            // React may replace the control bar with a cloned node carrying our old marker.
            native.querySelectorAll("#betterchzzk-multiview-launcher").forEach((node) => node.remove());
            launcher = button("", "toggle-multiview");
            launcher.id = "betterchzzk-multiview-launcher";
            launcher.className = "pzp-button";
            launcher.append(multiviewIcon());
            launcher.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                state.active = !state.active;
                persistSession();
                if (!state.active) teardown(false);
                else releaseHost();
                mount();
                if (state.active && state.channels.length === 1) renderPanel("add", true);
                else launcher?.focus({ preventScroll: true });
            });
            reference.before(launcher);
        }
        const label = state.active ? "멀티뷰 끄기" : "멀티뷰 켜기";
        launcher.setAttribute("aria-label", label);
        root.utils.syncPlayerButtonTooltip(launcher, label);
        launcher.setAttribute("aria-pressed", String(state.active));
        const controlsVisible = Boolean(reference.closest(".pzp-pc")?.classList.contains("pzp-pc--controls"));
        launcher.tabIndex = controlsVisible ? 0 : -1;
        launcher.setAttribute("aria-hidden", String(!controlsVisible));
    }
    function mount() {
        if (!enabled || !routeId) return;
        const nextNative = document.querySelector(NATIVE),
            nextHost = nextNative?.parentElement;
        if (!nextHost) {
            if (host || players.size) teardown(false);
            return;
        }
        if (host !== nextHost || native !== nextNative || (state.active && !overlay?.isConnected)) {
            releaseHost();
            host = nextHost;
            native = nextNative;
            host.addEventListener("pointerdown", onPointerDown, true);
            host.addEventListener("click", onHostClick, true);
            host.addEventListener("dragstart", onNativeDragStart, true);
            host.addEventListener("dragenter", onAddDragOver, true);
            host.addEventListener("dragover", onAddDragOver, true);
            host.addEventListener("dragleave", onAddDragLeave, true);
            host.addEventListener("drop", onAddDrop, true);
            if (typeof ResizeObserver === "function") {
                sizeObserver = new ResizeObserver(() => {
                    if (!state.active) return;
                    cancelResize();
                    endDrag();
                    positionCells();
                });
                sizeObserver.observe(host);
            }
            const playerRoot = native.querySelector(".pzp-pc");
            if (playerRoot) {
                modeObserver = new MutationObserver(scheduleMount);
                modeObserver.observe(playerRoot, { attributes: true, attributeFilter: ["class"] });
            }
            host.setAttribute("data-bcmv-host", state.active ? "active" : "idle");
            native.setAttribute("data-bcmv-native", "1");
            if (state.active) {
                alignRoute();
                ensurePlayers();
                render();
            }
        }
        syncLauncher();
        syncChatButton();
        if (state.active) syncNative();
        positionPanel();
    }
    function scheduleMount() {
        if (frame || !enabled) return;
        const token = generation;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (enabled && token === generation) mount();
        });
    }
    function onRoute() {
        const next = model.channelFromUrl(location.href);
        if (next === routeId) return;
        const restorePanel =
            panelId &&
            panelNavigation?.from === routeId &&
            panelNavigation.to === next &&
            panelNavigation.generation === generation
                ? panelNavigation
                : null;
        for (const player of players.values()) if (current(player) && player.video) captureAudio(player);
        const video = players.get(routeId)?.video;
        oldMedia = video ? { video, src: video.currentSrc } : null;
        teardown(!next);
        routeId = next;
        if (restorePanel) {
            panelId = restorePanel.from;
            panelFocusId = restorePanel.focusId;
        }
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        mount();
    }
    function storageChanged(changes, area) {
        if (area !== "local") return;
        for (const player of players.values()) {
            const change = changes[model.delayKey(player.id)];
            if (!change || player.saving || !player.loaded) continue;
            player.savedDelay = player.delay = model.readDelay(change.newValue);
            player.delayBasis = player.savedBasis = model.delayBasis(change.newValue);
            player.pending = null;
            player.applied = false;
            tuneHls(player);
            applyDelay(player);
        }
    }
    function configure(options) {
        featureOptions = options;
        const next = Boolean(options.liveMultiviewEnabled);
        if (next === enabled) return;
        enabled = next;
        if (!enabled) {
            observer?.disconnect();
            observer = null;
            stopRoute?.();
            stopRoute = null;
            document.removeEventListener("loadedmetadata", scheduleMount, true);
            chrome.storage?.onChanged?.removeListener(storageChanged);
            window.removeEventListener("dragstart", trackIncomingDrag, true);
            window.removeEventListener("dragend", clearIncomingDrag, true);
            window.removeEventListener("pagehide", clearIncomingDrag);
            if (frame) cancelAnimationFrame(frame);
            frame = 0;
            teardown(true);
            document.getElementById(STYLE_ID)?.remove();
            return;
        }
        routeId = model.channelFromUrl(location.href);
        injectStyleOnce(STYLE_ID, css);
        observer = new MutationObserver((mutations) => {
            if (
                mutations.some((mutation) => {
                    if (mutation.target instanceof Element && mutation.target.closest(`#${ID},#${PANEL_ID}`))
                        return false;
                    const target = mutation.target;
                    if (
                        target instanceof Element &&
                        target.closest(`#${CHAT_BUTTON_ID}, [data-bcct-moderator-trigger]`)
                    )
                        return false;
                    if (target instanceof Element && (target.matches(CHAT) || chatHeader?.contains(target)))
                        return true;
                    return mutationMatchesSelector(
                        mutation,
                        `${NATIVE}, ${CHAT}, ${CHAT_ACTIONS}, ${MODERATOR_ACTIONS}, [data-bcct-moderator-trigger], video.webplayer-internal-video, .pzp-pc__viewmode-button, #betterchzzk-multiview-launcher`
                    );
                })
            )
                scheduleMount();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
        });
        document.addEventListener("loadedmetadata", scheduleMount, true);
        chrome.storage?.onChanged?.addListener(storageChanged);
        window.addEventListener("dragstart", trackIncomingDrag, true);
        window.addEventListener("dragend", clearIncomingDrag, true);
        window.addEventListener("pagehide", clearIncomingDrag);
        stopRoute = startPageChangeDetection(onRoute);
        mount();
    }
    root.liveMultiview = {
        init() {
            bindFeatureOptions(configure);
        },
    };
    root.liveMultiview.init();
})();
