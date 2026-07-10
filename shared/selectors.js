/**
 * shared/selectors.js — 치지직 의존 DOM 셀렉터 단일 공급원 (BetterChzzk.selectors)
 *
 * 실행 컨텍스트: isolated world 콘텐츠 스크립트 전용. shared/data.js 다음, content.js 이전에 로드된다.
 *   MAIN world 스크립트(routeBridgePage/autoQualityPage/volumeWheelPage)는 별도 world라 여기 접근 불가.
 * 하는 일:
 *   - CHZZK: 치지직 비공개 클래스에 의존하는 셀렉터 폴백 체인의 레지스트리.
 *     각 항목은 배열이며 **앞에서부터 순서대로 시도**한다. 쉼표 결합 CSS 목록으로 바꾸면
 *     "체인 우선순위"가 "DOM 등장 순서"로 바뀌어 의미가 달라지므로 금지.
 *   - queryChain/queryChainAll: 체인을 순서대로 시도하는 조회 헬퍼.
 *   - watchSelector: 앵커 셀렉터가 일정 시간 내에 매치되지 않으면 콘솔 경고 1회
 *     (치지직 리뉴얼로 셀렉터가 실효됐을 때 조기 감지용).
 * 진행 상태: docs/stability-roadmap.md 1단계. 아래 체인은 2026-07-07 features/* 실측(grep)에서
 *   수집한 씨앗이다. feature 파일을 한 파일씩 이 레지스트리 참조로 치환하면서, 실제 사용처와
 *   대조해 체인 순서·구성을 확정하고 사용처 주석을 갱신할 것. 치환 전까지는 dead code여도 정상.
 * 제외 대상: 자기 소유 클래스(.bcmb-*, .bcfp-* 등)와 data-* 속성 셀렉터는 치지직 의존이 아니므로
 *   여기 등록하지 않는다.
 */
