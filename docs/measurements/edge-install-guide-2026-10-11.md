# Edge 고화질 설치 안내 실측과 자동 닫기 확인 — 2026-10-11

상태: **안내 변형 실측 완료 · 수정본 Edge 임시 프로필 확인 완료 · 사용자 실제 Edge 확인 보고(2026-10-11, 설치 안내 안 뜸).** 다른 확장 동시 사용 상태와 확장을 로드한 Chrome 확인은 남아 있어요.

## 배경과 환경

2026-10-10 스토어 리뷰(Elma)와 2026-10-11 사용자 재현에서 Edge는 `시청 방해 팝업 제거`를 켜도 설치 권유 안내가 남았어요. 이전 세션은 Edge가 없는 환경이라 [진단 스크립트](edge-popup-diagnostic-2026-10-11.js)만 추가했어요.

- 환경: Windows 11, Microsoft Edge 155.0.4283.45, Google Chrome 155.0.8059.39. 각 브라우저를 스크래치 폴더의 임시 `--user-data-dir`과 `--remote-debugging-port`로 띄우고 Node 24의 전역 `WebSocket`으로 CDP(`Page.navigate`, `Runtime.evaluate`, `Page.captureScreenshot`)를 호출했어요. 사용자의 실제 프로필·로그인·설정은 쓰지 않았고, 측정 뒤 임시 프로필 프로세스만 종료했어요.
- 확장: 이 작업 트리(`1.4.3` 브랜치, 커밋 `e73370b` 기준)를 `--load-extension`으로 로드했어요. Edge는 로드했고(확장 ID `oijgeclpcafhkbaameifdomjononepol`), Chrome 155는 플래그를 무시해 확장 없이 측정했어요.
- 대상: `https://chzzk.naver.com/live/b044e3a3b9259246bc92e863e7d3f3b8`(비성인 talk 라이브, 약 8,700명 시청 중). 읽기 전용 프로브는 [진단 스크립트](edge-popup-diagnostic-2026-10-11.js)와 같은 선택자에 확장 상태 속성·video 정보를 더한 것이며 클릭·저장·요청을 하지 않았어요.

## 1. 수정 전 Edge 실측 — 14:58 KST

- UA `... Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0`, Client Hints 브랜드 `Microsoft Edge 155`.
- 확장 상태: `data-betterchzzk-auto-quality-guide`는 `{"enabled":true,"attempts":0}`, 자동 화질 상태 `1080p`, 요청 `1080p`, 결과 `pending / player-missing`. 문서에 `video`가 없고 `_player_` 컨테이너만 있었어요.
- 안내 DOM: `_contents_jwedy_31 > _player_jwedy_23 > _dimmed_10lql_28 > _layer_10lql_38`, 배경 785×442, `display: block`, `role`·`data-nlog-area` 없음.
    - 문단 1(`_text_10lql_50`): `크롬, 엣지 브라우저에서 고화질 시청을 위해<br><strong>브라우저 확장 프로그램</strong>을 먼저 설치합니다.`
    - 문단 2(`_text_10lql_50`): `이미 확장 프로그램을 설치했다면<br><a href="https://help.naver.com/alias/navergame/chzzk6.naver" target="_blank" rel="noreferrer" class="_link_10lql_63">여기</a>를 참고해주세요.`
    - 버튼 2개(각 `_button_10lql_70 > button[type=button]`, 310×46, `aria-label` 없음, 활성): `확장 프로그램 설치`(`_highlight_hkeol_20`), `설치없이 일반 화질 시청`(`_gray_hkeol_121`).
- 판정: 구조와 일반 화질 버튼은 2026-09-14 실측 커넥터 안내와 같고, 문단 문구와 설치 버튼 문구가 달라요. `features/qualityInstallGuide.js`는 문단·설치 버튼의 정확 일치를 요구했으므로 후보로 잡고도 클릭하지 않았어요(`attempts: 0`).
- 스크린샷: [수정 전 안내](edge-install-guide-2026-10-11/edge-before-fix-guide-open.jpg) — 플레이어 영역만 잘라 저장했어요.

