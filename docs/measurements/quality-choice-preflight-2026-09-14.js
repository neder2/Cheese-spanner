// 치지직 라이브 페이지의 개발자도구 Console에서 직접 실행하는 읽기 전용 진단이에요.
// 재생 설정 변경, 이벤트 차단, 네트워크 요청, 쿠키·저장소 조회를 하지 않아요.
// 영상 URL의 경로·쿼리와 채팅·계정 정보는 출력하지 않아요.
(() => {
    "use strict";

    if (location.hostname !== "chzzk.naver.com" || !/^\/live\//.test(location.pathname)) {
        console.warn("치지직 라이브 방송 페이지에서 실행해 주세요.");
        return;
    }

    const videos = Array.from(document.querySelectorAll("video"));
    const video =
        videos.find((item) => item.matches(".webplayer-internal-video")) ??
        videos.find((item) => item.videoWidth > 0) ??
        null;
    const ancestors = [];
    for (let node = video?.parentElement; node && ancestors.length < 8; node = node.parentElement) {
        ancestors.push({ tag: node.tagName, class: node.getAttribute("class") || "" });
    }

    const result = {
        probe: "quality-choice-preflight-2026-09-14",
        measuredAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        platform: navigator.userAgentData?.platform || navigator.platform,
        videoCount: videos.length,
        video: video
            ? {
                  width: video.videoWidth,
                  height: video.videoHeight,
                  paused: video.paused,
                  readyState: video.readyState,
                  errorCode: video.error?.code ?? null,
                  sourceType: video.currentSrc.startsWith("blob:") ? "blob" : video.currentSrc ? "url" : "none",
              }
            : null,
        gridBypassState: document.documentElement.getAttribute("data-betterchzzk-grid-bypass-state"),
        gridBypassReady: document.documentElement.getAttribute("data-betterchzzk-grid-bypass-page-ready"),
        knownGridParseWrapper: JSON.parse.__betterChzzkGridBypassParseWrapped === true,
        layoutCount: document.querySelectorAll("pzp-pc-layout").length,
        qualityPaneCount: document.querySelectorAll(
            "pzp-setting-quality-pane, pzp-pc-setting-quality-pane, pzp-setting-quality"
        ).length,
        qualityItemCount: document.querySelectorAll(".pzp-ui-setting-quality-item").length,
        videoAncestors: ancestors,
        entryScripts: Array.from(document.querySelectorAll("script[src]"))
            .map((script) => script.src)
            .filter((url) => url.startsWith("https://ssl.pstatic.net/static/nng/glive/resource/"))
            .map((url) => url.split(/[?#]/)[0]),
    };

    console.log(JSON.stringify(result, null, 2));
})();
