# 확인형 안내 실측 — 2026-10-11

상태: **안내 DOM 실측 완료(사용자 콘솔 출력).** 같은 날 `시청 방해 팝업 제거`가 이 안내도 처리하도록 구현했어요. 구현 계약·검사·화면 확인은 [처리 방안 검토](adblock-notice-options-2026-10-11.md)에 있어요.

## 1. 안내 DOM — 사용자 Edge, 15:15 KST 무렵

사용자가 실제 Edge(`Edg/155.0.0.0`)의 `https://chzzk.naver.com/live/b044e3a3b9259246bc92e863e7d3f3b8`에서 안내가 떠 있는 동안 읽기 전용 콘솔 코드를 실행해 보낸 결과예요. 같은 화면에서 설치 안내 자동 닫기는 이미 동작했고(`data-betterchzzk-auto-quality-guide` `attempts: 2`), 1080p 저지연 트랙이 선택돼 있었어요.

- 구조: `body > div._dimmed_jao35_2._dimmed_transparent_jao35_32 > div._container_jao35_20._modal_jao35_27[role="alertdialog"][aria-modal="true"][data-nlog-area="ad_blocking_info_layer"][data-nlog-params='{"component_type":"layer"}']`, 너비 450px.
- 본문: 제목 `strong` 하나, 설명 `p` 두 개, 도움말 링크(`https://help.naver.com/alias/navergame/chzzkars49.naver`) 하나. 문구는 코드의 상수와 같아요.
- 버튼: `_footer_jao35_57 > _inner_jao35_237 > _cell_jao35_248 > button[type=button]` 하나뿐이며 문구 `확인`, `aria-label` 없음. 이름이 `닫기`인 버튼은 없어요.
- 당시 판정: `features/adblockPopup.js`는 이름이 `닫기`인 버튼이 정확히 하나일 때만 눌렀기 때문에 이 안내는 화면에 남았어요.

## 2. 공개 코드 확인 — 15:20 KST

라이브 HTML이 참조한 PC 엔트리(`index-VdvK-ysl.js`, SHA-256 `895aa5e054f7a80936db80d47fb20cb98485657d3ddad1a752fdce8ea6778668`)를 실행하지 않고 읽었어요. 축약 이름은 이 빌드 기준이며 다음 배포에서 바뀔 수 있어요.

- 안내는 공용 모달을 `document.body`에 포털로 그리고, footer의 버튼 하나에 확인 동작을 연결해요. 닫기 버튼은 없고 백드롭 클릭은 아무 동작도 하지 않아요.
- 확인 버튼은 스크립트로 만든 `click()`·`dispatchEvent`에는 반응하지 않아요. 그래서 기존 클릭 방식으로는 닫을 수 없었어요.
- 안내를 닫으면 표시 상태만 꺼지고 재생 화질 등 다른 상태는 그대로예요. 다시 표시되는 경우가 있어요.
- 모달은 표시 중 플레이어 단축키를 막고 `body` 스크롤을 잠그며, 정상적으로 사라질 때 이를 풀어요([2026-09-15 분석](adblock-popup-close-2026-09-15.md)). CSS로 숨기기만 하면 이 정리가 일어나지 않아요.

## 3. 이후

- 같은 날 사용자 요청으로 이 안내를 자동으로 닫도록 구현했어요. 방식과 계약은 [처리 방안 검토 §2](adblock-notice-options-2026-10-11.md#2-구현-계약)에 있어요.
- 자동으로 닫히지 않는 경우에는 사용자가 **확인**을 직접 누르면 닫혀요.
