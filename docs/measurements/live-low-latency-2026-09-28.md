# 메인 라이브 저지연 우선 조사

이후 2026-09-28 사용자 요청으로 독립 저지연 우선 옵션과 제어를 제거했어요. 아래는 당시 조사 기록이며 현재 기능 안내가 아니에요. 기존 자동 화질과 스트림 정보 측정은 유지해요.

## 확인 범위

2026-09-28에 제공받은 치지직 올인원 1.5.1의 로컬 파일과 치즈 스패너의 작업 코드를 읽었어요. 이어 공개 라이브 페이지 `https://chzzk.naver.com/live/75cbf189b3bb8f9f687d2aca0d0a382b`의 HTML과 그 페이지가 참조하는 배포 JavaScript를 HTTP로 조회했어요. 로그인 세션을 가져오거나 브라우저 화면을 조작하지 않았어요.

이 기록은 **현재 공개 코드의 제어 표면 조사**예요. 실제 방송이 재생되는 DOM 객체, 확장 주입, 프레임 진행, 전환 전후 지연 초 수를 관측한 기록은 아니에요. HTML 조회 성공을 해당 방송의 재생 성공으로 해석하지 않아요.

## 참고 확장

`injected.js`의 저지연 처리에서는 `preferLowLatency`에 따라 트랙 ID의 `.lowlatency`·`_lowlatency` 형태를 구분해요. 플레이어의 Vue store에서 여러 저지연 관련 키와 action/mutation 후보를 확인하고, 해당 상태 변경 시도 뒤 일부 분기에서 500ms 후 영상의 `currentTime`을 마지막 buffered 끝으로 변경해요. 자동 화질이 켜져 있으면 트랙 재선택도 요청해요.

`assets/settings-schema.js`에서 `preferLowLatency` 기본값은 false예요. `targetLatency`, `chaserMode`, `adaptiveLatencyEnabled`도 선언돼 있지만, 키 존재만으로 지속 추격 기능의 실제 실행을 확정하지 않아요. 팝업에는 `저지연 모드 우선` 토글이 있어요.

치즈 스패너는 저지연 재생 선택의 목적을 참고해 독립 구현해요. 시청 위치 보존 요구와 충돌하는 버퍼 끝 이동, 확인되지 않은 상태 키를 순회해 쓰는 처리는 도입하지 않아요.

## 현재 치지직 배포 코드

조회 출처:

- [페이지 진입 코드](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-BBIPHoDO.js)
- [재생 모듈](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-BYg0wCyN.js)

| 코드                        | 확인한 내용                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| index의 트랙 판별           | `kind === 'low-latency'` 또는 `kind === 'low-latency-p2p'`를 저지연으로 구분해요. 일반 종류는 `main`과 `p2p`이며 `label === 'ABR'`는 자동 선택이에요.                                                                                                                 |
| index의 네이티브 메뉴 연결  | `pzp-setting-quality-pane`의 `change`에서 현재 트랙을 읽고, `pzp-pc-setting-quality-pane` 등에는 필터를 연결해요.                                                                                                                                                     |
| player-vendor의 메뉴 선택   | 메뉴가 `$dispatch('change', {track})`를 호출한 뒤 `selectVideoTrack(id)`를 요청하는 경로가 있어요. `WithSelectVideoTrack`은 `$store.dispatch('selectVideoTrack', id)`를 사용해요.                                                                                     |
| player-vendor의 실시간 판별 | store getter `onLive`는 live·liveStatus·timeMachine·seekable·currentTime·playState를 사용해요. `onLive === true` 확인은 임의의 지연 초 기준을 새로 만들어 판단하는 것보다 현재 네이티브 상태에 근거한 입력이에요. getter를 읽을 수 없으면 실시간으로 추정하지 않아요. |
| player-vendor의 source 전환 | `_wasPlayingBeforeTrackChanges`와 `_lastCurrentTime`을 보관하는 경로가 있고 timeMachine 여부에 따라 분기해요. 이것만으로 모든 전환에서 위치 보존을 보장한다고 단정하지 않아요.                                                                                        |
| player-vendor의 자체 재생   | 플랫폼 자체 catch-up·재생/로드 처리가 존재해요. 새 확장 기능이 별도 배속·seek·play를 실행하지 않는다는 계약과 플랫폼 내부 동작은 구분해요.                                                                                                                            |

분석용 응답 사본은 임시 작업 영역에만 두고 제품에 포함하지 않아요. 조회한 파일의 SHA-256은 다음과 같아요.

- index: `F5BCBD91F2E5F11D293BABF66BF6E302F696D6B3F82AC4BD6CF9079B2DACD6EF`
- player-vendor: `3ADD7EF97995BC4E7052E03C84C18E9FE34D5D6212E4672C6F5F76412C9147BC`

## 우리 코드에서 확인한 연결 지점

`features/autoQualityPage.js`는 현재 메인 video와 소유권이 일치하는 플레이어·quality pane을 제한된 React fiber 탐색으로 찾아요. 첫 `playing`을 기다리고 선택 Promise 완료와 실제 선택 ID를 확인하는 경로가 있어요.

기존 `scoreTrack()`의 저지연 가산점만으로 별도 우선 설정을 충족하지 못해요. 현재 종류 유지 점수가 더 높고, `applyQualityToPlayer()`는 해상도가 같으면 `already`로 종료하므로 같은 해상도 일반→저지연 전환을 별도로 다뤄야 해요. 기존 binding은 자동 화질 활성화에 연결돼 있어 독립 옵션의 수명과 함께 검토해야 해요.

## 남은 실제 검증

구현 후 실제 확장을 다시 로드하고 현재 메인 video·quality pane·getter·트랙 목록을 확인해야 해요. 일반→저지연 전환 중 영상 진행·현재 위치·일시정지와 사용자 수동 선택 보존, 실제 지연 차이, SPA·멀티뷰 메인 딜레이, 설정 팝업 두 테마와 키보드를 검증해야 해요. 자동 회귀의 결과는 이 실브라우저 확인을 대신하지 않아요.
