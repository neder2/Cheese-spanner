/**
 * 라이브 멀티뷰 라우트·마운트 조정. isolated world; model/view/playback/layoutControls/settingsPanel 다음에 로드한다.
 * 네이티브 플레이어는 원래 부모에 두고 크기만 조절한다. 채팅·하단 정보는 치지직 라우터가 소유한다.
 * 2026-09-05 /live/64a90ba95d1f9feb0a798a20bbf0f40c에서 .chzzk_player.type_live와
 * 그 부모의 고정된 영상 영역, .pzp-pc--adbreak, HLS/LLHLS live-detail 응답을 확인했다.
 */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    if (root.liveMultiview) return;
    const model = root.multiviewModel;
    const { bindFeatureOptions, startPageChangeDetection, injectStyleOnce, mutationMatchesSelector } = root.utils;
    const ID = "betterchzzk-multiview";
    const PANEL_ID = `${ID}-panel`;
    const CHAT = "aside#aside-chatting";
    const CHAT_BUTTON_ID = `${ID}-chat-settings`;
    const CHAT_ACTIONS = "[data-bcmv-chat-actions]";
    const MODERATOR_ACTIONS = "[data-bcct-moderator-actions]";
    const STYLE_ID = `${ID}-style`;
    const NATIVE = ".chzzk_player.type_live";
    const state = model.readSession(window.sessionStorage);
    let featureOptions = null;
    let enabled = false,
        host = null,
        native = null,
        overlay = null,
        launcher = null;
    let chatButton = null,
        chatActions = null,
        chatHeader = null;
    let incomingDrag = null,
        addDropHint = null;
    let observer = null,
        modeObserver = null,
        sizeObserver = null,
        stopRoute = null,
        frame = 0,
        generation = 0;
    let routeId = model.channelFromUrl(location.href);
    let message = "";
    const { text, el, button, delayButton, multiviewIcon, setControlIcon, action: controlAction } = root.multiviewView;
    const players = root.multiviewPlayback.create({
        state,
        onChange: updatePlayerUi,
        onGeometry: () => layout.position(),
        persistSession,
    });
    const settingsPanel = root.multiviewSettingsPanel.create({
        state,
        players,
        persistSession,
        onLayout: () => layout.position(),
        onSwap: swap,
        equalLayout,
        onAction: onClick,
        onAdd: addStreamFromUrl,
        cancelLayout: () => layout.cancelGesture(),
        onVisibility: () => text(overlay?.querySelector(".bcmv-banner"), settingsPanel.id ? "" : message),
    });
    const layout = root.multiviewLayoutControls.create({
        state,
        players,
        persistSession,
        onOrder: (cells) => settingsPanel.syncOrder(cells),
        onSwap: swap,
        onLayerChange: () => {
            hideAddDropHint();
            settingsPanel.syncLayer();
            document.dispatchEvent(new CustomEvent("betterchzzk:multiview-layer-change"));
        },
        onError: notice,
    });
    const css = `
[data-bcmv-host],#${PANEL_ID}{isolation:isolate;--bcmv-font:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Malgun Gothic","맑은 고딕",sans-serif;--bcmv-fallback-surface:#fff;--bcmv-fallback-content:#202124;--bcmv-fallback-border:#d2d4d6;--bcmv-surface:var(--sem-color-surface-neutral-weaker,var(--Surface-neutral,var(--bcmv-fallback-surface)));--bcmv-content:var(--sem-color-content-neutral-primary,var(--Content-emphasized,var(--bcmv-fallback-content)));--bcmv-border:var(--sem-color-border-neutral-base,var(--Border-neutral,var(--bcmv-fallback-border)))}
html.theme_dark :is([data-bcmv-host],#${PANEL_ID}){--bcmv-fallback-surface:#23252b;--bcmv-fallback-content:#eee;--bcmv-fallback-border:#5e6069}
[data-bcmv-host="active"] > [data-bcmv-native]{position:absolute!important;left:var(--bcmv-main-left,0)!important;top:var(--bcmv-main-top,0)!important;width:var(--bcmv-main-width)!important;height:calc(100% * var(--bcmv-main-height))!important;min-width:0!important;min-height:0!important}
[data-bcmv-viewport][popover]{position:fixed!important;inset:0!important;margin:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;pointer-events:none}
[data-bcmv-viewport]::backdrop,.bcmv-panel[popover]::backdrop{background:transparent;pointer-events:none}
[data-bcmv-viewport] > [data-bcmv-native]{pointer-events:auto}
.bcmv-panel[popover]{inset:auto;margin:0;max-width:none}
[data-bcmv-free] > [data-bcmv-native]{z-index:var(--bcmv-main-layer,2)!important}
[data-bcmv-free] > #${ID}{z-index:auto}
[data-bcmv-free] .bcmv-cell{box-shadow:0 3px 14px #0005}
[data-bcmv-free] .bcmv-cell[data-main="1"]{box-shadow:none}
[data-bcmv-free] :is(.bcmv-add-drop,.bcmv-banner,.bcmv-position-guide){z-index:30}
[data-bcmv-host="active"] [data-bcmv-native] :is(.pzp-pc__video,.webplayer-internal-video){touch-action:none;-webkit-user-drag:none}
[data-bcmv-host="active"] > [data-bcmv-native] .pzp-pc__mute-indicator{display:none!important}
#${ID}{position:absolute;inset:0;z-index:20;pointer-events:none;color:var(--bcmv-content);font:12px/1.4 var(--bcmv-font)}
:is(#${ID},#${PANEL_ID}) *{box-sizing:border-box}
:is(#${ID},#${PANEL_ID}) :is(button,input,a){font:inherit;color:inherit}
:is(#${ID},#${PANEL_ID}) :is(button,a){border:1px solid var(--bcmv-border);border-radius:4px;background:var(--bcmv-surface);padding:3px 6px;cursor:pointer;text-decoration:none;white-space:nowrap}
:is(#${ID},#${PANEL_ID}) :focus-visible{outline:2px solid #00c894;outline-offset:-2px}
:is(#${ID},#${PANEL_ID}) button:disabled{opacity:.55;cursor:default}
.bcmv-layout-option{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--bcmv-border);margin-bottom:10px}
.bcmv-layout-option p{margin:4px 0 0;font-size:12px;line-height:1.5;opacity:.8;white-space:normal;word-break:keep-all}
#${PANEL_ID} .bcmv-layout-toggle{flex:none;min-width:52px;min-height:32px;font-weight:600}
#${PANEL_ID} .bcmv-layout-toggle[aria-checked="true"]{background:var(--bcmv-brand-fill);color:var(--sem-color-content-neutral-inverse-static,#0e0f10);border-color:var(--bcmv-brand-fill)}
#${PANEL_ID} .bcmv-layout-toggle[aria-checked="true"]:hover{background:var(--sem-color-surface-brand-stronger-static,#00e693)}
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
.bcmv-add-drop[data-floating]{inset:auto;box-sizing:border-box;border-radius:4px;box-shadow:0 4px 20px #0003}
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
.bcmv-panel{position:fixed;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--bcmv-border) transparent;padding:14px;background:var(--bcmv-surface);color:var(--bcmv-content);border:1px solid var(--bcmv-border);border-radius:10px;box-shadow:0 4px 16px #0003;pointer-events:auto;z-index:100;font:13px/1.5 var(--bcmv-font)}
.bcmv-panel[hidden]{display:none}
.bcmv-panel{--bcmv-accent:#087f5b;--bcmv-danger:#c43748;--bcmv-tool-fallback:#f1f3f5;--bcmv-tool-surface:var(--sem-color-surface-neutral-weak,var(--bcmv-tool-fallback));--bcmv-brand-fill:var(--sem-color-surface-brand-strongest-static,#00ffa3)}
html.theme_dark .bcmv-panel{--bcmv-accent:var(--sem-color-content-brand-strong,#00ffa3);--bcmv-danger:#ff7b88;--bcmv-tool-fallback:#2b2d33}
#${PANEL_ID} button{margin:0}
.bcmv-panel-header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.bcmv-panel-tools{display:flex;gap:2px}
.bcmv-panel h3{margin:0;font-size:13px;font-weight:600}
#${PANEL_ID} .bcmv-panel-header button{display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;padding:0;width:28px;height:28px;border-radius:6px}
.bcmv-panel-icon{display:block;flex:none;width:16px;height:16px;pointer-events:none}
#${PANEL_ID} button:not(:disabled):hover{background:rgba(127,127,127,.12)}
#${PANEL_ID} .bcmv-panel-header [data-action="add"],#${PANEL_ID} [data-action="submit-add"]{border:0;background:var(--bcmv-brand-fill);color:var(--sem-color-content-neutral-inverse-static,#0e0f10);font-weight:600}
#${PANEL_ID} .bcmv-panel-header [data-action="add"]:hover,#${PANEL_ID} [data-action="submit-add"]:hover{background:var(--sem-color-surface-brand-stronger-static,#00e693)}
.bcmv-panel label{display:flex;flex-direction:column;align-items:stretch;gap:6px;margin:8px 0;font-size:12px}
.bcmv-panel input[name="liveUrl"]{box-sizing:border-box;width:100%;min-width:0;height:36px;background:var(--bcmv-surface);color:inherit;border:1px solid var(--bcmv-border);border-radius:6px;padding:6px 8px;font-size:12px}
.bcmv-search-results{list-style:none;margin:12px 0 0;padding:0}
.bcmv-search-results:empty{display:none}
#${PANEL_ID} .bcmv-search-result{display:flex;align-items:center;gap:10px;width:100%;min-height:56px;padding:8px 4px;border:0;border-bottom:1px solid var(--bcmv-border);border-radius:4px;background:transparent;color:inherit;text-align:left;cursor:pointer}
#${PANEL_ID} .bcmv-search-result:disabled{cursor:default;opacity:.65}
.bcmv-search-avatar{display:block;flex:none;width:32px;height:32px;overflow:hidden;border-radius:50%;background:var(--bcmv-tool-surface)}
.bcmv-search-avatar img{display:block;width:100%;height:100%;object-fit:cover}
.bcmv-search-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.bcmv-search-name{white-space:normal;overflow-wrap:anywhere;font-size:13px;font-weight:600}
.bcmv-search-detail{font-size:12px;color:var(--bcmv-content);opacity:.8}
#${PANEL_ID} .bcmv-search-result:focus-visible,.bcmv-panel input[name="liveUrl"]:focus-visible{outline:2px solid var(--bcmv-accent);outline-offset:-2px}
#${PANEL_ID} [data-action="submit-add"]{min-height:32px;padding:3px 12px;border-radius:4px}
.bcmv-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr);gap:4px;margin:0 0 12px;padding:3px;background:var(--bcmv-tool-surface);border-radius:4px}
#${PANEL_ID} .bcmv-actions button{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;min-height:32px;padding:4px 2px;border:0;border-radius:2px;background:transparent;font-size:12px;font-weight:500;white-space:normal;word-break:keep-all}
.bcmv-actions .bcmv-panel-icon{width:14px;height:14px;color:var(--bcmv-accent)}
#${PANEL_ID} .bcmv-actions button:disabled .bcmv-panel-icon{color:inherit}
.bcmv-streams{list-style:none;margin:0;padding:0;border-top:1px solid var(--bcmv-border)}
.bcmv-stream{display:grid;grid-template-columns:minmax(0,1fr) 24px;align-items:center;gap:6px 8px;padding:12px 0;border-bottom:1px solid var(--bcmv-border)}
.bcmv-stream{position:relative}
.bcmv-stream[data-main="1"]{padding:5px 0}
#${PANEL_ID} .bcmv-stream-move{grid-column:1;grid-row:1;display:flex;align-items:center;gap:5px;min-width:0;max-width:100%;min-height:24px;border:0;padding:2px 0;background:transparent;text-align:left;cursor:grab;touch-action:none;user-select:none;-webkit-user-drag:none}
.bcmv-stream-role{flex:none;font-size:12px;font-weight:400;opacity:.7}
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
.bcmv-stream-timing{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:2px 6px;min-width:0;font-size:12px;font-variant-numeric:tabular-nums}
.bcmv-stream [data-bcmv-delay]{opacity:.7}
.bcmv-quality,.bcmv-quality-main{grid-column:1/-1;min-width:0}
.bcmv-panel .bcmv-quality-main{margin:0 0 2px;font-size:12px;opacity:.6}
.bcmv-panel label.bcmv-quality{flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap;margin:2px 0 4px;font-size:12px}
.bcmv-quality-caption{opacity:.65}
.bcmv-quality-control{position:relative;display:inline-flex;flex:none}
.bcmv-quality-control::after{content:"";position:absolute;right:10px;top:9px;width:5px;height:5px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);opacity:.55;pointer-events:none}
.bcmv-quality select{appearance:none;box-sizing:border-box;width:80px;height:26px;min-height:0;margin:0;color:inherit;background:var(--bcmv-tool-surface);border:1px solid transparent;border-radius:7px;padding:0 25px 0 10px;font:inherit;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;transition:background .15s,border-color .15s}
.bcmv-quality select:not(:disabled):hover{border-color:var(--bcmv-border);background:var(--bcmv-surface)}
.bcmv-quality select:focus-visible{outline:2px solid var(--bcmv-accent);outline-offset:2px}
.bcmv-quality select:disabled{opacity:.5;cursor:default}
.bcmv-quality select option{color:inherit;background:var(--bcmv-surface)}
.bcmv-quality-status{flex-basis:100%;font-size:12px;opacity:.7;overflow-wrap:anywhere}
.bcmv-quality-status:empty{display:none}
.bcmv-stream-detail{grid-column:1/-1;display:flex;align-items:center;gap:6px;min-width:0}
.bcmv-stream-sync{display:flex;flex:none;gap:3px}
#${PANEL_ID} .bcmv-stream-sync button{min-width:40px;min-height:24px;padding:2px 5px;border:0;border-radius:3px;color:var(--bcmv-accent);background:rgba(0,200,148,.09);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
#${PANEL_ID} .bcmv-stream-sync button:not(:disabled):hover{background:rgba(0,200,148,.2)}
.bcmv-stream [data-bcmv-status]{flex:1;min-width:0;margin:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.7}
#${PANEL_ID} .bcmv-stream [data-action="remove"]{grid-column:2;grid-row:1;display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--bcmv-danger);opacity:.8}
#${PANEL_ID} .bcmv-stream [data-action="remove"]:hover{background:rgba(232,70,90,.12);opacity:1}
.bcmv-notice{margin:5px 0;white-space:normal;overflow-wrap:anywhere}
.bcmv-panel [data-bcmv-notice]:empty{display:none}
.bcmv-banner{position:absolute;top:0;left:0;right:0;z-index:6;background:var(--bcmv-surface);padding:8px;pointer-events:auto}
.bcmv-banner:empty{display:none}
/* Keep the launcher in the native button flow with its own predictable box. */
#betterchzzk-multiview-launcher{position:relative;inset:auto;transform:none;display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:36px;height:36px;margin:0 0 0 10px;padding:6px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer}
#betterchzzk-multiview-launcher svg{width:24px;height:24px;pointer-events:none}
#betterchzzk-multiview-launcher::before{content:"";position:absolute;top:50%;left:50%;width:44px;height:44px;border-radius:50%;transform:translate(-50%,-50%);background:transparent;pointer-events:none}
#betterchzzk-multiview-launcher:hover::before{background:rgba(255,255,255,.2)}
#betterchzzk-multiview-launcher[aria-pressed="true"]{color:#00c894;background:rgba(0,200,148,.14)}
#betterchzzk-multiview-launcher:focus-visible{outline:2px solid #00c894;outline-offset:-2px}
/* Native pzp buttons fade individually with --controls (2026-09-06 player CSS). */
.pzp-pc #betterchzzk-multiview-launcher{opacity:0;pointer-events:none}
.pzp-pc.pzp-pc--controls #betterchzzk-multiview-launcher{opacity:1;pointer-events:auto}
${CHAT_ACTIONS}{display:inline-flex!important;align-items:center!important;vertical-align:top;gap:0!important;line-height:0;white-space:nowrap;margin-left:auto}
${CHAT_ACTIONS} > ${MODERATOR_ACTIONS}{height:auto!important;margin-left:0!important;transform:none!important}
#${CHAT_BUTTON_ID}{display:inline-flex;align-items:center;justify-content:center;flex:none;width:30px;height:30px;margin:0 2px 0 0;padding:0;border:0;border-radius:8px;background:transparent;--bcmv-chat-fallback:#69737f;color:var(--sem-color-content-neutral-cool-base,var(--bcmv-chat-fallback));cursor:pointer}
html.theme_dark #${CHAT_BUTTON_ID}{--bcmv-chat-fallback:#9da5b6}
#${CHAT_BUTTON_ID}:hover,#${CHAT_BUTTON_ID}[aria-expanded="true"]{color:var(--sem-color-content-brand-base,#00c894);background:rgba(0,200,148,.1)}
#${CHAT_BUTTON_ID}:focus-visible{outline:2px solid #00c894;outline-offset:-2px}
#${CHAT_BUTTON_ID} svg{width:19px;height:19px;pointer-events:none}
`;

    function notice(value) {
        message = value;
        settingsPanel.notice(value);
        text(overlay?.querySelector(".bcmv-banner"), settingsPanel.id ? "" : value);
    }
    function persistSession() {
        try {
            const windows = model.normalizeWindows(state.freeWindows, state.channels);
            if (!model.sameWindows(state.freeWindows, windows)) state.freeWindows = windows;
            if (state.freeLayoutEnabled) layout.rememberWindows();
            sessionStorage.setItem(model.SESSION_KEY, JSON.stringify(state));
        } catch {
            notice("탭 구성을 저장하지 못했어요. 새로고침 후 구성이 복원되지 않을 수 있어요.");
        }
    }
    function updatePlayerUi(player) {
        const cell = overlay?.querySelector(`[data-bcmv-channel="${player.id}"]`);
        text(cell?.querySelector(".bcmv-name"), player.name || player.id.slice(0, 8));
        const error = cell?.querySelector(".bcmv-error");
        if (error) {
            error.hidden = !player.error && !player.saveError;
            text(error.querySelector("p"), player.error || player.saveError || "");
            error.querySelector('[data-action="retry"]').hidden =
                !player.error && !(player.saveError && !player.loaded);
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
        settingsPanel.updatePlayer(player);
    }
    function render() {
        if (!host || !state.active) return;
        layout.cancelDrag();
        const videos = [...players.values()].filter((player) => !player.main).map((player) => player.video);
        videos.forEach((video) => video?.remove());
        overlay?.removeEventListener("keydown", onOverlayKey);
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
        settingsPanel.mount();
        const banner = el("div", "bcmv-banner", settingsPanel.id ? "" : message);
        banner.setAttribute("role", "status");
        overlay.append(grid, banner);
        host.append(overlay);
        overlay.addEventListener("click", onClick, true);
        overlay.addEventListener("input", onInput);
        overlay.addEventListener("wheel", onVolumeWheel, { capture: true, passive: false });
        overlay.addEventListener("dragstart", (event) => event.preventDefault());
        // Receive owned-player input before document-level right-click unblockers stop propagation.
        window.addEventListener("contextmenu", onContextMenu, true);
        layout.mount(host, native, overlay, routeId);
        overlay.addEventListener("keydown", onOverlayKey);
        settingsPanel.setContext({ host, routeId, chatButton, chatHeader, launcher });
        layout.position();
        for (const player of players.values()) updatePlayerUi(player);
        settingsPanel.show(settingsPanel.id);
    }
    function swap(a, b, fromPanel = false) {
        const first = state.channels.findIndex((entry) => entry.id === a),
            second = state.channels.findIndex((entry) => entry.id === b);
        if (first < 0 || second < 0 || first === second) return;
        layout.cancelResize();
        if (!first || !second) {
            const id = first ? a : b;
            const link = el("a");
            link.href = `/live/${id}`;
            link.dataset.channel = id;
            link.dataset.action = "main";
            overlay.append(link);
            if (fromPanel) settingsPanel.prepareNavigation(id, a);
            if (!navigate(link, id)) settingsPanel.cancelNavigation();
            link.remove();
            return;
        }
        const next = model.dockTree(state.dockTree, a, b, "center", routeId);
        if (state.freeLayoutEnabled) {
            players.transferSlotAudio([
                [a, b],
                [b, a],
            ]);
            state.freeWindows = model
                .freeLayout(state)
                .cells.map((cell) => ({ ...cell, id: cell.id === a ? b : cell.id === b ? a : cell.id }));
        } else {
            players.moveSlotAudio(state.dockTree, next, a, b, "center");
            state.dockTree = next;
            state.customLayout = true;
        }
        persistSession();
        layout.position();
        if (settingsPanel.id) settingsPanel.show(settingsPanel.id);
    }
    function onOverlayKey(event) {
        if (event.key !== "Escape" || event.defaultPrevented || !settingsPanel.id || !overlay?.contains(event.target))
            return;
        event.preventDefault();
        event.stopPropagation();
        settingsPanel.close();
    }
    function navigate(link, id = controlAction(link)?.channel) {
        if (!state.channels.some((entry) => entry.id === id) || id === routeId) return false;
        link.href = `/live/${id}`;
        persistSession();
        const accepted = !link.dispatchEvent(
            new CustomEvent("betterchzzk:multiview-navigate", { bubbles: true, cancelable: true })
        );
        if (!accepted) notice("페이지 내부 이동을 사용할 수 없어요. 현재 방송은 유지돼요.");
        return accepted;
    }
    function equalLayout() {
        if (state.freeLayoutEnabled) return null;
        const bounds = host?.getBoundingClientRect();
        let tree = state.dockTree;
        const ids = [];
        // The shared settings action covers every disjoint secondary region once.
        for (const entry of state.channels) {
            if (entry.id === routeId || ids.includes(entry.id)) continue;
            const arranged = model.equalizeTree(tree, entry.id, routeId, bounds?.width / bounds?.height);
            if (!arranged) continue;
            tree = arranged.tree;
            ids.push(...arranged.ids);
        }
        return ids.length ? { tree, ids } : null;
    }
    function onClick(event) {
        const control = event.target.closest("[data-action]");
        if (!control || (control !== chatButton && !overlay?.contains(control) && !settingsPanel.contains(control)))
            return;
        const binding = controlAction(control);
        if (!binding) return;
        const { action, channel, delta } = binding;
        if (["delay", "reset-delay", "apply-delay"].includes(action) && !event.isTrusted) return;
        const player = players.get(channel);
        if (action === "main") {
            event.preventDefault();
            navigate(control);
            return;
        }
        if (action === "add-search-result") {
            settingsPanel.addSearchResult(channel);
        } else if (action === "add") {
            notice("");
            settingsPanel.show("add", true);
        } else if (action === "close-panel") {
            settingsPanel.close();
        } else if (action === "controls" && control === chatButton && state.active) {
            event.preventDefault();
            event.stopPropagation();
            notice("");
            if (settingsPanel.id) settingsPanel.close();
            else settingsPanel.show(state.channels[1]?.id || "settings", true);
        } else if (action === "stop") {
            state.active = false;
            persistSession();
            teardown(false);
            mount();
        } else if (action === "free-layout") {
            event.preventDefault();
            event.stopPropagation();
            settingsPanel.cancelPointer();
            layout.setFreeMode(!state.freeLayoutEnabled);
            settingsPanel.show(settingsPanel.id);
            settingsPanel.focusAction("free-layout");
        } else if (action === "reset-layout") {
            layout.cancelResize();
            layout.cancelDrag();
            Object.assign(state, model.autoSplits(state.channels.length));
            state.dockTree = model.defaultTree(state.channels);
            state.customLayout = false;
            state.freeWindows = [];
            for (const entry of state.channels) entry.position = [0.5, 0.5];
            // Normalize player-relative defaults into viewport coordinates before painting free windows.
            persistSession();
            layout.position();
            if (settingsPanel.id) {
                settingsPanel.show(settingsPanel.id);
                settingsPanel.focusAction("reset-layout");
            }
        } else if (action === "equalize-layout") {
            layout.cancelResize();
            layout.cancelDrag();
            const arranged = equalLayout();
            if (!arranged || !model.validTree(arranged.tree, state.channels)) return;
            state.dockTree = arranged.tree;
            state.customLayout = true;
            for (const entry of state.channels) if (arranged.ids.includes(entry.id)) entry.position = [0.5, 0.5];
            layout.position();
            persistSession();
            settingsPanel.show(settingsPanel.id);
            settingsPanel.focusAction("equalize-layout");
        } else if (action === "remove" && player && !player.main) {
            const fromPanel = settingsPanel.contains(control);
            layout.cancelResize();
            layout.cancelDrag();
            state.channels = state.channels.filter((entry) => entry.id !== player.id);
            state.dockTree = state.customLayout
                ? model.removeTree(state.dockTree, player.id)
                : model.defaultTree(state.channels);
            if (state.channels.length === 1) state.dockTree = state.channels[0].id;
            players.dispose(player);
            settingsPanel.afterRemove(player.id);
            persistSession();
            render();
            if (fromPanel) settingsPanel.focusAfterRemove();
        } else if (action === "mute" && player?.video) {
            toggleMute(player);
        } else if (action === "toggle-play" && player?.video) {
            if (player.video.paused) void players.play(player);
            else player.video.pause();
            updatePlayerUi(player);
        } else if (action === "retry" && player) {
            players.dispose(player);
            players.reconcile(routeId, native);
            render();
        } else if (action === "delay" && player) {
            // Establish a measured target only when leaving live mode or migrating
            // the old basis. Subsequent steps must not accumulate observation drift.
            const needsMeasuredTarget = player.delay === 0 || player.delayBasis === "legacy";
            const timing =
                needsMeasuredTarget && player.applied && !player.pending ? players.measureTiming(player) : null;
            const measured = timing ? timing.latency : player.delay;
            players.setDelay(player, Math.max(0, measured + delta), timing ? "live-edge-clock" : player.delayBasis);
        } else if (action === "reset-delay" && player) players.setDelay(player, 0);
        else if (action === "apply-delay" && player) players.setDelay(player, player.delay, player.delayBasis);
    }
    function addProblem(id) {
        if (!id) return "올바른 치지직 라이브 URL을 입력해 주세요.";
        if (state.channels.some((entry) => entry.id === id)) return "이미 추가된 방송이에요.";
        if (state.channels.length >= 6) return "방송은 최대 6개까지 추가할 수 있어요.";
        return "";
    }
    function addStreamFromUrl(value, freeRect = null) {
        if (!enabled || !state.active || !routeId || !host) return false;
        notice("");
        const id = model.channelFromUrl(value),
            problem = addProblem(id);
        if (problem) {
            notice(problem);
            return false;
        }
        // A topology change must start from the committed layout, before a remount cancels its preview.
        layout.cancelResize();
        layout.cancelDrag();
        state.channels.push({ id, volume: 0.3, muted: true });
        state.dockTree = state.customLayout
            ? model.addTree(state.dockTree, id, routeId)
            : model.defaultTree(state.channels);
        if (freeRect && layout.viewportActive) state.freeWindows.push({ id, rect: [...freeRect] });
        settingsPanel.show(null);
        persistSession();
        players.reconcile(routeId, native);
        render();
        return true;
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
    function acceptsAddDrop(event) {
        if (!enabled || !state.active || !overlay || layout.busy || !isLinkTransfer(event.dataTransfer)) return false;
        const target = event.target;
        if (!(target instanceof Element) || !target.isConnected) return false;
        if (!layout.viewportActive) return host?.contains(target);
        if (target.closest(`#${PANEL_ID}, input, textarea, [contenteditable]:not([contenteditable="false"])`))
            return false;
        // Ordinary page links keep their native drop behavior outside the player.
        if (incomingDrag?.href && !model.channelFromUrl(incomingDrag.href) && !host?.contains(target)) return false;
        return Boolean(layout.incomingWindowRect(event.clientX, event.clientY));
    }
    function onAddDragOver(event) {
        if (!acceptsAddDrop(event)) {
            hideAddDropHint();
            return;
        }
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
        const rect = layout.incomingWindowRect(event.clientX, event.clientY);
        addDropHint.toggleAttribute("data-floating", Boolean(rect));
        if (rect) {
            const [x, y, width, height] = rect;
            Object.assign(addDropHint.style, {
                left: x * 100 + "%",
                top: y * 100 + "%",
                width: width * 100 + "%",
                height: height * 100 + "%",
            });
        } else addDropHint.style.cssText = "";
        addDropHint.dataset.invalid = problem ? "1" : "0";
        text(addDropHint.firstElementChild, problem || "여기에 놓아 방송 추가");
    }
    function onAddDragLeave(event) {
        const region = layout.viewportActive ? document.documentElement : host;
        if (!(event.relatedTarget instanceof Node) || !region?.contains(event.relatedTarget)) hideAddDropHint();
    }
    function onAddDrop(event) {
        if (!acceptsAddDrop(event)) {
            clearIncomingDrag();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const value = transferredUrl(event.dataTransfer),
            problem = incomingDragProblem();
        const changed =
            incomingDrag && !problem && model.channelFromUrl(value) !== model.channelFromUrl(incomingDrag.href);
        const freeRect = layout.incomingWindowRect(event.clientX, event.clientY);
        clearIncomingDrag();
        if (problem || changed) {
            notice(problem || "끌어온 방송 주소가 바뀌었어요. 다시 끌어 주세요.");
            return;
        }
        addStreamFromUrl(value, freeRect);
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
            !players.current(player) ||
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
        players.captureAudio(player);
    }
    function onInput(event) {
        if (!event.target.matches('input[type="range"]')) return;
        const player = players.get(event.target.dataset.channel);
        if (player?.video) {
            player.video.volume = Number(event.target.value) / 100;
            if (player.video.volume > 0) player.video.muted = false;
            players.captureAudio(player);
        }
    }
    function toggleMute(player) {
        player.video.muted = !(player.video.muted || player.video.volume === 0);
        if (!player.video.muted && player.video.volume === 0) player.video.volume = 0.3;
        players.captureAudio(player);
    }
    function onContextMenu(event) {
        if (settingsPanel.cancelPointer() || layout.cancelGesture()) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if (!(event.target instanceof Element)) return;
        const cell = event.target.closest(".bcmv-cell[data-bcmv-channel]");
        const player = cell && players.get(cell.dataset.bcmvChannel);
        if (!player || player.main || !players.current(player) || !overlay?.contains(cell)) return;
        if (!player.video || !cell.contains(player.video)) return;
        event.preventDefault();
        event.stopPropagation();
        toggleMute(player);
    }
    function releaseHost() {
        hideAddDropHint();
        if (incomingDrag) incomingDrag = { invalid: true };
        removeChatButton();
        settingsPanel.release();
        window.removeEventListener("contextmenu", onContextMenu, true);
        modeObserver?.disconnect();
        modeObserver = null;
        sizeObserver?.disconnect();
        sizeObserver = null;
        layout.release();
        overlay?.removeEventListener("keydown", onOverlayKey);
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
        players.clear(clearMediaGuard);
        releaseHost();
        settingsPanel.clear();
    }
    function alignRoute() {
        if (!routeId) return;
        const index = state.channels.findIndex((entry) => entry.id === routeId);
        if (index > 0) {
            const previous = state.channels[0].id;
            players.transferSlotAudio([
                [previous, routeId],
                [routeId, previous],
            ]);
            state.dockTree = model.mapTree(state.dockTree, (id) =>
                id === previous ? routeId : id === routeId ? previous : id
            );
            state.freeWindows = state.freeWindows.map((cell) => ({
                ...cell,
                id: cell.id === previous ? routeId : cell.id === routeId ? previous : cell.id,
            }));
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
        chatButton.setAttribute("aria-expanded", String(Boolean(settingsPanel.id)));
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
                if (state.active && state.channels.length === 1) settingsPanel.show("add", true);
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
            if (typeof ResizeObserver === "function") {
                sizeObserver = new ResizeObserver(() => {
                    if (!state.active || layout.viewportActive) return;
                    layout.cancelResize();
                    layout.cancelDrag();
                    layout.position();
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
                players.reconcile(routeId, native);
                render();
            }
        }
        syncLauncher();
        syncChatButton();
        if (state.active) players.syncNative(native);
        settingsPanel.setContext({ host, routeId, chatButton, chatHeader, launcher });
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
        const restorePanel = settingsPanel.routeNavigation(next);
        players.prepareRoute();
        teardown(!next);
        routeId = next;
        settingsPanel.restoreNavigation(restorePanel);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        mount();
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
            window.removeEventListener("dragstart", trackIncomingDrag, true);
            window.removeEventListener("dragend", clearIncomingDrag, true);
            window.removeEventListener("dragenter", onAddDragOver, true);
            window.removeEventListener("dragover", onAddDragOver, true);
            window.removeEventListener("dragleave", onAddDragLeave, true);
            window.removeEventListener("drop", onAddDrop, true);
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
        window.addEventListener("dragstart", trackIncomingDrag, true);
        window.addEventListener("dragend", clearIncomingDrag, true);
        window.addEventListener("dragenter", onAddDragOver, true);
        window.addEventListener("dragover", onAddDragOver, true);
        window.addEventListener("dragleave", onAddDragLeave, true);
        window.addEventListener("drop", onAddDrop, true);
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