## 2. Chrome 비교 — 확장 없음

- 진입 15초 뒤: 안내 없이 1280×720 영상이 재생 중이었어요(`readyState 4`, 재생 중).
- 약 6분 뒤 같은 탭 재확인: Edge와 같은 문단·버튼의 `브라우저 확장 프로그램` 안내가 떠 있었고 `video` 요소가 없었어요. 안내가 뜬 계기(자동 화질 상향, 플레이어 재초기화 등)는 측정하지 못했어요.
- 따라서 이 변형은 Edge 전용 문구가 아니라 2026-10-11 기준 Chrome·Edge에 공통으로 표시되는 안내예요. 2026-09-14의 커넥터 문구 안내는 이번에 관측되지 않았지만 제거됐다고 단정하지 않고 매칭을 유지해요.

## 3. 수정 내용

- `features/qualityInstallGuide.js`: 실측 변형 두 가지를 `GUIDES`로 두고, 문단 문구와 설치 버튼 문구가 같은 변형으로 짝지어질 때만 `설치없이 일반 화질 시청`을 선택해요. 버튼 2개·일반 화질 버튼 1개·`_player_ > _dimmed_ > _layer_` 구조·저장 옵션 대기·표시 상태 조건은 그대로예요. 짝이 섞인 안내는 남겨요.
- `tests/quality-install-guide.test.js`: `GUIDE_HTML`에 Edge 변형 픽스처를 추가하고, Edge 변형 닫기·두 번째 안내·observer 정리 테스트와 짝이 맞지 않는 7가지 조합을 남기는 테스트를 추가했어요. 수정 전 코드에서는 Edge 변형 테스트 1개가 실패하고 수정 후 22개가 통과해요.

## 4. 수정 후 Edge 확인 — 15:06 KST

- 같은 임시 프로필을 다시 띄우자 Edge가 명령줄 로드 확장을 비활성화했어요(`Secure Preferences`의 `extensions.settings[oijgeclpcafhkbaameifdomjononepol]`: `location 8`, `disable_reasons 16777216`). 그래서 새 임시 프로필 폴더로 다시 로드했어요. 재실행 전 확장 서비스 워커 대상 `chrome-extension://oijgeclpcafhkbaameifdomjononepol/background.js`를 확인했어요.
- 진입 25초 뒤 결과: 안내 없음(`popups: []`), `data-betterchzzk-auto-quality-guide`는 `{"enabled":true,"attempts":2}`, 자동 화질 결과 `already`·선택 트랙 `muxed.bw_8384000.avc1.size_1920x1080.fps_60.color_sdr.mp4a.lowlatency`(12개 중 1080p 저지연), `video` 1920×1080 `readyState 4` 재생 중.
- 두 번 클릭은 2026-09-14 Chrome 관측과 같은 패턴이에요. 초기 안내를 닫으면 플레이어가 만들어지고, 1080p 선택 때 안내가 한 번 더 떠 다시 닫혔어요. 다른 안내나 숨겨진 요소에 대한 클릭은 없었어요.
- 스크린샷: [수정 후 재생](edge-install-guide-2026-10-11/edge-after-fix-1080p.jpg).
- 범위: 이 기록은 안내 자동 닫기와 이 방송의 1080p 트랙 선택·재생을 관측했다는 뜻이에요.

## 남은 확인

- 사용자가 실제 Edge에서 설치 안내가 뜨지 않는다고 보고했어요. 다른 확장을 함께 쓴 상태의 안내는 측정하지 못했으므로, 남는 안내가 있으면 [진단 스크립트](edge-popup-diagnostic-2026-10-11.js) 출력을 기록해요.
- 닫기 버튼 없이 **확인** 버튼만 있는 안내는 이 기록 당시 자동으로 닫지 않았어요. 같은 날 자동 닫기를 구현했어요([확인형 안내 자동 닫기](adblock-notice-options-2026-10-11.md)).
- Chrome 155는 `--load-extension`을 무시하므로 확장을 로드한 Chrome의 재확인은 `chrome://extensions`에서 직접 로드한 뒤 해야 해요.
