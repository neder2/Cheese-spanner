# 컴프레서 사용 중 미니 플레이어 복귀 정지

- 실측일: 2026-09-17 (KST)
- 사용자 탭: `https://chzzk.naver.com/live/75cbf189b3bb8f9f687d2aca0d0a382b`
- 별도 재현 탭: `https://chzzk.naver.com/live/a67b328bcc8eea4451ccfa754bc19ae1`
- 확장 ID: `oijgeclpcafhkbaameifdomjononepol`
- 조건: 라이브에서 오디오 컴프레서를 켜고 채널 링크로 이동한 뒤 우측 하단 미니 플레이어의 **전체 화면** 버튼으로 복귀.

## 관측

사용자 탭은 `video.paused=false`, `readyState=4`인데 반복 조회에서 `currentTime=28.828999`가 유지됐다. 컴프레서 버튼은 `aria-pressed=true`, `data-better-chzzk-ready=0`이며 이름은 `오디오 컴프레서(사용할 수 없음)`이었다. 화질 진단은 1080p `already`였다. 사용자는 음성 소실 후 타임머신 지연이 증가하고, 일시정지·재생 후 영상도 나오지 않는다고 보고했다.

새 탭에서는 컴프레서가 꺼져 있었으며 같은 왕복을 두 번 해도 재생 시간이 증가했다. 해당 탭에서 컴프레서를 켜고 같은 왕복을 하자 컴프레서가 `사용할 수 없음`으로 바뀌었다. 탭별 활성 상태 차이로 재현 여부가 달라졌다.

## 원인과 수정

`syncState()`가 이전 영상과 현재 검색한 영상이 다르면 `releaseActiveGraph()`를 호출했다. 이 함수는 AudioContext를 닫고 WeakMap에서 기존 소스를 지웠다. 네이티브 미니 플레이어가 같은 영상 요소를 재사용해도 기존 오디오 연결은 이미 닫힌 상태이며 MediaElementSource를 다시 만들 수 없다.

영상 교체·일시적인 DOM 이탈 시에는 기존 소스를 WeakMap에 유지하고 비압축 출력 연결을 보존한다. 같은 요소가 돌아오면 기존 소스를 재사용한다. 문서 안의 영상들은 AudioContext 하나를 공유해 이동마다 컨텍스트가 늘지 않게 하며, 실제 문서 종료 시에만 닫는다. BFCache 진입은 종료로 취급하지 않는다.

## 검증

- 기존 수명주기 테스트에 일시적인 영상 제거·복귀와 다른 영상으로 교체 후 원래 영상 복귀를 추가했다. FakeAudioContext는 같은 영상의 소스를 두 번 생성하면 오류를 내도록 했다.
- 수정 전에는 DOM 공백 중 기존 컨텍스트가 닫혀 테스트가 실패했다.
- 수정 후에는 기존 소스 재사용, 비압축 출력 연결, 문서 종료 시 정리, 옵션과 BFCache 동작을 검사한다.
- 수정 후 컴프레서 관련 테스트 10개, 전체 `npm.cmd run test:all` 797개가 통과했다. `npm.cmd run lint`, `npm.cmd run format:check`, `git diff --check`도 통과했다.
- 브라우저 도구가 `chrome://extensions/` 접근을 차단했다. 수정본의 확장 다시 로드와 실제 방송 재검증은 사용자 직접 다시 로드 후 진행해야 한다. 원인 재현 결과와 수정 후 브라우저 검증을 구분한다.