(() => {
    "use strict";

    const root = typeof window !== "undefined" ? window : globalThis;
    const ns = (root.BetterChzzk = root.BetterChzzk || {});
    if (ns.selectors) return;

    // 치지직 비공개 클래스 의존 폴백 체인. 앞 항목이 더 구체적/우선.
    const CHZZK = {
        // ── 플레이어 (사용처: volumeTooltip, volumeWheelPage, skipControl, autoQuality 계열)
        playerRoot: ["[class*='pzp-pc']", "[class*='pzp']", "[class*='video_player']", "[class*='player']"],
        playerBottomButtons: ["[class*='bottom-buttons']"],
        playerPlaybackSwitch: ["[class*='playback-switch']"],
        volumeControl: ["[class*='volume-control']", "[class*='volume-button']", "[class*='volume']"],
        volumeSlider: ["[class*='slider']"],

        // ── 채팅 (사용처: chatTools, vodReplayChatFix)
        chatRoot: [
            "[class*='chatroom']",
            "[class*='chat-room']",
            "[class*='chatting_area']",
            "[class*='chat_area']",
            "[class*='live_chatting']",
            "[class*='chatting']",
            "[class*='chat']",
        ],
        // 주의: closest() 행 탐색은 chatRoot 자체에 매치될 수 있다
        // (고정공지 방송의 _exist_fixed_message_ 사례). 루트 도달 가드를 유지할 것.
        chatRow: ["[class*='row']", "[class*='item']", "[class*='message']", "[class*='comment']"],
        chatNickname: ["[class*='nickname']", "[class*='nick']", "[class*='author']", "[class*='name']"],
        chatText: ["[class*='message']", "[class*='content']", "[class*='text']", "[class*='comment']"],
        chatBadge: [
            "[class*='icon']",
            "[class*='Icon']",
            "[class*='dot']",
            "[class*='Dot']",
            "[class*='badge']",
            "[class*='Badge']",
        ],

        // ── 제목/채널 (사용처: titleTooltip, followingPreviewTooltip, videoSearch)
        liveTitle: ["[class*='live_title']", "[class*='liveTitle']", "[class*='title_text']", "[class*='title']"],
        vodTitle: [
            "[class*='vod_title']",
            "[class*='video_information_title']",
            "[class*='video-info-title']",
            "[class*='videoInfoTitle']",
            "[class*='VideoInfo_title']",
        ],
        channelName: [
            "[class*='name_text']",
            "[class*='channel_name']",
            "[class*='channelName']",
            "[class*='nickname']",
            "[class*='name']",
        ],
        thumbnail: ["[class*='thumb']", "[class*='thumbnail']", "[class*='live_image']", "[class*='liveImage']"],

        // ── 사이드바/팔로잉 (사용처: followingPreviewTooltip, followingRefresh)
        sidebar: ["[class*='sidebar']", "[class*='side_bar']", "[class*='aside']", "[class*='navigation']"],
        followingItem: ["[class*='following']", "[class*='follow']"],
        liveStatus: ["[class*='live-status']", "[class*='LiveStatus']"],
        liveButton: ["[class*='live-button']", "[class*='LiveButton']"],
        liveTime: ["[class*='live_time']", "[class*='live-time']", "[class*='LiveTime']"],

        // ── 목록/필터/페이징 (사용처: categoryTools)
        categoryFilterBar: ["[class*='navigation_component_filter']"],
        pagination: [
            "[class*='Pagination']",
            "[class*='Paging']",
            "[class*='pagination' i]",
            "[class*='paginator' i]",
            "[class*='paging' i]",
        ],

        // ── 시청 기록 표시 (사용처: liveWatchHistory 또는 videoSearch — 치환 시 확정)
        watchProgress: [
            "[class*='progress' i]",
            "[class*='history' i]",
            "[class*='played' i]",
            "[class*='playback' i]",
            "[class*='resume' i]",
        ],

        // ── 팝업/오버레이 (사용처: adblockPopup, shortcutRescue)
        popupContainer: [".popup_container__Aqx-3", "[class^='popup_container__']", "[class*=' popup_container__']"],
        popupDimmed: [
            ".popup_dimmed__zs78t",
            "[class^='popup_dimmed__']",
            "[class*=' popup_dimmed__']",
            "[class*='dimmed']",
            "[class*='backdrop']",
            "[class*='overlay']",
        ],

        // ── 테마 (사용처: 4개 feature — 총 19회 반복되던 판정의 단일화 지점)
        darkTheme: ['[class*="dark"]'],
    };

    // 체인을 앞에서부터 시도해 첫 매치를 돌려준다.
    const queryChain = (scope, chain) => {
        for (const sel of chain) {
            const found = scope.querySelector(sel);
            if (found) return found;
        }
        return null;
    };

    // 체인을 앞에서부터 시도해 첫 번째로 결과가 나온 셀렉터의 NodeList를 배열로 돌려준다.
    const queryChainAll = (scope, chain) => {
        for (const sel of chain) {
            const found = scope.querySelectorAll(sel);
            if (found.length) return Array.from(found);
        }
        return [];
    };

    // 앵커 셀렉터 자가 진단: 기능이 "이 요소는 지금 반드시 있어야 한다"고 판단한 시점에 호출.
    // timeoutMs 내 매치 실패 시 키당 1회만 경고한다. 기능 생사를 가르는 앵커에만 쓸 것.
    const warned = new Set();
    const watchSelector = (key, scope = document, timeoutMs = 15000) => {
        const chain = CHZZK[key];
        if (!chain || warned.has(key)) return;
        const check = () => {
            if (queryChain(scope, chain)) return;
            if (warned.has(key)) return;
            warned.add(key);
            console.warn(
                `[Better Chzzk] selector stale: ${key} — 치지직 DOM 변경 가능성. shared/selectors.js 확인 필요.`
            );
        };
        setTimeout(check, timeoutMs);
    };

    ns.selectors = { CHZZK, queryChain, queryChainAll, watchSelector };
})();
