/**
 * features/followingFolders.js — 팔로잉 목록의 폴더 묶음과 사이드바 안 폴더 조작, 목록 최대 표시 행 수를 적용한다.
 *
 * 동작 위치: isolated world, chzzk.naver.com 전역의 #sidebar 팔로잉 목록.
 * 하는 일: 저장된 폴더마다 확장 소유 머리 행을 목록에 붙이고, 원본 행은 옮기거나 복제하지 않은 채
 *   CSS order 속성으로만 폴더별로 묶는다. 폴더 안 순서는 고정 기능의 data-bcsf-order-group(고정→방송
 *   중→고정 오프라인→오프라인)을 읽기만 해서 따른다. 별도 관리 패널·새 폴더 버튼 없이 사이드바에서 바로 조작한다.
 *   - 만들기: 채널을 끌어 끄는 동안만 보이는 새 폴더 자리에 놓거나, 폴더의 ⋯ 메뉴에서 만든다.
 *   - 접기: 화살표는 바로, 이름 한 번 클릭은 더블클릭과 구분하려고 잠시 기다린 뒤 접는다.
 *   - 이름 변경: 이름 더블클릭·F2·⋯ 메뉴에서 그 자리 입력칸으로 바꾼다.
 *   - 폴더 정보를 읽지 못했거나 손상됐으면 팔로잉 목록 맨 위의 안내 줄에서 다시 읽거나 초기화한다.
 *   - 채널 이동: 팔로잉 채널을 끌어 폴더 머리 행·폴더 채널 위(폴더로), 폴더 밖 채널(빼기), 끄는 동안만 보이는
 *     새 폴더 자리(만들기)에 놓는다. 사이드바 밖에서는 아무것도 막지 않아 기존 링크 드래그가 그대로 동작한다.
 *   - 폴더 순서: 폴더 이름을 끌어 바꾸거나 ⋯ 메뉴로 한 칸씩 옮긴다.
 *   - 키보드 경로: ⋯ 메뉴(이름 변경·채널 선택·순서·삭제)와 채널 선택 창(체크로 넣기·빼기).
 *   - 되돌리기: 바뀐 직후 잠깐 보이는 안내에서 직전 상태로 되돌린다.
 *   followingListMaxRows가 있으면 목록 안 스크롤로 표시 높이만 제한한다.
 * 저장 경계: chrome.storage.sync `betterchzzk:following-folders:v1`은 직접 읽고 변경을 구독만 한다. 쓰기는
 *   신뢰된 사용자 클릭·키·드롭에서 만든 개별 명령을 마지막으로 확인한 원본값에 적용해
 *   BetterChzzk.utils.settingsStoreSet("sync", …, 기대값)으로만 요청한다. 워커가 conflict로 거절하면 받은 최신
 *   값에 같은 명령을 제한된 횟수만 다시 적용하고(되돌리기는 다시 적용하지 않는다), 저장 성공이나
 *   storage.onChanged로 확인한 값만 화면에 반영한다.
 * 의존: BetterChzzkFollowingFolders, BetterChzzkSettings.normalizeOptions, BetterChzzk.utils(bindFeatureOptions,
 *   createMutationObserverSync, ensureUiTheme(선택), injectStyleOnce, normSpace, normalizeChzzkChannelId,
 *   normalizeChzzkImageUrl, settingsStoreSet, startPageChangeDetection, startStorageChangeListener, storageGet),
 *   BetterChzzk.selectors(CHZZK, queryChain).
 * 옵션 키: followingFoldersEnabled, followingListMaxRows.
 * DOM 마커: #betterchzzk-following-folders-*, data-bcff-* 속성.
 */
