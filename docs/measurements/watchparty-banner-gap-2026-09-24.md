# 치즈 스패너 같이보기 고정 제목 여백 — 2026-09-24

## 실측과 원인

- 작업 기준: `main`, HEAD `ea22dfc`, 버전 `1.4.0`. 기존 미추적 문서 `docs/feature-expansion-proposal.md`는 수정하지 않았다.
- Chrome의 기존 `https://chzzk.naver.com/watchparty/535` 탭에서 스크롤된 상태를 읽기 전용으로 측정했다.
- `#header` 바로 앞의 상단 홍보 영역(`data-nlog-area="home_top_skin"`)은 `position: fixed`, inline `display: none !important` 상태였다. 숨김을 적용한 프로그램은 확인하지 않았다.
- 헤더 inline transform은 `translateY(51px)`이지만 computed transform은 `none`, 실제 아래쪽 좌표는 60px이었다.
- 본문의 `> div > section > div._header_1xpex_20._is_sticky_1xpex_31`은 `position: sticky`, inline 및 computed top이 111px이었다. 실제 제목 위쪽 좌표도 111px으로 헤더 아래에 51px 틈이 남았다.
- 배너 자체의 빈 컨테이너가 아니라, 숨김 이후에도 제목의 고정 위치에 남아 있는 배너 높이가 원인이다. 당시 픽셀값은 런타임 상수로 사용하지 않는다.

## 변경과 검증 범위

- 기존 `headerBannerLayout.js`에서 확인된 상단 배너가 숨겨지고 헤더 transform이 초기화된 같이보기 경로에만 실제 헤더 아래쪽 좌표를 CSS 변수로 제공한다.
- 실측한 제목 구조와 sticky 클래스에만 적용한다. 원본 inline top은 보존하며, 제목 재마운트는 CSS로 처리한다. 헤더 크기 변화는 기존 ResizeObserver로 함께 관찰한다.
- 배너 복원·제거, 다른 경로 이동, 페이지 종료 시 보정과 변수를 제거한다. 별도 타이머·본문 전체 DOM 감시·네트워크 요청은 추가하지 않는다.
- 회귀 테스트는 실제 헤더 높이 반영, 원본 top 보존, 제목 교체, 배너 복원·제거, SPA 경로 변경을 확인한다. JSDOM의 var() 선언 우선순위 처리 한계로 선택자 매칭·변수·스타일 선언을 검증하며 실제 픽셀 렌더링 검증과 구분한다.
- 수정 후 실브라우저 검증은 미완료다. 브라우저 도구가 `chrome://extensions/` 접근을 보안 정책으로 차단해 확장을 다시 로드하지 못했다. 우회하지 않았다. 라이트·다크 화면, 새로고침 후 실제 주입, 수정 후 콘솔 상태는 확인하지 못했다.
- 수동 확인: 확장 관리에서 치즈 스패너를 다시 로드하고 같이보기 탭을 새로고침한 뒤, 스크롤 시 고정 제목이 헤더 바로 아래에 붙는지 확인한다. 상단 배너가 보일 때는 기존 배치를 유지하는지, 다른 페이지로 이동하면 보정이 남지 않는지도 확인한다.