(() => {
    const {
        STORAGE_KEY,
        MAX_FOLDERS,
        MAX_NAME_LENGTH,
        MAX_ASSIGNMENTS,
        EMPTY_STATE,
        applyCommand,
        cloneState,
        createFolderId,
        fromExpected,
        isValidChannelId,
        normalizeFolderName,
        parseStoredValue,
        statesEqual,
        toExpected,
    } = globalThis.BetterChzzkFollowingFolders;
    const { normalizeOptions } = BetterChzzkSettings;
    const { CHZZK, queryChain } = BetterChzzk.selectors;
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        injectStyleOnce,
        normSpace,
        normalizeChzzkChannelId,
        normalizeChzzkImageUrl,
        startPageChangeDetection,
        startStorageChangeListener,
        storageGet,
    } = BetterChzzk.utils;

    const STYLE_ID = "betterchzzk-following-folders-style";
    const ROWS_STYLE_ID = "betterchzzk-following-folders-rows-style";
    // 2026-10-11까지 쓰던 새 폴더 버튼의 표식이에요. 재주입 전 문서에 남은 버튼만 지워요.
    const LEGACY_MANAGE_ATTR = "data-bcff-manage-button";
    const STATUS_ATTR = "data-bcff-status";
    const LAYER_ID = "betterchzzk-following-folders-layer";
    const DRAG_CARD_ID = "betterchzzk-following-folders-drag-card";
    const TOAST_ID = "betterchzzk-following-folders-toast";
    const LIST_ATTR = "data-bcff-list";
    const ORDER_ATTR = "data-bcff-order";
    const HIDDEN_ATTR = "data-bcff-hidden";
    const CHANNEL_ATTR = "data-bcff-channel-id";
    const HEADER_ATTR = "data-bcff-header";
    const COMPACT_ATTR = "data-bcff-compact";
    const DRAGGING_ATTR = "data-bcff-dragging";
    const DROP_ATTR = "data-bcff-drop-target";
    const HINT_ATTR = "data-bcff-drop-hint";
    const SOURCE_ATTR = "data-bcff-drag-source";
    const NEW_ZONE_ATTR = "data-bcff-new-zone";
    const MAX_ROWS_ATTR = "data-bcff-max-rows";
    const KEY_ATTR = "data-bcff-key";
    const PIN_GROUP_ATTR = "data-bcsf-order-group";
    // 고정 기능이 접힌 목록에 덧붙인 확장 행이에요. 원본 행 수를 셀 때만 빼요.
    const PIN_SOURCE_ROW_ATTR = "data-bcsf-source-row";
    const PIN_MODE_BUTTON_ATTR = "data-bcsf-pin-mode-button";
    // 폴더 순서 끌기에만 쓰는 확장 전용 형식이에요. 링크가 없어 사이드바 밖 대상은 받지 않아요.
    const FOLDER_DRAG_TYPE = "application/x-betterchzzk-following-folder";
    // 폴더 구역마다 머리 행 1칸과 고정 순위 4칸을 둔다. 폴더 밖 채널은 항상 마지막 구역이다.
    const SECTION_SLOTS = 5;
    const REST_SECTION = MAX_FOLDERS;
    const MAX_ORDER = (REST_SECTION + 1) * SECTION_SLOTS - 1;
    const PIN_RANKS = new Map([
        ["pinned", 0],
        ["live", 1],
        ["offline-pinned", 2],
        ["offline", 3],
    ]);
    const REST_KEY = "";
    const REST_DROP = "rest";
    const NEW_DROP = "new";
    const COMPACT_WIDTH = 160;
    // 실제 행 높이를 아직 재지 못했을 때만 쓰는 임시 높이다. 행이 보이면 측정값으로 바꾼다.
    const FALLBACK_ROW_HEIGHT = 48;
    // 이름 한 번 클릭과 더블클릭(이름 변경)을 구분하는 대기 시간이에요. 화살표·키보드는 기다리지 않아요.
    const CLICK_TOGGLE_DELAY_MS = 250;
    // 끄는 채널을 접힌 폴더 위에 이만큼 들고 있으면 저장하지 않고 잠깐 펼쳐 보여 줘요.
    const SPRING_OPEN_MS = 500;
    // 2026-10-11 사용자 보고: 미리보기가 행을 옮기면 가만히 있는 커서 밑 대상이 바뀌어 앞뒤로 흔들렸고, 빠르게
    // 지나가기만 해도 폴더마다 미리보기가 번쩍였어요. 새 대상 위에 잠깐 머물러야 바꾸고, 바꾼 직후 행이 비켜나는
    // 동안과 커서가 거의 움직이지 않은 동안에는 다음 대상으로 넘어가지 않아요.
    const PREVIEW_DWELL_MS = 120;
    const PREVIEW_SETTLE_MS = 180;
    const PREVIEW_MOVE_PX = 8;
    const LAYOUT_ANIMATION_MS = 160;
    const DELETE_CONFIRM_MS = 5000;
    const TOAST_MS = 5000;
    const MAX_KNOWN_CHANNELS = 600;
    // 최신 값으로 같은 명령을 다시 적용하는 횟수를 포함한 전체 저장 시도 상한이다. 무한 재시도하지 않는다.
    const MAX_WRITE_ATTEMPTS = 3;
    const MENU_WIDTH = 208;
    const PICKER_WIDTH = 300;
    const DEFAULT_FOLDER_NAME = "새 폴더";
    const REFRESH_BUTTON_SELECTOR = 'button[aria-label], [role="button"][aria-label]';
    const REFRESH_LABEL_RE = /새로고침|refresh/i;
    const FOLLOWING_SECTION_SELECTOR = 'nav[aria-label="팔로우"]';
    // 2026-09-11 실측한 원본 목록 버튼이에요. 남은 채널이 있으면 `더보기`·aria-expanded="false"예요.
    const NATIVE_LIST_LABELS = new Set(["더보기", "접기"]);
    // 원본 `더보기`는 5개에서 50개씩 505개까지 늘어 끝까지 10번이에요. 첫 `더보기`가 부른 새로고침이 중간에
    // 55개로 자르면 다시 9번까지 더 눌러요. 그보다 많이 눌러도 행이 계속 바뀌면 치지직 동작이 달라진 것으로 보고
    // 잠시 멈춰요.
    const NATIVE_EXPAND_LIMIT = 25;
    const NATIVE_EXPAND_WINDOW_MS = 5000;
    const FOLLOWING_HREF_RE = /^\/following\/?$/i;
    const FOLLOWING_TEXT_RE = /팔로(잉|우)|following|follow/i;
    const RESERVED_ROOT_PATHS = new Set([
        "category",
        "cheezefarm",
        "clips",
        "following",
        "lives",
        "partner",
        "schedule",
        "search",
        "studio",
        "video",
    ]);
    const svg = (viewBox, body, extra = "") =>
        `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;
    const ICONS = Object.freeze({
        newFolder: svg(
            "0 0 24 24",
            '<path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/><path d="M12 10v6M9 13h6" stroke-linecap="round"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"'
        ),
        chevron: svg(
            "0 0 16 16",
            '<path d="M4 6l4 4 4-4"/>',
            ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
        ),
        more: svg(
            "0 0 16 16",
            '<circle cx="3.5" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="12.5" cy="8" r="1.4"/>',
            ' fill="currentColor"'
        ),
        pen: svg(
            "0 0 16 16",
            '<path d="M3 13l.6-2.6L10.8 3.2a1.4 1.4 0 0 1 2 2L5.6 12.4 3 13Z"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"'
        ),
        list: svg(
            "0 0 16 16",
            '<path d="M6 4h7M6 8h7M6 12h7"/><path d="m2.5 4 .8.8L4.8 3.3M2.5 8l.8.8 1.5-1.5M2.5 12l.8.8 1.5-1.5"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"'
        ),
        up: svg(
            "0 0 16 16",
            '<path d="M8 13V3M4 7l4-4 4 4"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
        ),
        down: svg(
            "0 0 16 16",
            '<path d="M8 3v10M4 9l4 4 4-4"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
        ),
        trash: svg(
            "0 0 16 16",
            '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"'
        ),
        search: svg(
            "0 0 16 16",
            '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14" stroke-linecap="round"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.6"'
        ),
        check: svg(
            "0 0 12 12",
            '<path d="m2.5 6.2 2.3 2.3 4.7-5"/>',
            ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
        ),
        close: svg(
            "0 0 16 16",
            '<path d="M4 4l8 8M12 4l-8 8"/>',
            ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"'
        ),
    });
    const ERROR_MESSAGES = {
        "invalid-name": `폴더 이름은 앞뒤 공백을 뺀 1~${MAX_NAME_LENGTH}자로 입력해 주세요.`,
        "duplicate-name": "같은 이름의 폴더가 이미 있어요.",
        "folder-limit": `폴더는 최대 ${MAX_FOLDERS}개까지 만들 수 있어요.`,
        "assignment-limit": `폴더에 넣을 수 있는 채널은 모두 합쳐 ${MAX_ASSIGNMENTS}개까지예요.`,
        "folder-not-found": "다른 곳에서 폴더가 바뀌어 적용하지 않았어요. 최신 폴더를 표시했어요.",
        conflict: "다른 곳에서 폴더가 바뀌어 적용하지 않았어요. 최신 폴더를 표시했어요.",
        "invalid-channel-id": "이 채널은 폴더에 넣을 수 없어요.",
        "too-large": "저장 공간 한도를 넘어 저장하지 않았어요.",
        "corrupt-state": "저장된 폴더 정보를 읽을 수 없어 변경하지 않았어요.",
        "not-corrupt": "폴더 정보가 이미 정상이라 초기화하지 않았어요.",
        "write-conflict":
            "다른 탭이나 설정 불러오기에서 폴더가 계속 바뀌어 저장하지 않았어요. 최신 폴더를 확인한 뒤 다시 시도해 주세요.",
        "undo-conflict": "그사이 다른 곳에서 폴더가 바뀌어 되돌리지 않았어요.",
        unavailable: "확장 프로그램과 연결되지 않아 저장하지 못했어요. 페이지를 새로고침한 뒤 다시 시도해 주세요.",
        "not-ready": "폴더 정보를 아직 확인하지 못해 변경하지 않았어요.",
    };
    const RENAME_ERRORS = new Set(["invalid-name", "duplicate-name"]);
    const SAVE_FAILED_MESSAGE = "폴더 변경을 저장하지 못했어요. 이전 상태를 그대로 유지했어요.";
    const ORDER_RULES = Array.from(
        { length: MAX_ORDER + 1 },
        (_, order) => `#sidebar [${LIST_ATTR}="1"]>[${ORDER_ATTR}="${order}"]{order:${order}!important}`
    ).join("\n");
    // 색·모서리·팝오버 그림자·번들 Pretendard는 shared/uiTheme.js의 공통 변수(--bct-*)를 써요.
    // 머리 행·안내 줄·새 폴더 자리는 치지직 원본 행 사이에 있어 원본 글꼴을 그대로 따르고,
    // ⋯ 메뉴·채널 선택 창·되돌리기 안내·드래그 카드는 확장 팝오버라 --bct-font를 써요.
    // 작은 글자는 두 테마 모두 4.5:1 이상인 MUTED·BRAND를 쓰고, FAINT는 아이콘·비활성에만 써요.
    const BRAND = "var(--bct-brand-text)";
    const BRAND_FILL = "var(--bct-brand)";
    const BRAND_SOFT = "var(--bct-brand-weak)";
    // 치지직 border-brand-alpha-base(브랜드 30%)에 맞는 공통 변수가 없어 브랜드 글자색을 섞어요.
    const BRAND_LINE = "color-mix(in srgb,var(--bct-brand-text) 30%,transparent)";
    const FOCUS = "var(--bct-focus-ring)";
    const ON_BRAND = "var(--bct-on-brand)";
    const TEXT = "var(--bct-text)";
    const STRONG = "var(--bct-text-body)";
    const MUTED = "var(--bct-text-muted)";
    const FAINT = "var(--bct-text-dim)";
    const SURFACE = "var(--bct-surface)";
    const FIELD = "var(--bct-surface-weak)";
    const BACKGROUND = "var(--bct-bg)";
    const LINE = "var(--bct-border-alpha-weaker)";
    const LINE_STRONG = "var(--bct-border-alpha)";
    const HOVER = "var(--bct-hover)";
    const SHADOW = "var(--bct-shadow)";
    const DANGER = "var(--bct-danger)";
    const RADIUS_SM = "var(--bct-radius-sm)";
    const RADIUS_MD = "var(--bct-radius-md)";
    const RADIUS_LG = "var(--bct-radius-lg)";
    const RADIUS_FULL = "var(--bct-radius-full)";
    // 라이브 점은 테마와 무관한 고정 색이에요.
    const LIVE = "#ff4545";
    const STYLE_TEXT = `
#sidebar [${LIST_ATTR}="1"]{display:flex!important;flex-direction:column!important;align-items:stretch!important}
#sidebar [${LIST_ATTR}="1"]>:not([${ORDER_ATTR}]){order:${MAX_ORDER + 1}!important}
${ORDER_RULES}
#sidebar [${LIST_ATTR}="1"]>[${HIDDEN_ATTR}="1"]{display:none!important}
#sidebar [${MAX_ROWS_ATTR}="1"]{overflow-y:auto!important;scrollbar-width:thin}
#sidebar [${MAX_ROWS_ATTR}="1"]>*{flex-shrink:0!important}
#sidebar [${HEADER_ATTR}]{position:relative;display:flex;align-items:center;box-sizing:border-box;margin:0;padding:0;list-style:none;border-radius:${RADIUS_MD}}
#sidebar [${HEADER_ATTR}="folder"]{min-height:32px;margin-top:6px;padding:0 4px 0 2px;color:${STRONG};cursor:pointer}
#sidebar [${HEADER_ATTR}="folder"]:hover{background:${HOVER}}
#sidebar [${HEADER_ATTR}] button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;margin:0;padding:0;border:0;border-radius:${RADIUS_SM};background:transparent;color:inherit;font:inherit;cursor:pointer}
#sidebar [${HEADER_ATTR}] button:focus-visible,#sidebar [${HEADER_ATTR}] input:focus-visible{outline:2px solid ${FOCUS};outline-offset:-2px}
#sidebar [${HEADER_ATTR}] .bcff-toggle,#sidebar [${HEADER_ATTR}] .bcff-more{flex:none;width:24px;height:24px;color:${FAINT}}
#sidebar [${HEADER_ATTR}] .bcff-toggle:hover,#sidebar [${HEADER_ATTR}] .bcff-more:hover{color:${TEXT};background:${HOVER}}
#sidebar [${HEADER_ATTR}] svg{width:16px;height:16px;pointer-events:none}
#sidebar [${HEADER_ATTR}] .bcff-toggle svg{width:12px;height:12px;transition:transform .15s}
#sidebar [${HEADER_ATTR}] .bcff-toggle[aria-expanded="false"] svg{transform:rotate(-90deg)}
#sidebar [${HEADER_ATTR}] .bcff-name{flex:0 1 auto;justify-content:flex-start;min-width:0;padding:3px 2px;font-size:13px;font-weight:700;line-height:18px;text-align:start;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#sidebar [${HEADER_ATTR}] .bcff-name[data-bcff-count]::after{content:attr(data-bcff-count);margin-left:6px;font-weight:500;font-size:12px;color:${MUTED};font-variant-numeric:tabular-nums}
#sidebar [${HEADER_ATTR}] .bcff-spacer{flex:1;min-width:4px}
#sidebar [${HEADER_ATTR}] .bcff-live{flex:none;margin-right:4px;font-size:12px;color:${STRONG};font-variant-numeric:tabular-nums}
#sidebar [${HEADER_ATTR}] .bcff-live::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:${LIVE};vertical-align:1px}
#sidebar [${HEADER_ATTR}] .bcff-live::after{content:attr(data-bcff-live)}
#sidebar [${HEADER_ATTR}] .bcff-more{opacity:0}
#sidebar [${HEADER_ATTR}]:hover .bcff-more,#sidebar [${HEADER_ATTR}]:focus-within .bcff-more,#sidebar [${HEADER_ATTR}] .bcff-more[aria-expanded="true"]{opacity:1}
#sidebar [${HEADER_ATTR}] .bcff-rename{flex:1;min-width:0;height:26px;margin:0 2px;padding:0 8px;box-sizing:border-box;border:1px solid ${BRAND};border-radius:${RADIUS_SM};background:${SURFACE};color:${TEXT};font:inherit;font-size:13px;font-weight:700;outline:none;cursor:text}
#sidebar [${HEADER_ATTR}] .bcff-rename[aria-invalid="true"]{border-color:${DANGER}}
#sidebar [${HEADER_ATTR}] .bcff-rename~:is(.bcff-spacer,.bcff-live){display:none}
#sidebar [${HEADER_ATTR}] .bcff-rename-hint{position:absolute;left:28px;top:100%;z-index:5;margin-top:2px;padding:4px 8px;border-radius:${RADIUS_SM};background:${SURFACE};box-shadow:${SHADOW},0 0 0 1px ${LINE};color:${MUTED};font-size:11px;line-height:16px;white-space:nowrap;pointer-events:none}
#sidebar [${HEADER_ATTR}] .bcff-rename-hint[data-error]{color:${DANGER}}
#sidebar [${HEADER_ATTR}="rest"]{min-height:28px;margin-top:10px;padding:0 10px;color:${MUTED};font-size:12px;font-weight:600;line-height:18px}
#sidebar [${HEADER_ATTR}="rest"] .bcff-header-name{display:block}
#sidebar [${LIST_ATTR}="1"][${COMPACT_ATTR}="1"] [${HEADER_ATTR}]{min-height:8px;margin-top:4px;padding:0;border-top:1px solid ${LINE_STRONG};border-radius:0}
#sidebar [${LIST_ATTR}="1"][${COMPACT_ATTR}="1"] [${HEADER_ATTR}]>:not(.bcff-toggle){display:none!important}
#sidebar [${LIST_ATTR}="1"][${COMPACT_ATTR}="1"] [${HEADER_ATTR}] .bcff-toggle{width:100%;height:20px}
#sidebar [${LIST_ATTR}][${DRAGGING_ATTR}] a:hover{background:transparent}
#sidebar [${LIST_ATTR}]>[${DROP_ATTR}]{background:${BRAND_SOFT}!important}
#sidebar [${LIST_ATTR}]>[${DROP_ATTR}]>a{border-radius:0}
#sidebar [${HEADER_ATTR}][${DROP_ATTR}]{box-shadow:inset 0 0 0 1px ${BRAND_LINE};color:${TEXT}}
#sidebar [${HEADER_ATTR}][${DROP_ATTR}]::after{content:attr(${HINT_ATTR});position:absolute;right:10px;font-size:12px;font-weight:700;color:${TEXT};pointer-events:none}
#sidebar [${HEADER_ATTR}][${DROP_ATTR}] :is(.bcff-more,.bcff-live){visibility:hidden}
#sidebar [${LIST_ATTR}]>[${SOURCE_ATTR}]{opacity:.55}
#sidebar [${LIST_ATTR}]>[${SOURCE_ATTR}][${DROP_ATTR}]{opacity:1;box-shadow:inset 3px 0 0 ${BRAND}}
#${DRAG_CARD_ID}{position:fixed;top:-1000px;left:-1000px;z-index:-1;display:flex;align-items:center;gap:10px;box-sizing:border-box;max-width:240px;padding:8px 16px 8px 8px;border:1px solid ${LINE_STRONG};border-radius:${RADIUS_FULL};background:${SURFACE};color:${TEXT};font-family:var(--bct-font);font-size:14px;font-weight:600;line-height:1.3;pointer-events:none}
#${DRAG_CARD_ID} .bcff-drag-avatar{display:grid;place-items:center;flex:none;width:32px;height:32px;overflow:hidden;border-radius:50%;background:${FIELD};color:${MUTED};font-size:13px;font-weight:700}
#${DRAG_CARD_ID} .bcff-drag-avatar img{display:block;width:100%;height:100%;object-fit:cover}
#${DRAG_CARD_ID} .bcff-drag-avatar svg{width:18px;height:18px}
#${DRAG_CARD_ID} .bcff-drag-text{display:flex;flex-direction:column;min-width:0}
#${DRAG_CARD_ID} .bcff-drag-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${DRAG_CARD_ID} .bcff-drag-detail{overflow:hidden;color:${MUTED};font-size:12px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
#${DRAG_CARD_ID} .bcff-drag-detail[data-live="1"]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:${LIVE};vertical-align:1px}
#sidebar [${NEW_ZONE_ATTR}]{position:sticky;bottom:12px;z-index:2;display:flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:44px;margin:8px 0 0;padding:0 10px;list-style:none;border:1px dashed ${LINE_STRONG};border-radius:${RADIUS_MD};background:${BACKGROUND};box-shadow:0 -12px 16px ${BACKGROUND};color:${MUTED};font-size:13px;font-weight:600}
#sidebar [${NEW_ZONE_ATTR}][${DROP_ATTR}]{border-color:${BRAND};color:${BRAND};background:color-mix(in srgb,${BRAND_FILL} 10%,${BACKGROUND})!important}
#sidebar [${STATUS_ATTR}]{display:flex;flex-direction:column;align-items:flex-start;gap:8px;box-sizing:border-box;margin:4px 0 6px;padding:10px 12px;list-style:none;border:1px dashed ${LINE_STRONG};border-radius:${RADIUS_MD};color:${MUTED};font-size:12px;line-height:1.5}
#sidebar [${STATUS_ATTR}] p{margin:0;overflow-wrap:anywhere}
#sidebar [${STATUS_ATTR}] button{min-height:28px;margin:0;padding:0 12px;border:0;border-radius:${RADIUS_SM};background:${FIELD};color:${TEXT};font:inherit;font-weight:600;cursor:pointer}
#sidebar [${STATUS_ATTR}] button:focus-visible{outline:2px solid ${FOCUS};outline-offset:2px}
#sidebar [${STATUS_ATTR}] button[data-armed]{color:${DANGER};background-color:transparent;box-shadow:inset 0 0 0 1px ${DANGER}}
#${LAYER_ID},#${TOAST_ID}{position:fixed;z-index:10020;box-sizing:border-box;border-radius:${RADIUS_LG};background-color:${SURFACE};box-shadow:${SHADOW},0 0 0 1px ${LINE};color:${TEXT};font-family:var(--bct-font);font-size:13px;line-height:1.5;text-align:start}
#${LAYER_ID} *,#${TOAST_ID} *{box-sizing:border-box}
#${LAYER_ID} :is(h2,h3,p,ul,ol){margin:0;padding:0}
#${LAYER_ID} button{display:flex;align-items:center;gap:10px;margin:0;border:0;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer}
#${LAYER_ID} button:disabled{color:${FAINT};cursor:default}
#${LAYER_ID} :is(button,input):focus-visible{outline:2px solid ${FOCUS};outline-offset:-2px}
#${LAYER_ID} svg{flex:none;width:16px;height:16px;color:${MUTED};pointer-events:none}
#${LAYER_ID}[data-kind="menu"]{padding:6px}
#${LAYER_ID} .bcff-item{width:100%;min-height:36px;padding:0 10px;border-radius:${RADIUS_MD};font-size:13px}
#${LAYER_ID} .bcff-item:hover:not(:disabled){background:${HOVER}}
#${LAYER_ID} .bcff-item kbd{margin-left:auto;font:inherit;font-size:11px;line-height:1;color:${MUTED}}
#${LAYER_ID} .bcff-separator{height:1px;margin:6px 4px;background:${LINE}}
#${LAYER_ID} .bcff-danger,#${LAYER_ID} .bcff-danger svg{color:${DANGER}}
#${LAYER_ID} .bcff-danger[data-armed]{background-color:transparent;box-shadow:inset 0 0 0 1px ${DANGER}}
#${LAYER_ID} .bcff-state-text{padding:8px 10px;color:${MUTED};font-size:12px;overflow-wrap:anywhere}
#${LAYER_ID}[data-kind="picker"]{display:flex;flex-direction:column}
#${LAYER_ID} .bcff-picker-top{display:flex;align-items:center;gap:8px;padding:14px 10px 10px 16px}
#${LAYER_ID} .bcff-picker-top h2{flex:1;min-width:0;font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${LAYER_ID} .bcff-icon-button{justify-content:center;width:28px;height:28px;padding:0;border-radius:${RADIUS_SM}}
#${LAYER_ID} .bcff-icon-button:hover{background:${HOVER}}
#${LAYER_ID} .bcff-search{position:relative;display:block;margin:0 12px 8px}
#${LAYER_ID} .bcff-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:${FAINT}}
#${LAYER_ID} .bcff-search input{width:100%;height:36px;margin:0;padding:0 10px 0 34px;border:1px solid transparent;border-radius:${RADIUS_MD};background:${FIELD};color:${TEXT};font:inherit;font-size:13px;outline:none}
#${LAYER_ID} .bcff-search input:focus{border-color:${BRAND}}
#${LAYER_ID} .bcff-search input::placeholder{color:${MUTED}}
#${LAYER_ID} .bcff-picks{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 6px 6px;list-style:none;scrollbar-width:thin}
#${LAYER_ID} .bcff-pick{width:100%;min-height:48px;padding:6px 10px;border-radius:${RADIUS_MD}}
#${LAYER_ID} .bcff-pick:hover{background:${HOVER}}
#${LAYER_ID} .bcff-avatar{display:grid;place-items:center;flex:none;width:32px;height:32px;overflow:hidden;border-radius:50%;background:${FIELD};color:${MUTED};font-size:13px;font-weight:700}
#${LAYER_ID} .bcff-avatar img{display:block;width:100%;height:100%;object-fit:cover}
#${LAYER_ID} .bcff-pick:not([data-live="1"]) .bcff-avatar{opacity:.55}
#${LAYER_ID} .bcff-pick-info{display:flex;flex:1;flex-direction:column;min-width:0}
#${LAYER_ID} .bcff-pick-name{overflow:hidden;font-size:14px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
#${LAYER_ID} .bcff-pick-detail{overflow:hidden;color:${MUTED};font-size:12px;text-overflow:ellipsis;white-space:nowrap}
#${LAYER_ID} .bcff-pick-detail[data-live="1"]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:${LIVE};vertical-align:1px}
#${LAYER_ID} .bcff-check{display:grid;place-items:center;flex:none;width:20px;height:20px;border:1.5px solid ${LINE_STRONG};border-radius:${RADIUS_SM}}
#${LAYER_ID} .bcff-check svg{width:12px;height:12px;opacity:0;color:${ON_BRAND}}
#${LAYER_ID} .bcff-pick[aria-pressed="true"] .bcff-check{border-color:${BRAND_FILL};background:${BRAND_FILL}}
#${LAYER_ID} .bcff-pick[aria-pressed="true"] .bcff-check svg{opacity:1}
#${LAYER_ID} .bcff-picker-empty{padding:12px 10px;color:${MUTED};font-size:12px}
#${LAYER_ID} .bcff-picker-foot{padding:10px 12px 12px;border-top:1px solid ${LINE};color:${MUTED};font-size:12px}
#${TOAST_ID}{display:flex;align-items:center;gap:12px;min-width:240px;max-width:min(380px,calc(100vw - 16px));padding:10px 10px 10px 16px;overflow:hidden}
#${TOAST_ID} .bcff-toast-text{flex:1;min-width:0;overflow-wrap:anywhere}
#${TOAST_ID}[data-kind="error"] .bcff-toast-text{color:${DANGER}}
#${TOAST_ID} button{flex:none;margin:0;padding:6px 8px;border:0;border-radius:${RADIUS_SM};background:transparent;color:${BRAND};font:inherit;font-weight:700;cursor:pointer}
#${TOAST_ID} button:hover{background:${HOVER}}
#${TOAST_ID} button:focus-visible{outline:2px solid ${FOCUS};outline-offset:-2px}
#${TOAST_ID} .bcff-toast-bar{position:absolute;left:0;bottom:0;height:2px;width:100%;background:${BRAND};transform-origin:left center;animation:bcff-toast ${TOAST_MS}ms linear forwards}
#${TOAST_ID}:is(:hover,:focus-within) .bcff-toast-bar{animation-play-state:paused}
@keyframes bcff-toast{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media(prefers-reduced-motion:reduce){#sidebar [${HEADER_ATTR}] .bcff-toggle svg{transition:none}#${TOAST_ID} .bcff-toast-bar{animation:none}}
#${LAYER_ID} .bcff-visually-hidden,#${TOAST_ID} .bcff-visually-hidden{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;

    const storageArea = () => globalThis.chrome?.storage?.sync;
    // 저장 어댑터: 읽기·구독은 sync를 직접 사용하고, 쓰기는 공용 설정 저장 경계(워커 잠금 안 기대값 비교)만
    // 사용한다. 직접 sync.set으로 대체하지 않으며, 쓰기 함수가 없으면 unavailable로 실패한다.
    const folderStore = {
        read() {
            return storageGet(storageArea(), STORAGE_KEY).then((data) => data?.[STORAGE_KEY]);
        },
        subscribe(listener) {
            return startStorageChangeListener((changes, areaName) => {
                if (areaName !== "sync" || !Object.hasOwn(changes || {}, STORAGE_KEY)) return;
                listener(changes[STORAGE_KEY]?.newValue);
            });
        },
        write(state, expectedRawValue) {
            const settingsStoreSet = BetterChzzk.utils.settingsStoreSet;
            if (typeof settingsStoreSet !== "function") {
                return Promise.reject(Object.assign(new Error("settings store unavailable"), { code: "unavailable" }));
            }
            return settingsStoreSet("sync", { [STORAGE_KEY]: state }, { [STORAGE_KEY]: toExpected(expectedRawValue) });
        },
    };

    let featureOptions = normalizeOptions();
    let runtimeInstalled = false;
    let foldersActive = false;
    let foldersGeneration = 0;
    let stateStatus = "idle";
    // 상태는 세 겹이에요. 저장으로 확인한 상태(confirmedState) 위에 저장을 기다리는 내 변경을 얹은 것이
    // 판단에 쓰는 folderState이고, 그 위에 끄는 중 미리보기·접힌 폴더 잠깐 펼침을 얹은 것이 화면용 viewState예요.
    // 쓰기는 언제나 lastRawValue(확인한 원본)를 기대값으로 보내므로 화면에 먼저 보인 변경이 저장값을 앞지르지 않아요.
    let confirmedState = cloneState(EMPTY_STATE);
    let folderState = cloneState(EMPTY_STATE);
    let viewState = cloneState(EMPTY_STATE);
    // 마지막으로 확인한 저장 원본값이다. 쓰기의 기대값으로 그대로 보내므로 수정하지 않는다.
    let lastRawValue;
    let changeEpoch = 0;
    let folderOfChannel = new Map();
    let folderPosition = new Map();
    let viewFolderOf = new Map();
    let viewPosition = new Map();
    let viewCollapsed = new Set();
    // 저장 응답을 기다리는 동안 화면에 먼저 반영한 명령이에요. 실패하면 빼고 다시 그려 되돌려요.
    let optimistic = [];
    // 끄는 중에만 쓰는 미리보기 명령과 잠깐 펼친 접힌 폴더예요. 저장하지 않아요.
    let preview = null;
    let springFolderId = "";
    let springTimer = 0;
    let animateNextSync = false;
    let dragCard = null;
    // 끄는 중 대상 전환의 머무름·안정 판단: { candidate, since, switchedAt, switchedY }
    let dragMotion = null;
    let currentList = null;
    let currentSection = null;
    let presentationActive = false;
    let observer = null;
    let removeRouteListener = null;
    let removeStorageListener = null;
    let frame = 0;
    let commandChain = Promise.resolve();
    let pendingCommands = 0;
    // 저장을 기다리는 동안 원본 목록에 붙인 aria-busy와 붙이기 전 값이에요. 끝나거나 기능을 끄거나 목록이
    // 바뀌면 붙이기 전 값으로 돌려요.
    let busyList = null;
    let busyOriginal = null;
    // 채널 끌기: 신뢰된 dragstart가 현재 팔로잉 목록의 채널 링크에서 시작한 경우만 기억한다.
    let activeDrag = null;
    // 폴더 순서 끌기: 머리 행 이름에서 시작한 확장 전용 끌기다.
    let folderDrag = null;
    let dropKey = null;
    let dropNodes = [];
    let newZone = null;
    let measuredRowHeight = 0;
    let statusRow = null;
    let statusArmed = false;
    let statusArmTimer = 0;
    // 그 자리 이름 변경: { folderId, draft, error, pending, select }
    let renaming = null;
    // 떠 있는 메뉴·채널 선택·상태 안내 하나: { kind, folderId, node, anchor, ... }
    let layer = null;
    let clickTimer = 0;
    let toast = null;
    let toastTimer = 0;
    // 직전 변경의 되돌리기 정보: { previous(원본값), next(바뀐 상태) }
    let undo = null;
    // 접힌 폴더 머리 행의 방송 중 수에 쓰는, 지금 목록에서 방송 중인 채널 ID예요.
    let liveChannelIds = new Set();
    // 원본 목록이 아직 다 그려지지 않았을 때 그려진 채널 ID예요. 그 밖의 폴더 채널은 방송 상태를 모르는 채널이에요.
    // 목록이 끝까지 그려졌으면 null이에요.
    let partialChannelIds = null;
    // 사용자가 원본 목록을 직접 접으면 다음에 폴더를 펼칠 때까지 대신 펼치지 않아요.
    let nativeExpandHeld = false;
    // 대신 누른 `더보기`의 응답 대기: { button, rows }. 원본 행 수가 바뀌기 전에는 다시 누르지 않아요.
    let nativeExpandPending = null;
    let nativeExpandClicks = [];
    // 목록을 끝까지 펼쳐도 없던 폴더 채널(팔로우 해제·505개 밖)이에요. 다시 펼칠 이유로 삼지 않아요.
    let unreachableChannelIds = new Set();
    const headerOwners = new WeakMap();
    const rowIdentity = new WeakMap();
    const knownChannels = new Map();

    function setAttr(node, name, value) {
        if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }

    function removeAttr(node, name) {
        if (node.hasAttribute(name)) node.removeAttribute(name);
    }

    function el(tag, className = "", text = "") {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }

    function getSidebar() {
        const sidebar = document.getElementById("sidebar");
        return sidebar instanceof HTMLElement ? sidebar : null;
    }

    function parseChannelHref(href) {
        try {
            const url = new URL(href, location.origin);
            if (url.origin !== location.origin) return null;
            const segments = url.pathname
                .split("/")
                .filter(Boolean)
                .map((segment) => decodeURIComponent(segment));
            if (segments.length === 2 && segments[0].toLowerCase() === "live") {
                const channelId = normalizeChzzkChannelId(segments[1]);
                return channelId ? { channelId, isLive: true } : null;
            }
            if (segments.length !== 1 || RESERVED_ROOT_PATHS.has(segments[0].toLowerCase())) return null;
            const channelId = normalizeChzzkChannelId(segments[0]);
            return channelId ? { channelId, isLive: false } : null;
        } catch (_) {
            return null;
        }
    }

    function isExtensionRow(row) {
        return headerOwners.has(row) || row === newZone || row === statusRow;
    }

    // 행 정체성은 현재 링크의 href로만 판단한다. 캐시는 같은 링크·같은 href일 때만 재사용한다.
    function getRowInfo(row) {
        if (!(row instanceof HTMLElement) || isExtensionRow(row)) return null;
        const cached = rowIdentity.get(row);
        if (
            cached &&
            cached.link.isConnected &&
            row.contains(cached.link) &&
            cached.link.getAttribute("href") === cached.href
        ) {
            return cached;
        }
        let chosen = null;
        for (const link of row.querySelectorAll("a[href]")) {
            const meta = parseChannelHref(link.getAttribute("href") || "");
            if (!meta) continue;
            if (!chosen || (meta.isLive && !chosen.meta.isLive)) chosen = { link, meta };
            if (meta.isLive) break;
        }
        if (!chosen) {
            rowIdentity.delete(row);
            return null;
        }
        const info = {
            link: chosen.link,
            href: chosen.link.getAttribute("href"),
            channelId: chosen.meta.channelId,
            isLive: chosen.meta.isLive,
        };
        rowIdentity.set(row, info);
        return info;
    }

    // 2026-10-09 Codex 실측: 이름 노드에는 인증 마크·업적 배지의 숨김 설명이 함께 있어 textContent가
    // "한동숙인증 마크"가 됐어요. 고정 기능 보충 행(findSourceNameTextNode)·미리보기의 읽기 기준처럼
    // 배지·숨김 설명·툴팁·아이콘과 확장 표식을 빼고 실제 이름 글자만 읽어요.
    const NAME_SKIP_SELECTOR = [
        ".blind",
        "[class*='blind']",
        "[class*='sr-only']",
        "[class*='badge']",
        "[class*='verified']",
        "[class*='icon']",
        "[class*='tooltip']",
        "[aria-hidden='true']",
        "[hidden]",
        "[role='img']",
        "[role='tooltip']",
        "img",
        "svg",
        "[data-bcsf-pin-indicator]",
        "[data-bcsf-channel-badge]",
    ].join(", ");

    function readNameText(node, chunks) {
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) chunks.push(child.nodeValue || "");
            else if (child instanceof Element && !child.matches(NAME_SKIP_SELECTOR)) readNameText(child, chunks);
        }
        return chunks;
    }

    function getRowName(row, info) {
        const nameNode = queryChain(row, CHZZK.channelName);
        const name = nameNode instanceof Element ? normSpace(readNameText(nameNode, []).join("")) : "";
        const label = normSpace(info.link.getAttribute("aria-label") || "").replace(/\s+(?:LIVE|오프라인)$/, "");
        return (name || label || info.channelId).slice(0, 60);
    }

    // 채널 선택 창의 아바타는 원본 행의 프로필 이미지 주소를 신뢰된 치지직 이미지 호스트일 때만 다시 써요.
    function getRowImage(row) {
        for (const image of row.querySelectorAll("img[src]")) {
            const url = normalizeChzzkImageUrl?.(image.getAttribute("src") || "");
            if (url) return url;
        }
        return "";
    }

    function hasFollowingLink(root) {
        return Array.from(root.querySelectorAll("a[href]")).some((anchor) => {
            try {
                const url = new URL(anchor.getAttribute("href") || "", location.origin);
                return url.origin === location.origin && FOLLOWING_HREF_RE.test(url.pathname);
            } catch (_) {
                return false;
            }
        });
    }

    function hasChannelRow(list) {
        return Array.from(list.children).some((child) => getRowInfo(child));
    }

    // 2026-09-11 실측한 nav[aria-label="팔로우"]를 우선하고, 없으면 고정 기능과 같은 팔로잉 구역 판별을 쓴다.
    function findFollowingList(sidebar) {
        if (!sidebar) return null;
        const preferred = sidebar.querySelector(FOLLOWING_SECTION_SELECTOR);
        const sections = preferred ? [preferred] : Array.from(sidebar.querySelectorAll("nav, section"));
        for (const section of sections) {
            if (
                section !== preferred &&
                !hasFollowingLink(section) &&
                !FOLLOWING_TEXT_RE.test(normSpace(section.textContent))
            ) {
                continue;
            }
            for (const list of section.querySelectorAll("ul, [role='list']")) {
                if (hasChannelRow(list)) return { section, list };
            }
        }
        return null;
    }

    function findRefreshButton(section) {
        if (!(section instanceof HTMLElement)) return null;
        const headerButtons = section.querySelectorAll('header button[aria-label], header [role="button"][aria-label]');
        const candidates = headerButtons.length ? headerButtons : section.querySelectorAll(REFRESH_BUTTON_SELECTOR);
        return (
            Array.from(candidates).find(
                (button) =>
                    !button.hasAttribute(LEGACY_MANAGE_ATTR) &&
                    !button.hasAttribute(PIN_MODE_BUTTON_ATTR) &&
                    !button.closest("[id^='betterchzzk-']") &&
                    REFRESH_LABEL_RE.test(normSpace(button.getAttribute("aria-label")))
            ) || null
        );
    }

    function rememberChannel(channelId, name) {
        knownChannels.delete(channelId);
        knownChannels.set(channelId, { name });
        while (knownChannels.size > MAX_KNOWN_CHANNELS) knownChannels.delete(knownChannels.keys().next().value);
    }

    function getFolder(folderId) {
        return folderState.folders.find((folder) => folder.id === folderId) || null;
    }

    function getViewFolder(folderId) {
        return viewState.folders.find((folder) => folder.id === folderId) || null;
    }

    function setFolderState(state, status) {
        confirmedState = state ? cloneState(state) : cloneState(EMPTY_STATE);
        stateStatus = status;
        rebuildStates();
    }

    function applyOn(state, command) {
        const result = applyCommand(state, command);
        return result.ok && result.changed ? result.state : state;
    }

    // 확인한 상태에 기다리는 내 변경과 끄는 중 미리보기를 차례로 얹어 판단용·화면용 상태를 다시 만든다.
    function rebuildStates({ animate = false } = {}) {
        const ready = stateStatus === "ready";
        let base = confirmedState;
        if (ready) for (const entry of optimistic) base = applyOn(base, entry.command);
        folderState = cloneState(base);
        folderOfChannel = new Map();
        folderPosition = new Map();
        folderState.folders.forEach((folder, index) => {
            folderPosition.set(folder.id, index);
            for (const channelId of folder.channelIds) folderOfChannel.set(channelId, folder.id);
        });
        let view = folderState;
        if (ready && preview) view = applyOn(view, preview.command);
        if (
            ready &&
            springFolderId &&
            view.folders.some((folder) => folder.id === springFolderId && folder.collapsed)
        ) {
            view = cloneState(view);
            view.folders.find((folder) => folder.id === springFolderId).collapsed = false;
        }
        viewState = view === folderState ? folderState : cloneState(view);
        viewFolderOf = new Map();
        viewPosition = new Map();
        viewCollapsed = new Set();
        viewState.folders.forEach((folder, index) => {
            viewPosition.set(folder.id, index);
            if (folder.collapsed) viewCollapsed.add(folder.id);
            for (const channelId of folder.channelIds) viewFolderOf.set(channelId, folder.id);
        });
        if (renaming && !getFolder(renaming.folderId)) renaming = null;
        if (layer?.folderId && !getFolder(layer.folderId)) closeLayer(false);
        if (undo && !statesEqual(confirmedState, undo.next)) undo = null;
        if (animate) animateNextSync = true;
        syncAll();
        renderLayer();
    }

    function removeOptimistic(entry) {
        const index = entry ? optimistic.indexOf(entry) : -1;
        if (index >= 0) optimistic.splice(index, 1);
        return index >= 0;
    }

    function applyStoredValue(rawValue) {
        lastRawValue = rawValue;
        const parsed = parseStoredValue(rawValue);
        if (parsed.ok) setFolderState(parsed.state, "ready");
        else {
            console.warn("[Better Chzzk] 저장된 팔로잉 폴더 정보가 올바르지 않아 표시하지 않았어요.", parsed.error);
            setFolderState(null, "corrupt");
        }
    }

    function loadFolderState() {
        const generation = foldersGeneration;
        const epoch = changeEpoch;
        if (stateStatus !== "ready" && stateStatus !== "corrupt") {
            stateStatus = "loading";
            renderLayer();
        }
        folderStore.read().then(
            (rawValue) => {
                // storage.onChanged가 먼저 도착했다면 그 값이 더 최신이다.
                if (!foldersActive || generation !== foldersGeneration || epoch !== changeEpoch) return;
                applyStoredValue(rawValue);
            },
            (error) => {
                if (!foldersActive || generation !== foldersGeneration || epoch !== changeEpoch) return;
                console.warn("[Better Chzzk] 팔로잉 폴더 정보 읽기 실패", error);
                // 마지막 정상 상태는 읽기 오류 대비로 유지하고, 처음 읽기 실패만 오류 상태로 둔다.
                if (stateStatus === "ready" || stateStatus === "corrupt") return;
                stateStatus = "read-error";
                syncAll();
                renderLayer();
            }
        );
    }

    function handleStoredChange(newValue) {
        if (!foldersActive) return;
        changeEpoch += 1;
        // Chrome은 내 저장의 storage.onChanged를 저장 응답보다 먼저 줄 수 있어요. 지금 쓰는 값과 같으면 확인한 값에
        // 그 명령이 이미 들어 있으므로, 응답을 기다리지 않고 빼야 순서 이동 같은 명령을 두 번 얹지 않아요.
        const parsed = parseStoredValue(newValue);
        const landed =
            parsed.ok && optimistic.find((entry) => entry.writing && statesEqual(entry.writing, parsed.state));
        if (landed) removeOptimistic(landed);
        applyStoredValue(newValue);
    }

    function releaseBusy() {
        const list = busyList;
        busyList = null;
        // 그사이 사이트가 직접 바꾼 값은 그대로 둬요.
        if (!list || list.getAttribute("aria-busy") !== "true") return;
        if (busyOriginal === null) list.removeAttribute("aria-busy");
        else list.setAttribute("aria-busy", busyOriginal);
    }

    function updateBusy() {
        const list = runtimeInstalled && foldersActive && pendingCommands > 0 ? currentList : null;
        if (busyList === list) return;
        releaseBusy();
        if (!list) return;
        busyList = list;
        busyOriginal = list.getAttribute("aria-busy");
        setAttr(list, "aria-busy", "true");
    }

    function failureMessage(error) {
        return ERROR_MESSAGES[error] || SAVE_FAILED_MESSAGE;
    }

    function isCurrentGeneration(generation) {
        return foldersActive && generation === foldersGeneration;
    }

    // 개별 명령을 마지막으로 확인한 원본값에 적용해 기대값과 함께 저장한다. 다른 문서가 먼저 바꿔
    // conflict가 오면 워커가 돌려준 최신 값에 같은 명령을 다시 적용하되 MAX_WRITE_ATTEMPTS에서 멈춘다.
    // 되돌리기는 사용자가 본 상태로만 돌리므로 최신 값에 다시 적용하지 않고 바로 멈춘다.
    // 큐에서 기다리는 동안 OFF·재활성화로 세대가 바뀌면 아직 보내지 않은 이전 명령은 쓰지 않고 버린다.
    async function runCommand(command, generation, entry = null) {
        if (!isCurrentGeneration(generation)) return { ok: false, error: "stopped" };
        if (stateStatus !== "ready" && stateStatus !== "corrupt") return { ok: false, error: "not-ready" };
        let rawValue = lastRawValue;
        for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
            if (!isCurrentGeneration(generation)) return { ok: false, error: "stopped" };
            const epoch = changeEpoch;
            const result = applyCommand(rawValue, command);
            if (!result.ok || !result.changed) return result;
            // 응답보다 먼저 온 storage.onChanged가 이 저장인지 알아볼 수 있게 쓰는 값을 표시해 둔다.
            if (entry) entry.writing = result.state;
            try {
                await folderStore.write(result.state, rawValue);
            } catch (error) {
                if (entry) entry.writing = null;
                if (!isCurrentGeneration(generation)) return { ok: false, error: "stopped" };
                if (error?.code !== "conflict") return { ok: false, error: error?.code || "write-failed" };
                const latest = fromExpected(error.current?.[STORAGE_KEY]);
                if (!latest.ok) return { ok: false, error: "write-conflict", reload: true };
                rawValue = latest.rawValue;
                // 그사이 storage.onChanged가 왔다면 그 값이 더 최신이므로 화면은 그 값을 유지한다.
                if (epoch === changeEpoch) applyStoredValue(rawValue);
                if (command.type === "restore") return { ok: false, error: "undo-conflict" };
                continue;
            }
            if (entry) entry.writing = null;
            if (!isCurrentGeneration(generation)) return { ok: false, error: "stopped" };
            // 확인된 값에는 이 명령이 이미 들어 있으므로 먼저 빼야 같은 명령을 두 번 얹지 않는다.
            const removed = removeOptimistic(entry);
            if (epoch === changeEpoch) applyStoredValue(cloneState(result.state));
            // 그사이 storage.onChanged가 화면에 둔 최신 값은 유지하되, 뺀 명령이 판단·화면에 남지 않게 다시 만든다.
            else if (removed) rebuildStates({ animate: true });
            return { ...result, previous: rawValue };
        }
        return { ok: false, error: "write-conflict" };
    }

    // success 문구가 있으면 바뀐 경우 안내하고, undoable이면 그 안내에서 직전 원본값으로 되돌릴 수 있다.
    // onFailure가 true를 돌려주면 그 자리에서 이미 알린 실패라 따로 안내하지 않는다.
    // 정상 상태에서는 저장 응답을 기다리지 않고 화면에 먼저 반영하고, 실패하면 확인한 상태로 되돌린 뒤 알린다.
    function sendCommand(command, { success = "", undoable = false, onSuccess = null, onFailure = null } = {}) {
        const generation = foldersGeneration;
        const entry = stateStatus === "ready" ? { command } : null;
        if (entry) {
            optimistic.push(entry);
            rebuildStates({ animate: true });
        }
        pendingCommands += 1;
        updateBusy();
        const run = commandChain
            .then(() => runCommand(command, generation, entry))
            .then((result) => {
                if (!isCurrentGeneration(generation)) return result;
                if (removeOptimistic(entry)) rebuildStates({ animate: true });
                if (result.ok) {
                    onSuccess?.(result);
                    if (success && result.changed) {
                        undo = undoable ? { previous: result.previous, next: cloneState(result.state) } : null;
                        notify(success, "success", undoable);
                    }
                    return result;
                }
                if (result.error === "corrupt-state" && stateStatus !== "corrupt") setFolderState(null, "corrupt");
                if (onFailure?.(result) !== true) notify(failureMessage(result.error), "error");
                if (result.reload) loadFolderState();
                return result;
            })
            .catch((error) => {
                console.warn("[Better Chzzk] 팔로잉 폴더 변경 처리 실패", error);
                if (!isCurrentGeneration(generation)) return { ok: false, error: "stopped" };
                if (removeOptimistic(entry)) rebuildStates({ animate: true });
                notify(SAVE_FAILED_MESSAGE, "error");
                return { ok: false, error: "write-failed" };
            })
            .finally(() => {
                pendingCommands = Math.max(0, pendingCommands - 1);
                updateBusy();
            });
        commandChain = run;
        return run;
    }

    function getRank(row, isLive) {
        const group = row.getAttribute(PIN_GROUP_ATTR);
        return PIN_RANKS.has(group) ? PIN_RANKS.get(group) : isLive ? 1 : 3;
    }

    function clearRowMarks(row) {
        if (!(row instanceof HTMLElement)) return;
        removeAttr(row, ORDER_ATTR);
        removeAttr(row, HIDDEN_ATTR);
        removeAttr(row, CHANNEL_ATTR);
        removeAttr(row, DROP_ATTR);
        rowIdentity.delete(row);
    }

    function syncChild(child) {
        if (!(child instanceof HTMLElement) || isExtensionRow(child)) return;
        const info = getRowInfo(child);
        if (!info) {
            clearRowMarks(child);
            return;
        }
        const folderId = viewFolderOf.get(info.channelId) || "";
        const section = folderId ? viewPosition.get(folderId) : REST_SECTION;
        setAttr(child, ORDER_ATTR, String(section * SECTION_SLOTS + 1 + getRank(child, info.isLive)));
        setAttr(child, CHANNEL_ATTR, info.channelId);
        if (folderId && viewCollapsed.has(folderId)) setAttr(child, HIDDEN_ATTR, "1");
        else removeAttr(child, HIDDEN_ATTR);
    }

    function removeHeader(header) {
        dropNodes = dropNodes.filter((node) => node !== header);
        header.remove();
    }

    function clearListPresentation(list) {
        if (!(list instanceof HTMLElement)) return;
        removeAttr(list, LIST_ATTR);
        removeAttr(list, COMPACT_ATTR);
        removeAttr(list, DRAGGING_ATTR);
        for (const child of Array.from(list.children)) {
            if (headerOwners.has(child) || child.hasAttribute(HEADER_ATTR)) removeHeader(child);
            else if (child !== newZone && !child.hasAttribute(NEW_ZONE_ATTR)) clearRowMarks(child);
        }
    }

    function cleanupList(list) {
        clearListPresentation(list);
        if (list instanceof HTMLElement) removeAttr(list, MAX_ROWS_ATTR);
    }

    // ── 폴더 머리 행 ─────────────────────────────────────────────────────────────
    function createHeader(key) {
        const tag = currentList.matches("ul, ol") ? "li" : "div";
        const header = document.createElement(tag);
        if (tag === "div" && currentList.getAttribute("role") === "list") header.setAttribute("role", "listitem");
        header.setAttribute(HEADER_ATTR, key === REST_KEY ? "rest" : "folder");
        headerOwners.set(header, { key });
        if (key === REST_KEY) header.append(el("span", "bcff-header-name", "폴더 밖 채널"));
        else header.addEventListener("click", handleHeaderBlankClick);
        return header;
    }

    function headerKey(header) {
        return headerOwners.get(header)?.key;
    }

    function liveCount(folder) {
        return folder.channelIds.filter((channelId) => liveChannelIds.has(channelId)).length;
    }

    // 원본 목록이 덜 그려져 방송 상태를 확인하지 못한 폴더 채널 수예요. 끝까지 펼쳐도 없던 채널은 세지 않아요.
    function uncheckedCount(folder) {
        if (!partialChannelIds) return 0;
        return folder.channelIds.filter(
            (channelId) => !partialChannelIds.has(channelId) && !unreachableChannelIds.has(channelId)
        ).length;
    }

    function buildFolderHeader(header, folder) {
        const toggle = el("button", "bcff-toggle");
        toggle.type = "button";
        // 키보드는 이름 버튼(Enter·Space로 바로 접기)을 쓰므로 화살표는 탭 순서에서 뺀다.
        toggle.tabIndex = -1;
        toggle.innerHTML = ICONS.chevron;
        toggle.addEventListener("click", handleToggleClick);
        const nameArea = renaming?.folderId === folder.id ? buildRenameInput(folder) : buildNameButton();
        const spacer = el("span", "bcff-spacer");
        const live = el("span", "bcff-live");
        live.setAttribute("aria-hidden", "true");
        const more = el("button", "bcff-more");
        more.type = "button";
        more.innerHTML = ICONS.more;
        more.setAttribute("aria-haspopup", "menu");
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", handleMoreClick);
        header.replaceChildren(toggle, ...nameArea, spacer, live, more);
    }

    function buildNameButton() {
        const name = el("button", "bcff-name");
        name.type = "button";
        name.draggable = true;
        name.addEventListener("click", handleNameClick);
        name.addEventListener("dblclick", handleNameDoubleClick);
        name.addEventListener("keydown", handleNameKeyDown);
        name.addEventListener("dragstart", handleFolderDragStart);
        return [name];
    }

    function buildRenameInput(folder) {
        const input = el("input", "bcff-rename");
        input.type = "text";
        input.autocomplete = "off";
        input.spellcheck = false;
        input.maxLength = MAX_NAME_LENGTH * 2;
        input.value = renaming.draft;
        input.setAttribute("aria-label", `‘${folder.name}’ 폴더 새 이름`);
        input.setAttribute(KEY_ATTR, `folder:${folder.id}:rename-input`);
        const hint = el("span", "bcff-rename-hint");
        hint.setAttribute("aria-live", "polite");
        input.addEventListener("input", () => {
            if (!renaming || renaming.folderId !== folder.id) return;
            renaming.draft = input.value;
            renaming.error = "";
            syncRenameHint(input, hint);
        });
        input.addEventListener("keydown", (event) => {
            // 입력 중인 글자가 치지직 페이지 단축키로 전달되지 않게 한다.
            event.stopPropagation();
            if (event.key === "Escape" && !event.isComposing) {
                event.preventDefault();
                cancelRename(true);
                return;
            }
            if (!isEnterSubmit(event)) return;
            event.preventDefault();
            submitRename();
        });
        input.addEventListener("keyup", (event) => event.stopPropagation());
        input.addEventListener("blur", () => {
            // 다시 그리느라 빠진 입력칸이나 저장을 기다리는 동안의 초점 이동은 무시한다.
            setTimeout(() => {
                if (!input.isConnected || renaming?.folderId !== folder.id || renaming.pending) return;
                if (document.activeElement === input) return;
                submitRename({ fromBlur: true });
            }, 0);
        });
        syncRenameHint(input, hint);
        return [input, hint];
    }

    function syncRenameHint(input, hint) {
        const error = renaming?.error || "";
        hint.textContent = error || "Enter 저장 · Esc 취소";
        if (error) {
            hint.setAttribute("data-error", "");
            input.setAttribute("aria-invalid", "true");
        } else {
            hint.removeAttribute("data-error");
            input.removeAttribute("aria-invalid");
        }
        input.readOnly = Boolean(renaming?.pending);
    }

    function updateHeader(header, folder, section) {
        setAttr(header, ORDER_ATTR, String(section * SECTION_SLOTS));
        if (!folder) return;
        const isRenaming = renaming?.folderId === folder.id;
        const name = header.querySelector(":scope > .bcff-name");
        const input = header.querySelector(":scope > .bcff-rename");
        if ((isRenaming && !input) || (!isRenaming && !name)) buildFolderHeader(header, folder);
        setAttr(header, "data-bcff-folder-id", folder.id);
        const toggle = header.querySelector(":scope > .bcff-toggle");
        const nameButton = header.querySelector(":scope > .bcff-name");
        const live = header.querySelector(":scope > .bcff-live");
        const more = header.querySelector(":scope > .bcff-more");
        setAttr(toggle, "aria-expanded", String(!folder.collapsed));
        setAttr(toggle, "aria-label", `${folder.name} 폴더 ${folder.collapsed ? "펼치기" : "접기"}`);
        setAttr(toggle, KEY_ATTR, `folder:${folder.id}:toggle`);
        if (nameButton) {
            if (nameButton.textContent !== folder.name) nameButton.textContent = folder.name;
            setAttr(nameButton, "data-bcff-count", String(folder.channelIds.length));
            setAttr(nameButton, "aria-expanded", String(!folder.collapsed));
            setAttr(
                nameButton,
                "aria-label",
                `${folder.name} 폴더, 채널 ${folder.channelIds.length}개. 두 번 눌러 이름 변경`
            );
            setAttr(nameButton, "title", "클릭: 접기·펼치기 · 더블클릭: 이름 변경 · 끌어서 순서 변경");
            setAttr(nameButton, KEY_ATTR, `folder:${folder.id}:name`);
        }
        const lives = folder.collapsed ? liveCount(folder) : 0;
        // 확인한 방송 중 채널만 세요. 아직 목록에 없는 채널이 남았으면 실제로는 더 많을 수 있다고 표시해요.
        const unchecked = lives ? uncheckedCount(folder) : 0;
        live.hidden = lives === 0;
        setAttr(live, "data-bcff-live", unchecked ? `${lives}+` : String(lives));
        if (unchecked)
            setAttr(
                live,
                "title",
                `방송 중 ${lives}개 확인 · 목록에 아직 없는 채널 ${unchecked}개는 방송 여부를 확인하지 못했어요`
            );
        else removeAttr(live, "title");
        setAttr(more, "aria-label", `${folder.name} 폴더 메뉴`);
        setAttr(more, KEY_ATTR, `folder:${folder.id}:more`);
        setAttr(more, "aria-expanded", String(layer?.kind === "menu" && layer.folderId === folder.id));
    }

    function syncHeaders() {
        const desired = [...viewState.folders.map((folder) => folder.id), REST_KEY];
        const desiredKeys = new Set(desired);
        const existing = new Map();
        for (const child of Array.from(currentList.children)) {
            if (child === newZone) continue;
            const owner = headerOwners.get(child);
            if (!owner) {
                // 재주입 전 문서 등 이 실행이 소유하지 않은 머리 행·새 폴더 자리는 정리한다.
                if (child.hasAttribute(HEADER_ATTR) || child.hasAttribute(NEW_ZONE_ATTR)) removeHeader(child);
                continue;
            }
            if (!desiredKeys.has(owner.key) || existing.has(owner.key)) removeHeader(child);
            else existing.set(owner.key, child);
        }
        desired.forEach((key) => {
            let header = existing.get(key);
            if (!header) {
                header = createHeader(key);
                currentList.append(header);
            }
            const folder = key === REST_KEY ? null : getViewFolder(key);
            updateHeader(header, folder, folder ? viewPosition.get(key) : REST_SECTION);
        });
        restoreRenameFocus();
    }

    function removeForeignHeaders() {
        document.querySelectorAll(`[${HEADER_ATTR}]`).forEach((header) => {
            if (!presentationActive || header.parentElement !== currentList || !headerOwners.has(header))
                removeHeader(header);
        });
    }

    function syncCompact() {
        const width = currentList.getBoundingClientRect().width;
        if (width > 0 && width < COMPACT_WIDTH) setAttr(currentList, COMPACT_ATTR, "1");
        else removeAttr(currentList, COMPACT_ATTR);
    }

    function isCompact() {
        return currentList?.getAttribute(COMPACT_ATTR) === "1";
    }

    function syncPresentation() {
        presentationActive = Boolean(
            featureOptions.followingFoldersEnabled &&
            foldersActive &&
            stateStatus === "ready" &&
            viewState.folders.length &&
            currentList
        );
        removeForeignHeaders();
        document.querySelectorAll(`[${LIST_ATTR}]`).forEach((list) => {
            if (!presentationActive || list !== currentList) clearListPresentation(list);
        });
        if (!presentationActive) {
            if (currentList) clearListPresentation(currentList);
            if (renaming) renaming = null;
            return;
        }
        setAttr(currentList, LIST_ATTR, "1");
        syncCompact();
        // 행 정체성은 캐시된 href 판정만 읽어요. 이름은 채널 선택 창을 열 때만 읽어요.
        liveChannelIds = new Set();
        const renderedChannelIds = new Set();
        for (const child of currentList.children) {
            const info = getRowInfo(child);
            if (!info) continue;
            renderedChannelIds.add(info.channelId);
            if (info.isLive) liveChannelIds.add(info.channelId);
        }
        // `더보기` 버튼이 있고 아직 `접기`가 아니면 원본 목록이 덜 그려진 상태예요.
        partialChannelIds =
            findNativeListButton()?.getAttribute("aria-expanded") === "false" ? renderedChannelIds : null;
        syncHeaders();
        for (const child of Array.from(currentList.children)) syncChild(child);
        if (activeDrag || folderDrag) setAttr(currentList, DRAGGING_ATTR, "1");
        if (dropKey) markDrop(dropKey);
    }

    function measureRowHeight(list) {
        for (const child of list.children) {
            if (isExtensionRow(child) || !getRowInfo(child)) continue;
            const height = child.getBoundingClientRect().height;
            if (!(height > 0)) continue;
            const style = getComputedStyle(child);
            const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
            const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
            measuredRowHeight = Math.min(200, height + margins + gap);
            return measuredRowHeight;
        }
        return 0;
    }

    function setRowsStyle(text) {
        const existing = document.getElementById(ROWS_STYLE_ID);
        if (!text) {
            existing?.remove();
            return;
        }
        const style = existing || document.createElement("style");
        if (style.textContent !== text) style.textContent = text;
        if (!existing) {
            style.id = ROWS_STYLE_ID;
            document.documentElement.append(style);
        }
    }

    // 원본 행을 숨기거나 옮기지 않고 목록 높이만 제한한다. 끝에서 스크롤은 사이드바로 이어져
    // 다른 구역과 원래 더보기·접기 조작에 그대로 닿을 수 있다.
    function syncMaxRows() {
        const rows = runtimeInstalled ? featureOptions.followingListMaxRows : 0;
        const active = rows > 0 && currentList;
        document.querySelectorAll(`[${MAX_ROWS_ATTR}]`).forEach((list) => {
            if (!active || list !== currentList) list.removeAttribute(MAX_ROWS_ATTR);
        });
        if (!active) {
            setRowsStyle("");
            return;
        }
        setAttr(currentList, MAX_ROWS_ATTR, "1");
        const height = measureRowHeight(currentList) || measuredRowHeight || FALLBACK_ROW_HEIGHT;
        setRowsStyle(`#sidebar [${MAX_ROWS_ATTR}="1"]{max-height:${Math.round(height * rows)}px!important}`);
    }

    // ── 폴더 정보 상태 안내(팔로잉 목록 맨 위) ─────────────────────────────────────────
    function removeStatusRow() {
        if (statusArmTimer) clearTimeout(statusArmTimer);
        statusArmTimer = 0;
        statusArmed = false;
        statusRow?.remove();
        statusRow = null;
    }

    // 폴더 정보를 처음 읽지 못했거나 저장값이 손상됐을 때만 보여요. 정상 상태에서는 아무것도 붙이지 않아요.
    function syncStatusRow() {
        const wanted =
            currentList &&
            foldersActive &&
            featureOptions.followingFoldersEnabled &&
            (stateStatus === "read-error" || stateStatus === "corrupt");
        if (!wanted) {
            removeStatusRow();
            return;
        }
        const kind = stateStatus;
        if (!statusRow) {
            const tag = currentList.matches("ul, ol") ? "li" : "div";
            statusRow = document.createElement(tag);
            if (tag === "div" && currentList.getAttribute("role") === "list")
                statusRow.setAttribute("role", "listitem");
            statusRow.setAttribute(STATUS_ATTR, "");
        }
        if (currentList.firstElementChild !== statusRow) currentList.prepend(statusRow);
        if (statusRow.getAttribute(STATUS_ATTR) === `${kind}:${statusArmed}`) return;
        const focused = statusRow.contains(document.activeElement);
        statusRow.setAttribute(STATUS_ATTR, `${kind}:${statusArmed}`);
        const button = el("button");
        button.type = "button";
        if (kind === "read-error") {
            button.textContent = "다시 읽기";
            button.setAttribute("aria-label", "폴더 정보 다시 읽기");
            button.setAttribute(KEY_ATTR, "retry");
            button.addEventListener(
                "click",
                trusted(() => loadFolderState())
            );
            statusRow.replaceChildren(el("p", "", "폴더 정보를 읽지 못했어요. 저장된 폴더는 그대로예요."), button);
        } else {
            button.textContent = statusArmed ? "한 번 더 눌러 초기화" : "폴더 정보 초기화";
            button.setAttribute("aria-label", statusArmed ? "폴더 정보 초기화 확인" : "폴더 정보 초기화");
            button.setAttribute(KEY_ATTR, "reset");
            if (statusArmed) button.setAttribute("data-armed", "");
            button.addEventListener(
                "click",
                trusted(() => {
                    if (!statusArmed) {
                        statusArmed = true;
                        statusArmTimer = setTimeout(() => {
                            statusArmTimer = 0;
                            statusArmed = false;
                            syncStatusRow();
                        }, DELETE_CONFIRM_MS);
                        syncStatusRow();
                        return;
                    }
                    if (statusArmTimer) clearTimeout(statusArmTimer);
                    statusArmTimer = 0;
                    statusArmed = false;
                    sendCommand({ type: "resetCorrupt" }, { success: "폴더 정보를 초기화했어요." });
                })
            );
            statusRow.replaceChildren(
                el(
                    "p",
                    "",
                    "저장된 폴더 정보가 올바르지 않아 폴더를 표시하지 않았어요. 초기화하면 모든 폴더와 지정이 지워지고 팔로우는 그대로예요."
                ),
                button
            );
        }
        if (focused) button.focus({ preventScroll: true });
    }

    function syncAll() {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (!runtimeInstalled) return;
        const following = findFollowingList(getSidebar());
        const list = following?.list || null;
        if (currentList && currentList !== list) {
            removeNewZone();
            removeStatusRow();
            cleanupList(currentList);
        }
        currentList = list;
        currentSection = following?.section || null;
        // 바뀐 목록이나 기능 OFF에서는 이전 목록의 aria-busy를 돌려주고, 저장 중이면 지금 목록에 붙인다.
        updateBusy();
        // 폴더 상태가 바뀐 그리기만 행이 새 자리로 미끄러지게 해요. 원본 행의 속성은 건드리지 않는 애니메이션이에요.
        const before = animateNextSync && currentList === list ? captureLayout() : null;
        animateNextSync = false;
        syncPresentation();
        syncStatusRow();
        syncNewZone();
        syncMaxRows();
        playLayout(before);
        if (layer) {
            if (!layer.anchor?.isConnected && !reconnectLayerAnchor()) closeLayer(false);
            else if (layer.kind === "picker") renderPicker();
            else positionLayer();
        }
        expandNativeListForFolders();
    }

    function findNativeListButton() {
        if (!currentSection) return null;
        for (const button of currentSection.querySelectorAll("button[aria-expanded]")) {
            if (currentList?.contains(button) || button.closest("[id^='betterchzzk-']")) continue;
            if (NATIVE_LIST_LABELS.has(normSpace(button.getAttribute("aria-label")))) return button;
        }
        return null;
    }

    // 원본 목록은 접힌 5개에서 `더보기`마다 50개씩 505개까지 늘어요(2026-10-13 공개 번들 index-VdvK-ysl.js).
    // 펼친 폴더의 채널이 아직 목록에 없으면 원본 행이 늘어난 것을 확인할 때마다 한 번씩 대신 눌러 그 상한까지
    // 펼쳐요(같은 날 사용자 요청). 치지직 새로고침은 첫 `더보기` 때의 55개로 다시 자르므로 줄면 다시 펼쳐요.
    // 행 변화 알림(마이크로태스크)에서도 이어 눌러, 줄었다 다시 늘어난 목록이 그려지기 전에 끝내요.
    // 레이아웃을 읽지 않아 그사이 스크롤 위치가 줄어든 목록 기준으로 잘리지 않아요. 끄는 중·이름 입력 중에는 두어요.
    function expandNativeListForFolders() {
        if (!presentationActive || nativeExpandHeld || activeDrag || folderDrag || renaming || !currentList) return;
        const button = findNativeListButton();
        if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
        const expanded = button.getAttribute("aria-expanded");
        if (expanded !== "true" && expanded !== "false") return;
        const rendered = new Set();
        let nativeRows = 0;
        for (const child of currentList.children) {
            const info = getRowInfo(child);
            if (!info) continue;
            rendered.add(info.channelId);
            if (!child.hasAttribute(PIN_SOURCE_ROW_ATTR)) nativeRows += 1;
        }
        // 행 수가 바뀌면 대신 누른 `더보기`의 응답이 온 거예요. 새로고침이 마지막으로 누른 때와 같은 55개로
        // 잘라도 다시 누를 수 있게 대기를 바로 풀어요.
        if (nativeExpandPending && (nativeExpandPending.button !== button || nativeExpandPending.rows !== nativeRows))
            nativeExpandPending = null;
        const missing = [];
        for (const folder of viewState.folders) {
            if (viewCollapsed.has(folder.id)) continue;
            for (const channelId of folder.channelIds) {
                if (!rendered.has(channelId) && !unreachableChannelIds.has(channelId)) missing.push(channelId);
            }
        }
        if (expanded === "true") {
            nativeExpandPending = null;
            for (const channelId of missing) unreachableChannelIds.add(channelId);
            return;
        }
        if (!missing.length || nativeExpandPending) return;
        const now = Date.now();
        nativeExpandClicks = nativeExpandClicks.filter((time) => now - time < NATIVE_EXPAND_WINDOW_MS);
        if (nativeExpandClicks.length >= NATIVE_EXPAND_LIMIT) return;
        nativeExpandClicks.push(now);
        nativeExpandPending = { button, rows: nativeRows };
        button.click();
    }

    // 원본 클릭보다 먼저 받아 누르기 전 상태로 판단해요.
    function handleNativeListClick(event) {
        if (!event.isTrusted || !(event.target instanceof Node)) return;
        const button = findNativeListButton();
        if (button?.contains(event.target) && button.getAttribute("aria-expanded") === "true") nativeExpandHeld = true;
    }

    function releaseNativeExpandHold() {
        nativeExpandHeld = false;
        nativeExpandPending = null;
        nativeExpandClicks = [];
        unreachableChannelIds = new Set();
    }

    function scheduleSync() {
        if (frame || !runtimeInstalled) return;
        frame = requestAnimationFrame(syncAll);
    }

    function directChildOf(list, node) {
        let row = node instanceof Element ? node : node?.parentElement;
        while (row && row !== list && row.parentElement !== list) row = row.parentElement;
        return row && row !== list && row.parentElement === list ? row : null;
    }

    // 변경된 행만 그리기 전에 다시 판정하고, 목록 구조가 바뀐 경우에만 전체 동기화를 예약한다.
    function handleMutations(mutations) {
        if (!runtimeInstalled) return;
        const list = currentList;
        if (!list) {
            scheduleSync();
            return;
        }
        if (!list.isConnected) {
            syncAll();
            return;
        }
        const rows = new Set();
        let structural = false;
        for (const mutation of mutations) {
            const target = mutation.target instanceof Element ? mutation.target : mutation.target?.parentElement;
            if (mutation.type === "attributes") {
                if (!target || !list.contains(target) || target === list) continue;
                const row = directChildOf(list, target);
                if (!row || isExtensionRow(row)) continue;
                rows.add(row);
                if (mutation.attributeName === "href") structural = true;
                continue;
            }
            if (mutation.target === list) {
                for (const node of mutation.addedNodes) {
                    if (node === newZone || node === statusRow || headerOwners.has(node)) continue;
                    structural = true;
                    const row = directChildOf(list, node);
                    if (row) rows.add(row);
                }
                for (const node of mutation.removedNodes) {
                    if (node === newZone || node === statusRow || headerOwners.has(node)) continue;
                    structural = true;
                    if (node.parentElement === list) continue;
                    if (node instanceof HTMLElement && !node.hasAttribute(HEADER_ATTR)) clearRowMarks(node);
                }
                continue;
            }
            if (target && list.contains(target)) {
                const row = directChildOf(list, target);
                if (row && !isExtensionRow(row)) {
                    rowIdentity.delete(row);
                    rows.add(row);
                    structural = true;
                }
                continue;
            }
            if (target && (currentSection?.contains(target) || target.contains(list))) {
                if (layer?.node.contains(target)) continue;
                // 목록 밖 구역 변화(머리·버튼·목록 교체)는 대상 목록을 다시 찾는다.
                syncAll();
                return;
            }
        }
        if (presentationActive) for (const row of rows) syncChild(row);
        if (structural) {
            expandNativeListForFolders();
            scheduleSync();
        }
    }

    // ── 접기와 이름 변경 ─────────────────────────────────────────────────────────────
    function folderOfHeaderControl(control) {
        const header = control?.parentElement;
        const key = header ? headerKey(header) : undefined;
        if (!key || header.parentElement !== currentList) return null;
        return getFolder(key);
    }

    function toggleFolder(folder) {
        if (folder.collapsed) releaseNativeExpandHold();
        sendCommand({ type: "setCollapsed", folderId: folder.id, collapsed: !folder.collapsed });
    }

    function handleToggleClick(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted) return;
        const folder = folderOfHeaderControl(event.currentTarget);
        if (!folder) return;
        clearClickTimer();
        toggleFolder(folder);
    }

    // 이름 옆 빈 공간(머리 행 여백·방송 수 표시)을 누르면 화살표처럼 바로 접고 펼친다. 버튼과 이름 입력칸은 각자 처리한다.
    function handleHeaderBlankClick(event) {
        const header = event.currentTarget;
        const target = event.target;
        const blank =
            target === header || (target.parentElement === header && target.matches(".bcff-spacer, .bcff-live"));
        if (!blank) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted) return;
        const key = headerKey(header);
        if (!key || header.parentElement !== currentList || renaming?.folderId === key) return;
        const folder = getFolder(key);
        if (!folder) return;
        clearClickTimer();
        toggleFolder(folder);
    }

    function clearClickTimer() {
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = 0;
    }

    // 이름 한 번 클릭은 더블클릭(이름 변경)과 구분하려고 잠시 기다렸다 접는다. 키보드 실행(detail 0)은 바로 접는다.
    function handleNameClick(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted) return;
        const folder = folderOfHeaderControl(event.currentTarget);
        if (!folder) return;
        clearClickTimer();
        if (event.detail === 0) {
            toggleFolder(folder);
            return;
        }
        if (event.detail > 1) return;
        const folderId = folder.id;
        clickTimer = setTimeout(() => {
            clickTimer = 0;
            const latest = getFolder(folderId);
            if (latest && renaming?.folderId !== folderId) toggleFolder(latest);
        }, CLICK_TOGGLE_DELAY_MS);
    }

    function handleNameDoubleClick(event) {
        event.preventDefault();
        event.stopPropagation();
        clearClickTimer();
        if (!event.isTrusted) return;
        const folder = folderOfHeaderControl(event.currentTarget);
        if (folder) startRename(folder.id);
    }

    function handleNameKeyDown(event) {
        if (event.key !== "F2" || !event.isTrusted || event.isComposing) return;
        const folder = folderOfHeaderControl(event.currentTarget);
        if (!folder) return;
        event.preventDefault();
        event.stopPropagation();
        startRename(folder.id);
    }

    function startRename(folderId, { select = true } = {}) {
        const folder = getFolder(folderId);
        if (!folder || !presentationActive) return;
        closeLayer(false);
        clearClickTimer();
        renaming = { folderId, draft: folder.name, error: "", pending: false, select, focus: true };
        syncPresentation();
    }

    function restoreRenameFocus() {
        if (!renaming?.focus) return;
        const input = currentList?.querySelector(
            `[${HEADER_ATTR}][data-bcff-folder-id="${renaming.folderId}"] > .bcff-rename`
        );
        if (!(input instanceof HTMLInputElement)) return;
        renaming.focus = false;
        input.focus({ preventScroll: false });
        if (renaming.select) input.select();
        renaming.select = false;
    }

    function finishRename(focusName) {
        const folderId = renaming?.folderId;
        renaming = null;
        syncPresentation();
        if (!focusName || !folderId) return;
        currentList
            ?.querySelector(`[${HEADER_ATTR}][data-bcff-folder-id="${folderId}"] > .bcff-name`)
            ?.focus({ preventScroll: true });
    }

    function cancelRename(focusName) {
        if (!renaming) return;
        finishRename(focusName);
    }

    function currentRenameInput() {
        return renaming
            ? currentList?.querySelector(`[${HEADER_ATTR}][data-bcff-folder-id="${renaming.folderId}"] > .bcff-rename`)
            : null;
    }

    function showRenameError(error) {
        if (!renaming) return;
        renaming.error = error;
        renaming.pending = false;
        const input = currentRenameInput();
        const hint = input?.nextElementSibling;
        if (input && hint) syncRenameHint(input, hint);
        input?.focus({ preventScroll: true });
    }

    function submitRename({ fromBlur = false } = {}) {
        if (!renaming || renaming.pending) return;
        const folder = getFolder(renaming.folderId);
        if (!folder) {
            cancelRename(false);
            return;
        }
        const name = normalizeFolderName(renaming.draft);
        if (!name || name === folder.name) {
            // 초점이 떠나며 생긴 잘못된 이름은 조용히 원래 이름을 유지하고, Enter에는 바로 알린다.
            if (!name && !fromBlur) return showRenameError(ERROR_MESSAGES["invalid-name"]);
            cancelRename(!fromBlur);
            return;
        }
        renaming.pending = true;
        const input = currentRenameInput();
        if (input) input.readOnly = true;
        const folderId = folder.id;
        const previousName = folder.name;
        sendCommand(
            { type: "rename", folderId, name },
            {
                success: `‘${previousName}’ 폴더 이름을 ‘${name}’(으)로 바꿨어요.`,
                undoable: true,
                onSuccess: () => {
                    if (renaming?.folderId === folderId) finishRename(!fromBlur);
                },
                onFailure: (result) => {
                    if (renaming?.folderId !== folderId) return false;
                    renaming.pending = false;
                    if (fromBlur) {
                        cancelRename(false);
                        return false;
                    }
                    if (RENAME_ERRORS.has(result.error)) {
                        showRenameError(failureMessage(result.error));
                        return true;
                    }
                    const input = currentRenameInput();
                    if (input) input.readOnly = false;
                    return false;
                },
            }
        );
    }

    function folderNameTaken(name) {
        const key = name.normalize("NFC").toLowerCase();
        return folderState.folders.some((folder) => folder.name.normalize("NFC").toLowerCase() === key);
    }

    function uniqueFolderName() {
        let name = DEFAULT_FOLDER_NAME;
        for (let index = 2; folderNameTaken(name) && index <= MAX_FOLDERS + 1; index += 1)
            name = `${DEFAULT_FOLDER_NAME} ${index}`;
        return name;
    }

    function createFolder(channel = null, planned = null) {
        if (folderState.folders.length >= MAX_FOLDERS) {
            notify(ERROR_MESSAGES["folder-limit"], "error");
            return;
        }
        const folderId = planned?.folderId || createFolderId();
        const name = planned?.name || uniqueFolderName();
        const command = channel
            ? { type: "createWith", folderId, name, channelId: channel.channelId }
            : { type: "create", folderId, name };
        sendCommand(command, {
            success: channel ? `${channel.name} 채널로 ‘${name}’ 폴더를 만들었어요.` : "",
            undoable: Boolean(channel),
        });
        // 화면에 먼저 생긴 폴더의 이름을 바로 바꿀 수 있어요. 저장이 실패하면 폴더와 함께 입력칸도 사라져요.
        startRename(folderId);
    }

    // ── 끌어 놓기 ───────────────────────────────────────────────────────────────────
    function prefersReducedMotion() {
        return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    }

    function captureLayout() {
        if (!currentList || !presentationActive || prefersReducedMotion()) return null;
        const tops = new Map();
        for (const child of currentList.children) {
            if (child === newZone) continue;
            const rect = child.getBoundingClientRect();
            if (rect.height > 0) tops.set(child, rect.top);
        }
        return tops;
    }

    // FLIP: 바뀐 자리에서 원래 자리만큼 되돌린 위치로 시작해 제자리로 미끄러지게 한다. Web Animations라
    // 원본 행의 style·속성을 쓰지 않고, 끝나면 브라우저가 스스로 지운다.
    function playLayout(tops) {
        if (!tops || !currentList) return;
        for (const child of currentList.children) {
            if (child === newZone || typeof child.animate !== "function") continue;
            const rect = child.getBoundingClientRect();
            if (!(rect.height > 0)) continue;
            const top = tops.get(child);
            if (top === undefined) {
                child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
                continue;
            }
            const offset = top - rect.top;
            if (Math.abs(offset) < 0.5) continue;
            child.animate([{ translate: `0 ${offset}px` }, { translate: "0 0" }], {
                duration: LAYOUT_ANIMATION_MS,
                easing: "cubic-bezier(.2,.8,.2,1)",
            });
        }
    }

    function clearDropMarks() {
        for (const node of dropNodes) {
            removeAttr(node, DROP_ATTR);
            removeAttr(node, HINT_ATTR);
        }
        dropNodes = [];
    }

    function markDrop(key) {
        clearDropMarks();
        if (!key || !currentList) return;
        const marks = [];
        if (key === NEW_DROP) {
            if (newZone) marks.push(newZone);
        } else {
            const folderId = key === REST_DROP ? REST_KEY : key.slice(2);
            for (const child of currentList.children) {
                const owner = headerOwners.get(child);
                if (owner) {
                    if (owner.key !== folderId) continue;
                    const folder = folderId ? getViewFolder(folderId) : null;
                    setAttr(child, HINT_ATTR, folder ? `${folder.name} 폴더로 이동` : "폴더에서 빼기");
                    marks.push(child);
                    continue;
                }
                const channelId = child.getAttribute(CHANNEL_ATTR);
                if (channelId && (viewFolderOf.get(channelId) || REST_KEY) === folderId) marks.push(child);
            }
        }
        for (const node of marks) setAttr(node, DROP_ATTR, "1");
        dropNodes = marks;
    }

    function clearSpring() {
        if (springTimer) clearTimeout(springTimer);
        springTimer = 0;
    }

    function channelPreviewCommand(key) {
        if (!activeDrag || !key) return null;
        const { channelId } = activeDrag;
        if (key === NEW_DROP)
            return {
                type: "createWith",
                folderId: activeDrag.newFolder.folderId,
                name: activeDrag.newFolder.name,
                channelId,
            };
        if (key === REST_DROP) {
            const folderId = folderOfChannel.get(channelId);
            return folderId ? { type: "unassign", folderId, channelId } : null;
        }
        return { type: "assign", folderId: key.slice(2), channelId };
    }

    // 놓을 대상이 바뀌면 끄는 채널이 실제로 들어갈 자리를 미리 보여 준다(폴더 안 순서는 자동 정렬 그대로).
    // 접힌 폴더 위에 잠깐 머물면 저장하지 않고 펼쳐 보여 준다.
    function setDropKey(key) {
        if (dropKey === key) return;
        dropKey = key;
        clearSpring();
        const springTarget = key?.startsWith("f:") && getFolder(key.slice(2))?.collapsed ? key.slice(2) : "";
        if (springFolderId && springFolderId !== springTarget) springFolderId = "";
        if (springTarget && springFolderId !== springTarget) {
            springTimer = setTimeout(() => {
                springTimer = 0;
                if (dropKey !== key || !activeDrag) return;
                springFolderId = springTarget;
                rebuildStates({ animate: true });
            }, SPRING_OPEN_MS);
        }
        const command = channelPreviewCommand(key);
        preview = command ? { command } : null;
        rebuildStates({ animate: true });
        markDrop(key);
    }

    function setFolderPreview(key) {
        if (!folderDrag || dropKey === key) return;
        dropKey = key;
        let command = null;
        const folder = getFolder(folderDrag.folderId);
        if (key && folder) {
            // 놓은 폴더의 자리를 차지해요. 위로 끌면 그 폴더 앞, 아래로 끌면 그 폴더 뒤라서 바로 아래 폴더에 놓아도
            // 순서가 바뀌어요. 폴더 밖 채널에 놓으면 맨 끝이에요.
            const index = key === REST_DROP ? folderState.folders.length - 1 : (folderPosition.get(key.slice(2)) ?? -1);
            if (index >= 0 && index !== folderPosition.get(folder.id))
                command = { type: "moveTo", folderId: folder.id, index };
        }
        folderDrag.command = command;
        preview = command ? { command } : null;
        rebuildStates({ animate: true });
    }

    function clearDrag({ redraw = true } = {}) {
        const hadPreview = Boolean(preview || springFolderId);
        if (activeDrag?.row) removeAttr(activeDrag.row, SOURCE_ATTR);
        activeDrag = null;
        folderDrag = null;
        dragMotion = null;
        dropKey = null;
        preview = null;
        springFolderId = "";
        clearSpring();
        clearDropMarks();
        removeDragCard();
        removeNewZone();
        document.querySelectorAll(`[${DRAGGING_ATTR}]`).forEach((node) => node.removeAttribute(DRAGGING_ATTR));
        if (redraw && hadPreview) rebuildStates({ animate: true });
    }

    // 끄는 동안에만 목록 끝에 새 폴더 자리를 둔다. 사이드바 아래에 붙어 보여 긴 목록에서도 스크롤하지 않아도 된다.
    function syncNewZone() {
        const wanted =
            activeDrag &&
            currentList &&
            foldersActive &&
            featureOptions.followingFoldersEnabled &&
            stateStatus === "ready" &&
            !isCompact() &&
            folderState.folders.length < MAX_FOLDERS;
        if (!wanted) {
            removeNewZone();
            return;
        }
        if (!newZone) {
            const tag = currentList.matches("ul, ol") ? "li" : "div";
            newZone = document.createElement(tag);
            if (tag === "div" && currentList.getAttribute("role") === "list") newZone.setAttribute("role", "listitem");
            newZone.setAttribute(NEW_ZONE_ATTR, "1");
            newZone.setAttribute("aria-hidden", "true");
            newZone.style.order = String(MAX_ORDER + 2);
            newZone.append(el("span", "", "+"), el("span", "", "새 폴더로"));
        }
        if (newZone.parentElement !== currentList || newZone.nextSibling) currentList.append(newZone);
    }

    function removeNewZone() {
        if (!newZone) return;
        dropNodes = dropNodes.filter((node) => node !== newZone);
        if (dropKey === NEW_DROP) dropKey = null;
        newZone.remove();
        newZone = null;
    }

    function removeDragCard() {
        dragCard?.remove();
        dragCard = null;
        document.getElementById(DRAG_CARD_ID)?.remove();
    }

    // 마우스를 따라오는 그림을 행 사진 대신 아바타·이름 카드로 바꾼다. 링크 데이터는 그대로다.
    function showDragCard(event, { title, detail, image = "", live = false, icon = "" }) {
        removeDragCard();
        if (typeof event.dataTransfer?.setDragImage !== "function" || !document.body) return;
        const card = el("div");
        card.id = DRAG_CARD_ID;
        const avatar = el("span", "bcff-drag-avatar");
        if (icon) avatar.innerHTML = ICONS.newFolder;
        else if (image) {
            const img = el("img");
            img.alt = "";
            img.decoding = "sync";
            img.referrerPolicy = "no-referrer";
            img.src = image;
            avatar.append(img);
        } else avatar.textContent = Array.from(title)[0] || "";
        const text = el("span", "bcff-drag-text");
        const sub = el("span", "bcff-drag-detail", detail);
        if (live) sub.dataset.live = "1";
        text.append(el("span", "bcff-drag-title", title), sub);
        card.append(avatar, text);
        document.body.append(card);
        dragCard = card;
        event.dataTransfer.setDragImage(card, 24, 24);
        // 브라우저가 그림을 찍은 뒤에는 필요 없으므로 바로 다음 작업에서 지운다.
        setTimeout(() => {
            if (dragCard === card) removeDragCard();
        }, 0);
    }

    function handleDragEnd() {
        clearDrag();
    }

    function handleDragStart(event) {
        clearDrag();
        if (!event.isTrusted || event.defaultPrevented || !foldersActive || stateStatus !== "ready" || !currentList)
            return;
        const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!(link instanceof HTMLAnchorElement) || !currentList.contains(link)) return;
        const href = link.getAttribute("href") || "";
        const meta = parseChannelHref(href);
        if (!meta || !isValidChannelId(meta.channelId)) return;
        const row = directChildOf(currentList, link);
        const info = row ? getRowInfo(row) : null;
        const name = row && info ? getRowName(row, info) : meta.channelId.slice(0, 8);
        // 링크 데이터와 effectAllowed는 바꾸지 않는다. 사이드바 밖에서는 기존 링크 드래그 그대로다.
        // 맨 아래 행을 끌기 시작하면 새 폴더 자리가 바로 커서 밑에 생겨요. 다른 곳을 지난 뒤에만 받아요.
        activeDrag = {
            link,
            href,
            row,
            name,
            channelId: meta.channelId,
            zoneReady: false,
            newFolder: { folderId: createFolderId(), name: uniqueFolderName() },
        };
        if (row) setAttr(row, SOURCE_ATTR, "1");
        setAttr(currentList, DRAGGING_ATTR, "1");
        const folderId = folderOfChannel.get(meta.channelId);
        showDragCard(event, {
            title: name,
            detail: [meta.isLive ? "방송 중" : "오프라인", folderId ? getFolder(folderId)?.name : ""]
                .filter(Boolean)
                .join(" · "),
            image: row ? getRowImage(row) : "",
            live: meta.isLive,
        });
        syncNewZone();
    }

    function handleFolderDragStart(event) {
        const folder = folderOfHeaderControl(event.currentTarget);
        if (!event.isTrusted || !folder || !presentationActive || isCompact() || renaming || !event.dataTransfer) {
            event.preventDefault();
            return;
        }
        clearClickTimer();
        closeLayer(false);
        event.dataTransfer.setData(FOLDER_DRAG_TYPE, folder.id);
        event.dataTransfer.effectAllowed = "move";
        activeDrag = null;
        folderDrag = { folderId: folder.id, command: null };
        setAttr(currentList, DRAGGING_ATTR, "1");
        showDragCard(event, { title: folder.name, detail: `채널 ${folder.channelIds.length}개`, icon: "folder" });
    }

    // 놓을 대상: 새 폴더 자리, 폴더 머리 행·그 폴더 채널(폴더로), 폴더 밖 머리 행·채널(빼기). 그 밖은 null이다.
    // 화면에 보이는 자리(미리보기 포함)를 기준으로 판단한다.
    function dropKeyFor(node) {
        if (!(node instanceof Node) || !currentList || isCompact()) return null;
        if (newZone?.contains(node)) return NEW_DROP;
        if (!currentList.contains(node) || !presentationActive) return null;
        const row = directChildOf(currentList, node);
        if (!row) return null;
        const owner = headerOwners.get(row);
        if (owner) return owner.key === REST_KEY ? REST_DROP : `f:${owner.key}`;
        const channelId = row.getAttribute(CHANNEL_ATTR);
        if (!channelId) return null;
        const folderId = viewFolderOf.get(channelId);
        return folderId ? `f:${folderId}` : REST_DROP;
    }

    function currentDropKeyOf(channelId) {
        const folderId = folderOfChannel.get(channelId);
        return folderId ? `f:${folderId}` : REST_DROP;
    }

    function pointerY(event) {
        return Number.isFinite(event.clientY) ? event.clientY : null;
    }

    function movedSinceSwitch(event) {
        const y = pointerY(event);
        return !dragMotion || dragMotion.switchedY === null || y === null
            ? true
            : Math.abs(y - dragMotion.switchedY) >= PREVIEW_MOVE_PX;
    }

    // 대상 후보가 충분히 머물렀고, 직전 전환 뒤 행이 자리 잡았으며 커서가 실제로 움직였을 때만 미리보기를 바꾼다.
    function readyToSwitch(candidate, event) {
        const now = performance.now();
        dragMotion ||= { candidate: undefined, since: now, switchedAt: -Infinity, switchedY: null };
        if (candidate !== dragMotion.candidate) {
            dragMotion.candidate = candidate;
            dragMotion.since = now;
        }
        if (now - dragMotion.switchedAt < PREVIEW_SETTLE_MS || !movedSinceSwitch(event)) return false;
        return now - dragMotion.since >= PREVIEW_DWELL_MS;
    }

    function noteSwitch(event) {
        dragMotion ||= { candidate: undefined, since: 0, switchedAt: -Infinity, switchedY: null };
        dragMotion.switchedAt = performance.now();
        dragMotion.switchedY = pointerY(event);
    }

    function isInsideList(node) {
        return node instanceof Node && Boolean(currentList?.contains(node) || newZone?.contains(node));
    }

    // 2026-10-11 공개 CSS: 치지직 사이드바 행 사이에는 3px 틈(._item + ._item margin-top)이 있어요. 목록 안의 틈이나
    // 채널이 아닌 행 위는 어느 대상도 아니므로 지금 대상을 그대로 둬요. 같은 폴더 안에서 움직일 때 깜빡이지 않게 해요.
    function isListGap(node) {
        if (!currentList?.contains(node) || newZone?.contains(node)) return false;
        const row = directChildOf(currentList, node);
        return !row || (!headerOwners.has(row) && !getRowInfo(row));
    }

    // 끄는 채널의 놓을 대상 후보: 화면에 보이는 자리 기준이며, 미리보기로 옮겨진 자기 행 위에서는 지금 대상을 유지한다.
    function channelCandidate(event) {
        if (!activeDrag) return null;
        // 새 폴더 자리 밖을 한 번이라도 지나야 그 자리가 놓기를 받는다.
        if (!newZone?.contains(event.target)) activeDrag.zoneReady = true;
        if (dropKey && activeDrag.row?.contains(event.target)) return dropKey;
        if (isListGap(event.target)) return dropKey;
        let key = dropKeyFor(event.target);
        if (key === NEW_DROP && !activeDrag.zoneReady) key = null;
        return key === currentDropKeyOf(activeDrag.channelId) ? null : key;
    }

    function folderCandidate(event) {
        if (!folderDrag) return null;
        if (isListGap(event.target)) return dropKey;
        const key = dropKeyFor(event.target);
        if (!key || key === NEW_DROP) return null;
        // 미리보기로 옮겨진 자기 폴더 위에서는 지금 미리보기를 유지한다.
        if (key === `f:${folderDrag.folderId}`) return folderDrag.command ? dropKey : null;
        return key;
    }

    function handleDragOver(event) {
        if (!folderDrag && !activeDrag) return;
        if (!event.isTrusted) return;
        // 사이드바 목록을 벗어나면 바로 원래대로 둔다. 막지 않으므로 다른 대상이 링크를 받을 수 있다.
        if (!isInsideList(event.target)) {
            if (dropKey !== null || preview) {
                if (folderDrag) setFolderPreview(null);
                else setDropKey(null);
                noteSwitch(event);
            }
            if (dragMotion) dragMotion.candidate = undefined;
            return;
        }
        const candidate = folderDrag ? folderCandidate(event) : channelCandidate(event);
        // 지금 대상으로 돌아오면 다른 후보의 머문 시간을 버린다. 남겨 두면 다음에 잠깐 스칠 때 오래 머문 것으로 보여요.
        if (candidate === dropKey && dragMotion) dragMotion.candidate = undefined;
        if (candidate !== dropKey && readyToSwitch(candidate, event)) {
            if (folderDrag) setFolderPreview(candidate);
            else setDropKey(candidate);
            noteSwitch(event);
        }
        // 미리보기가 따라오기 전에 놓아도 커서 밑 대상이 받도록 후보가 있으면 놓기를 허용한다.
        if (!candidate && !dropKey) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = folderDrag ? "move" : "link";
    }

    // 보이는 대상(미리보기)을 우선하고, 커서가 그 뒤 확실히 다른 대상으로 옮겨 갔을 때만 커서 밑 대상으로 놓는다.
    function resolveDropKey(candidate, event) {
        if (dropKey && (!candidate || candidate === dropKey || !movedSinceSwitch(event))) return dropKey;
        return candidate;
    }

    function handleDrop(event) {
        if (folderDrag) {
            handleFolderDrop(event);
            return;
        }
        const drag = activeDrag;
        if (!drag || !isInsideList(event.target)) return;
        const key = resolveDropKey(channelCandidate(event), event);
        if (!key || (key === NEW_DROP && !drag.zoneReady)) return;
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        const spring = springFolderId;
        if (key === currentDropKeyOf(drag.channelId)) {
            clearDrag();
            return;
        }
        // 끄는 동안 목록 새로고침으로 행이 재사용됐으면 현재 링크가 다른 채널일 수 있다.
        const current = drag.link.isConnected ? parseChannelHref(drag.link.getAttribute("href") || "") : null;
        if (!current || current.channelId !== drag.channelId || !currentList?.contains(drag.link)) {
            clearDrag();
            notify("끄는 동안 팔로잉 목록이 바뀌어 폴더에 넣지 않았어요.", "error");
            return;
        }
        // 미리보기를 그대로 확정하므로 놓는 순간 화면이 튀지 않는다. 저장은 뒤에서 이어진다.
        clearDrag({ redraw: false });
        const channelName = drag.name;
        if (key === NEW_DROP) {
            createFolder({ channelId: drag.channelId, name: channelName }, drag.newFolder);
            return;
        }
        if (key === REST_DROP) {
            const folderId = folderOfChannel.get(drag.channelId);
            const folder = folderId ? getFolder(folderId) : null;
            if (folder)
                sendCommand(
                    { type: "unassign", folderId: folder.id, channelId: drag.channelId },
                    { success: `${channelName} 채널을 ‘${folder.name}’ 폴더에서 뺐어요.`, undoable: true }
                );
            else rebuildStates({ animate: true });
            return;
        }
        const folder = getFolder(key.slice(2));
        if (!folder || folder.channelIds.includes(drag.channelId)) {
            rebuildStates({ animate: true });
            return;
        }
        // 잠깐 펼쳐 보여 준 접힌 폴더에 놓았으면 펼친 상태로 남긴다.
        if (spring === folder.id && folder.collapsed) {
            releaseNativeExpandHold();
            sendCommand({ type: "setCollapsed", folderId: folder.id, collapsed: false });
        }
        sendCommand(
            { type: "assign", folderId: folder.id, channelId: drag.channelId },
            { success: `${channelName} 채널을 ‘${folder.name}’ 폴더에 넣었어요.`, undoable: true }
        );
    }

    function handleFolderDrop(event) {
        const drag = folderDrag;
        if (!isInsideList(event.target)) return;
        const key = resolveDropKey(folderCandidate(event), event);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted) {
            clearDrag();
            return;
        }
        if (key !== dropKey) setFolderPreview(key);
        const folder = getFolder(drag.folderId);
        const command = drag.command;
        clearDrag({ redraw: false });
        if (!folder || !command) {
            rebuildStates({ animate: true });
            return;
        }
        sendCommand(command, { success: `‘${folder.name}’ 폴더 순서를 바꿨어요.`, undoable: true });
    }

    // ── 떠 있는 메뉴·채널 선택·상태 안내 ───────────────────────────────────────────────
    function placeFloating(node, width, preferredHeight, anchorRect) {
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const viewportHeight = window.innerHeight;
        const sidebarRect = getSidebar()?.getBoundingClientRect() || anchorRect;
        const boxWidth = Math.max(0, Math.min(width, viewportWidth - 16));
        let left = 8;
        if (sidebarRect) {
            const sidebarOnRight = sidebarRect.left + sidebarRect.width / 2 > viewportWidth / 2;
            left = sidebarOnRight ? sidebarRect.left - 8 - boxWidth : sidebarRect.right + 8;
        }
        left = Math.max(8, Math.min(left, viewportWidth - boxWidth - 8));
        const height = Math.min(preferredHeight, Math.max(0, viewportHeight - 16));
        const top = Math.max(8, Math.min((anchorRect?.top || 8) - 6, viewportHeight - 8 - height));
        node.style.width = `${boxWidth}px`;
        node.style.left = `${Math.round(left)}px`;
        node.style.top = `${Math.round(top)}px`;
        node.style.maxHeight = `${Math.max(0, viewportHeight - top - 8)}px`;
    }

    function positionLayer() {
        if (!layer?.anchor?.isConnected) return;
        const rect = layer.anchor.getBoundingClientRect();
        const width = layer.kind === "picker" ? PICKER_WIDTH : MENU_WIDTH;
        placeFloating(layer.node, width, layer.kind === "picker" ? 480 : layer.node.offsetHeight || 240, rect);
        positionToast();
    }

    const TOAST_BOTTOM = 20;
    const TOAST_GAP = 12;

    function positionToast() {
        if (!toast) return;
        const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
        const sidebarRect = getSidebar()?.getBoundingClientRect();
        const width = Math.min(toast.offsetWidth || 280, viewportWidth - 16);
        const height = toast.offsetHeight || 48;
        let left = 8;
        if (sidebarRect) {
            const sidebarOnRight = sidebarRect.left + sidebarRect.width / 2 > viewportWidth / 2;
            left = sidebarOnRight ? sidebarRect.left - TOAST_GAP - width : sidebarRect.right + TOAST_GAP;
            // 2026-10-12 사용자 보고: 메뉴가 위쪽에 떠 있어도 안내가 옆으로 밀렸어요. 열린 메뉴·채널 선택 창과
            // 실제로 겹칠 때만 그 바깥으로 비켜요.
            const layerRect = layer?.node.isConnected ? layer.node.getBoundingClientRect() : null;
            const bottom = window.innerHeight - TOAST_BOTTOM;
            const top = bottom - height;
            const overlaps =
                layerRect &&
                layerRect.width > 0 &&
                layerRect.top < bottom + TOAST_GAP &&
                layerRect.bottom > top - TOAST_GAP &&
                layerRect.left < left + width + TOAST_GAP &&
                layerRect.right > left - TOAST_GAP;
            if (overlaps) left = sidebarOnRight ? layerRect.left - TOAST_GAP - width : layerRect.right + TOAST_GAP;
        }
        toast.style.left = `${Math.round(Math.max(8, Math.min(left, viewportWidth - width - 8)))}px`;
        toast.style.bottom = `${TOAST_BOTTOM}px`;
    }

    function reconnectLayerAnchor() {
        if (!layer) return false;
        let anchor = null;
        if (layer.folderId && presentationActive)
            anchor = currentList?.querySelector(
                `[${HEADER_ATTR}][data-bcff-folder-id="${layer.folderId}"] > .bcff-more`
            );
        if (!anchor) return false;
        layer.anchor = anchor;
        if (layer.kind === "menu") setAttr(anchor, "aria-expanded", "true");
        positionLayer();
        return true;
    }

    function closeLayer(restoreFocus) {
        if (!layer) return;
        const { node, anchor } = layer;
        if (layer.armTimer) clearTimeout(layer.armTimer);
        layer = null;
        node.remove();
        document.getElementById(LAYER_ID)?.remove();
        window.removeEventListener("resize", positionLayer);
        window.removeEventListener("scroll", positionLayer, true);
        document.removeEventListener("pointerdown", handleOutsidePointer, true);
        if (anchor) setAttr(anchor, "aria-expanded", "false");
        if (restoreFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
        positionToast();
    }

    function handleOutsidePointer(event) {
        if (!layer) return;
        const target = event.target;
        if (target instanceof Node && (layer.node.contains(target) || layer.anchor?.contains(target))) return;
        closeLayer(false);
    }

    function mountLayer(kind, anchor, folderId = "") {
        closeLayer(false);
        const node = el("section");
        node.id = LAYER_ID;
        node.dataset.kind = kind;
        node.tabIndex = -1;
        layer = { kind, anchor, folderId, node, armedDelete: false, armTimer: 0, filter: "" };
        node.addEventListener("keydown", handleLayerKeyDown);
        node.addEventListener("keyup", (event) => {
            if (event.target instanceof HTMLInputElement) event.stopPropagation();
        });
        document.body.append(node);
        window.addEventListener("resize", positionLayer);
        window.addEventListener("scroll", positionLayer, true);
        document.addEventListener("pointerdown", handleOutsidePointer, true);
        setAttr(anchor, "aria-expanded", "true");
        return node;
    }

    function handleLayerKeyDown(event) {
        if (!layer) return;
        if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            closeLayer(true);
            return;
        }
        if (event.target instanceof HTMLInputElement) {
            // 입력 중인 글자가 치지직 페이지 단축키로 전달되지 않게 한다.
            event.stopPropagation();
            return;
        }
        if (layer.kind !== "menu" || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = Array.from(layer.node.querySelectorAll("button:not(:disabled)"));
        if (!items.length) return;
        const index = items.indexOf(document.activeElement);
        let next = 0;
        if (event.key === "ArrowDown") next = index < 0 ? 0 : (index + 1) % items.length;
        else if (event.key === "ArrowUp") next = index <= 0 ? items.length - 1 : index - 1;
        else if (event.key === "End") next = items.length - 1;
        event.preventDefault();
        items[next].focus();
    }

    function trusted(handler) {
        return (event) => {
            event.preventDefault();
            if (!event.isTrusted) return;
            handler(event);
        };
    }

    function layerButton(className, icon, text, label, key, onClick, { disabled = false, role = "" } = {}) {
        const button = el("button", className);
        button.type = "button";
        if (icon) button.innerHTML = ICONS[icon];
        if (text) button.append(el("span", "", text));
        if (label && label !== text) button.setAttribute("aria-label", label);
        if (role) button.setAttribute("role", role);
        button.setAttribute(KEY_ATTR, key);
        button.disabled = disabled;
        button.addEventListener("click", trusted(onClick));
        return button;
    }

    function handleMoreClick(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted) return;
        const anchor = event.currentTarget;
        const folder = folderOfHeaderControl(anchor);
        if (!folder) return;
        if (layer?.kind === "menu" && layer.folderId === folder.id) {
            closeLayer(true);
            return;
        }
        openMenu(folder, anchor);
    }

    function openMenu(folder, anchor) {
        mountLayer("menu", anchor, folder.id);
        layer.node.setAttribute("role", "menu");
        layer.node.setAttribute("aria-label", `‘${folder.name}’ 폴더 메뉴`);
        renderMenu();
        positionLayer();
        layer.node.querySelector("button:not(:disabled)")?.focus({ preventScroll: true });
    }

    function renderMenu() {
        const folder = getFolder(layer.folderId);
        if (!folder) {
            closeLayer(false);
            return;
        }
        const focused = document.activeElement;
        const focusKey = layer.node.contains(focused) ? focused.getAttribute(KEY_ATTR) : "";
        const index = folderPosition.get(folder.id);
        const armed = layer.armedDelete;
        const separator = () => {
            const line = el("div", "bcff-separator");
            line.setAttribute("role", "separator");
            return line;
        };
        const rename = layerButton(
            "bcff-item",
            "pen",
            "이름 변경",
            `‘${folder.name}’ 폴더 이름 변경`,
            `folder:${folder.id}:rename`,
            () => startRename(folder.id),
            { role: "menuitem" }
        );
        rename.append(el("kbd", "", "F2"));
        const remove = layerButton(
            "bcff-item bcff-danger",
            "trash",
            armed ? "한 번 더 눌러 삭제" : "폴더 삭제",
            armed
                ? `‘${folder.name}’ 폴더 삭제 확인. 한 번 더 누르면 지정만 지우고 팔로우는 그대로예요`
                : `‘${folder.name}’ 폴더 삭제`,
            `folder:${folder.id}:delete`,
            () => {
                if (!layer.armedDelete) {
                    layer.armedDelete = true;
                    layer.armTimer = setTimeout(() => {
                        if (!layer) return;
                        layer.armTimer = 0;
                        layer.armedDelete = false;
                        renderMenu();
                    }, DELETE_CONFIRM_MS);
                    renderMenu();
                    focusLayerKey(`folder:${folder.id}:delete`);
                    return;
                }
                closeLayer(false);
                const at = folderPosition.get(folder.id);
                const neighbor = folderState.folders[at + 1] || folderState.folders[at - 1] || null;
                sendCommand(
                    { type: "delete", folderId: folder.id },
                    { success: `‘${folder.name}’ 폴더를 지웠어요. 팔로우는 그대로예요.`, undoable: true }
                );
                // 지운 폴더의 머리 행은 사라지므로 초점은 옆 폴더 이름으로, 마지막 폴더였으면 팔로잉 새로고침으로 옮긴다.
                const next = neighbor
                    ? currentList?.querySelector(`[${HEADER_ATTR}][data-bcff-folder-id="${neighbor.id}"] > .bcff-name`)
                    : findRefreshButton(currentSection);
                next?.focus({ preventScroll: true });
            },
            { role: "menuitem" }
        );
        if (armed) remove.setAttribute("data-armed", "");
        layer.node.replaceChildren(
            rename,
            layerButton(
                "bcff-item",
                "list",
                "채널 선택…",
                `‘${folder.name}’ 폴더 채널 선택`,
                `folder:${folder.id}:picker`,
                () => openPicker(folder.id),
                { role: "menuitem" }
            ),
            separator(),
            layerButton(
                "bcff-item",
                "up",
                "위로 이동",
                `‘${folder.name}’ 폴더를 위로 이동`,
                `folder:${folder.id}:up`,
                () => moveFolder(folder.id, -1),
                { disabled: index === 0, role: "menuitem" }
            ),
            layerButton(
                "bcff-item",
                "down",
                "아래로 이동",
                `‘${folder.name}’ 폴더를 아래로 이동`,
                `folder:${folder.id}:down`,
                () => moveFolder(folder.id, 1),
                { disabled: index === folderState.folders.length - 1, role: "menuitem" }
            ),
            separator(),
            layerButton(
                "bcff-item",
                "newFolder",
                "새 폴더 만들기",
                "새 폴더 만들기",
                `folder:${folder.id}:new`,
                () => {
                    closeLayer(false);
                    createFolder();
                },
                { disabled: folderState.folders.length >= MAX_FOLDERS, role: "menuitem" }
            ),
            remove
        );
        if (focusKey && !focusLayerKey(focusKey)) layer.node.focus({ preventScroll: true });
        return layer;
    }

    function focusLayerKey(key) {
        const target = Array.from(layer?.node.querySelectorAll(`[${KEY_ATTR}]`) || []).find(
            (node) => node.getAttribute(KEY_ATTR) === key && !node.disabled
        );
        target?.focus({ preventScroll: true });
        return Boolean(target);
    }

    function moveFolder(folderId, offset) {
        const folder = getFolder(folderId);
        if (!folder) return;
        const keepMenu = layer?.kind === "menu" && layer.folderId === folderId;
        sendCommand(
            { type: "move", folderId, offset },
            {
                success: `‘${folder.name}’ 폴더를 ${offset < 0 ? "위로" : "아래로"} 옮겼어요.`,
                undoable: true,
                onSuccess: () => {
                    if (!keepMenu || layer?.kind !== "menu" || layer.folderId !== folderId) return;
                    renderMenu();
                    if (!focusLayerKey(`folder:${folderId}:${offset < 0 ? "up" : "down"}`))
                        focusLayerKey(`folder:${folderId}:${offset < 0 ? "down" : "up"}`);
                },
            }
        );
    }

    // 키보드·화면 낭독기 경로: 지금 목록에 보이는 채널을 체크해 이 폴더로 옮기거나 체크를 풀어 뺀다.
    function openPicker(folderId) {
        const folder = getFolder(folderId);
        const anchor =
            currentList?.querySelector(`[${HEADER_ATTR}][data-bcff-folder-id="${folderId}"] > .bcff-more`) ||
            layer?.anchor;
        if (!folder || !anchor) return;
        const node = mountLayer("picker", anchor, folderId);
        node.setAttribute("role", "dialog");
        node.setAttribute("aria-modal", "false");
        const top = el("div", "bcff-picker-top");
        const title = el("h2");
        title.id = `${LAYER_ID}-title`;
        node.setAttribute("aria-labelledby", title.id);
        const close = layerButton("bcff-icon-button", "close", "", "채널 선택 닫기", "picker-close", () =>
            closeLayer(true)
        );
        top.append(title, close);
        const search = el("label", "bcff-search");
        search.innerHTML = ICONS.search;
        const input = el("input");
        input.type = "search";
        input.autocomplete = "off";
        input.placeholder = "채널 이름으로 찾기";
        input.setAttribute("aria-label", "채널 이름으로 찾기");
        input.setAttribute(KEY_ATTR, "picker-filter");
        input.addEventListener("input", () => {
            if (!layer || layer.kind !== "picker") return;
            layer.filter = input.value;
            renderPicker();
        });
        search.append(input);
        const list = el("ul", "bcff-picks");
        const foot = el(
            "p",
            "bcff-picker-foot",
            "체크하면 이 폴더로 옮겨요. 다른 폴더에 있던 채널은 그 폴더에서 빠져요. 지금 목록에 보이는 채널만 보여요."
        );
        node.append(top, search, list, foot);
        layer.title = title;
        layer.list = list;
        renderPicker();
        positionLayer();
        input.focus({ preventScroll: true });
    }

    function collectChannels() {
        const channels = [];
        const seen = new Set();
        for (const child of currentList ? Array.from(currentList.children) : []) {
            const info = getRowInfo(child);
            if (!info || !isValidChannelId(info.channelId) || seen.has(info.channelId)) continue;
            seen.add(info.channelId);
            const name = getRowName(child, info);
            rememberChannel(info.channelId, name);
            channels.push({ channelId: info.channelId, name, isLive: info.isLive, image: getRowImage(child) });
        }
        return channels;
    }

    function renderPicker() {
        if (layer?.kind !== "picker") return;
        const folder = getFolder(layer.folderId);
        if (!folder) {
            closeLayer(false);
            return;
        }
        const focused = document.activeElement;
        const focusKey = layer.node.contains(focused) ? focused.getAttribute(KEY_ATTR) : "";
        layer.title.textContent = `‘${folder.name}’ 폴더 채널`;
        const term = normSpace(layer.filter || "").toLowerCase();
        const channels = collectChannels();
        const visible = new Set(channels.map((channel) => channel.channelId));
        // 이 폴더에 있지만 지금 목록에 없는 채널도 뺄 수 있게 이름만 보여 준다.
        for (const channelId of folder.channelIds) {
            if (visible.has(channelId)) continue;
            const known = knownChannels.get(channelId);
            channels.push({
                channelId,
                name: known?.name || `현재 목록에 없는 채널 (${channelId.slice(0, 8)})`,
                // 지금 목록에 없으면 방송 여부를 모르므로 오프라인으로 단정하지 않아요.
                isLive: null,
                image: "",
            });
        }
        channels.sort(
            (left, right) =>
                Number(right.isLive === true) - Number(left.isLive === true) ||
                left.name.localeCompare(right.name, "ko")
        );
        const items = channels
            .filter((channel) => !term || channel.name.toLowerCase().includes(term))
            .map((channel) => buildPick(folder, channel));
        if (!items.length)
            items.push(el("li", "bcff-picker-empty", term ? "찾는 채널이 없어요." : "목록에 채널이 없어요."));
        layer.list.replaceChildren(...items);
        if (focusKey && focusKey !== "picker-filter") focusLayerKey(focusKey);
    }

    function buildPick(folder, channel) {
        const item = el("li");
        const inFolder = folder.channelIds.includes(channel.channelId);
        const otherId = folderOfChannel.get(channel.channelId);
        const other = otherId && otherId !== folder.id ? getFolder(otherId) : null;
        const label = inFolder
            ? `${channel.name} 채널을 ‘${folder.name}’ 폴더에서 빼기`
            : `${channel.name} 채널을 ‘${folder.name}’ 폴더에 넣기`;
        const button = layerButton("bcff-pick", "", "", label, `pick:${folder.id}:${channel.channelId}`, () => {
            const latest = getFolder(folder.id);
            if (!latest) return;
            if (latest.channelIds.includes(channel.channelId))
                sendCommand(
                    { type: "unassign", folderId: latest.id, channelId: channel.channelId },
                    { success: `${channel.name} 채널을 ‘${latest.name}’ 폴더에서 뺐어요.`, undoable: true }
                );
            else
                sendCommand(
                    { type: "assign", folderId: latest.id, channelId: channel.channelId },
                    { success: `${channel.name} 채널을 ‘${latest.name}’ 폴더에 넣었어요.`, undoable: true }
                );
        });
        button.setAttribute("aria-pressed", String(inFolder));
        const liveState = channel.isLive === true ? "1" : channel.isLive === false ? "0" : "unknown";
        button.dataset.live = liveState;
        const avatar = el("span", "bcff-avatar");
        avatar.setAttribute("aria-hidden", "true");
        if (channel.image) {
            const image = el("img");
            image.alt = "";
            image.loading = "lazy";
            image.decoding = "async";
            image.referrerPolicy = "no-referrer";
            image.addEventListener("error", () => image.replaceWith(Array.from(channel.name)[0] || ""), {
                once: true,
            });
            image.src = channel.image;
            avatar.append(image);
        } else avatar.textContent = Array.from(channel.name)[0] || "";
        const info = el("span", "bcff-pick-info");
        const detail = el(
            "span",
            "bcff-pick-detail",
            liveState === "1" ? "방송 중" : liveState === "0" ? "오프라인" : "목록에 없어 방송 여부 모름"
        );
        detail.dataset.live = liveState;
        if (other) detail.textContent += ` · ‘${other.name}’에 있음`;
        info.append(el("span", "bcff-pick-name", channel.name), detail);
        const check = el("span", "bcff-check");
        check.innerHTML = ICONS.check;
        button.append(avatar, info, check);
        item.append(button);
        return item;
    }

    function renderLayer() {
        if (layer?.kind === "picker") renderPicker();
        else if (layer?.kind === "menu") renderMenu();
    }

    // ── 안내와 되돌리기 ───────────────────────────────────────────────────────────────
    function removeToast() {
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = 0;
        toast?.remove();
        toast = null;
        document.getElementById(TOAST_ID)?.remove();
        window.removeEventListener("resize", positionToast);
    }

    function startToastTimer() {
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => {
            toastTimer = 0;
            if (toast?.matches(":hover, :focus-within")) {
                startToastTimer();
                return;
            }
            removeToast();
        }, TOAST_MS);
    }

    function showToast(text, kind, withUndo) {
        removeToast();
        if (!document.body) return;
        toast = el("div");
        toast.id = TOAST_ID;
        toast.dataset.kind = kind;
        toast.setAttribute("role", "status");
        toast.setAttribute("aria-live", "polite");
        toast.append(el("span", "bcff-toast-text", text));
        if (withUndo && undo) {
            const button = el("button", "", "되돌리기");
            button.type = "button";
            button.setAttribute(KEY_ATTR, "undo");
            button.addEventListener("click", trusted(runUndo));
            toast.append(button);
        }
        const bar = el("span", "bcff-toast-bar");
        bar.setAttribute("aria-hidden", "true");
        toast.append(bar);
        document.body.append(toast);
        positionToast();
        window.addEventListener("resize", positionToast);
        startToastTimer();
    }

    function notify(text, kind, withUndo = false) {
        if (!text) return;
        showToast(text, kind, withUndo);
    }

    // 되돌리기는 화면이 그 변경 직후 상태 그대로일 때만 보낸다. 다른 곳에서 바뀌었으면 덮어쓰지 않는다.
    function runUndo() {
        const record = undo;
        undo = null;
        removeToast();
        if (!record || optimistic.length || !statesEqual(confirmedState, record.next)) {
            notify(ERROR_MESSAGES["undo-conflict"], "error");
            return;
        }
        const previous = parseStoredValue(record.previous);
        if (!previous.ok) return;
        sendCommand({ type: "restore", state: previous.state }, { success: "되돌렸어요." });
    }

    function isEnterSubmit(event) {
        return (
            event.key === "Enter" &&
            event.isTrusted &&
            !event.isComposing &&
            event.keyCode !== 229 &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.shiftKey
        );
    }

    // ── 수명 ───────────────────────────────────────────────────────────────────────
    function handlePageHide() {
        clearDrag();
        clearClickTimer();
        closeLayer(false);
        removeToast();
        renaming = null;
        undo = null;
    }

    function handlePageShow(event) {
        // BFCache 동안 놓친 storage.onChanged가 있을 수 있어 복귀 때 다시 읽는다.
        if (!event.persisted) return;
        if (foldersActive) loadFolderState();
        scheduleSync();
    }

    function startFolders() {
        if (foldersActive) return;
        foldersActive = true;
        foldersGeneration += 1;
        stateStatus = "loading";
        removeStorageListener = folderStore.subscribe(handleStoredChange);
        window.addEventListener("dragstart", handleDragStart, true);
        window.addEventListener("dragend", handleDragEnd, true);
        window.addEventListener("dragenter", handleDragOver, true);
        window.addEventListener("dragover", handleDragOver, true);
        window.addEventListener("drop", handleDrop, true);
        window.addEventListener("click", handleNativeListClick, true);
        loadFolderState();
    }

    function stopFolders() {
        if (!foldersActive) return;
        foldersActive = false;
        foldersGeneration += 1;
        lastRawValue = undefined;
        removeStorageListener?.();
        removeStorageListener = null;
        window.removeEventListener("dragstart", handleDragStart, true);
        window.removeEventListener("dragend", handleDragEnd, true);
        window.removeEventListener("dragenter", handleDragOver, true);
        window.removeEventListener("dragover", handleDragOver, true);
        window.removeEventListener("drop", handleDrop, true);
        window.removeEventListener("click", handleNativeListClick, true);
        releaseNativeExpandHold();
        clearDrag();
        clearClickTimer();
        closeLayer(false);
        removeToast();
        removeStatusRow();
        renaming = null;
        undo = null;
        stateStatus = "idle";
        optimistic = [];
        confirmedState = cloneState(EMPTY_STATE);
        folderState = cloneState(EMPTY_STATE);
        viewState = cloneState(EMPTY_STATE);
        folderOfChannel = new Map();
        folderPosition = new Map();
        viewFolderOf = new Map();
        viewPosition = new Map();
        viewCollapsed = new Set();
    }

    function ensureStyle() {
        BetterChzzk.utils.ensureUiTheme?.();
        const existing = document.getElementById(STYLE_ID);
        if (existing && existing.textContent !== STYLE_TEXT) existing.remove();
        injectStyleOnce(STYLE_ID, STYLE_TEXT);
    }

    function installRuntime() {
        if (runtimeInstalled) return;
        runtimeInstalled = true;
        ensureStyle();
        // 재주입 전 문서에 남은 예전 새 폴더 버튼을 지워요.
        document.querySelectorAll(`[${LEGACY_MANAGE_ATTR}]`).forEach((node) => node.remove());
        removeRouteListener = startPageChangeDetection(scheduleSync);
        observer = createMutationObserverSync({
            target: getSidebar,
            options: {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ["href", PIN_GROUP_ATTR],
            },
            onMutations: handleMutations,
            onObserved: syncAll,
            onBodyReady: syncAll,
        });
    }

    function uninstallRuntime() {
        if (!runtimeInstalled) return;
        runtimeInstalled = false;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        observer?.disconnectAll?.();
        observer = null;
        removeRouteListener?.();
        removeRouteListener = null;
        presentationActive = false;
        removeNewZone();
        if (currentList) cleanupList(currentList);
        releaseBusy();
        currentList = null;
        currentSection = null;
        document.querySelectorAll(`[${HEADER_ATTR}], [${NEW_ZONE_ATTR}]`).forEach(removeHeader);
        document.querySelectorAll(`[${LIST_ATTR}], [${MAX_ROWS_ATTR}]`).forEach(cleanupList);
        document.querySelectorAll(`[${ORDER_ATTR}], [${HIDDEN_ATTR}], [${CHANNEL_ATTR}]`).forEach(clearRowMarks);
        removeStatusRow();
        document.querySelectorAll(`[${LEGACY_MANAGE_ATTR}], [${STATUS_ATTR}]`).forEach((node) => node.remove());
        setRowsStyle("");
        document.getElementById(STYLE_ID)?.remove();
    }

    function applyOptions(options) {
        featureOptions = options;
        const wantFolders = options.followingFoldersEnabled === true;
        const wantRuntime = wantFolders || options.followingListMaxRows > 0;
        if (wantRuntime) installRuntime();
        if (wantFolders) startFolders();
        else stopFolders();
        if (!wantRuntime) {
            uninstallRuntime();
            return;
        }
        syncAll();
    }

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    bindFeatureOptions(applyOptions);
})();
