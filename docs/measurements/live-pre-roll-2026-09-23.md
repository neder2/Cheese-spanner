# 라이브 입장 광고 경로 변경 대응 (2026-09-23)

## 작업 기준과 관측

- 브랜치 `1.4.0`, 기준 HEAD `c84233fa5007885b801244e6e8b8fc9992edde9d`. manifest/package는 `1.3.9`이며 이번 작업에서 버전을 올리지 않았다.
- 사용자 증상: 라이브 입장 직후 광고 노출.
- 확인 탭: <https://chzzk.naver.com/live/c100f81959d1c17044be0541eed56f5b>.
- 기존 문서의 광고 상태 DOM에서 확장 ID `oijgeclpcafhkbaameifdomjononepol`, `active=true`, `changedParses=0`, `blockedLiveSources=0`, `blockedLiveSchedules=3`, `blockedWrappedLiveRequests=0`을 확인했다. 같은 문서에 VOD 처리 이력도 있어 누적 카운터만으로 현재 방송 입장 광고의 배정·차단 성공을 단정하지 않는다.
- 탭의 script URL로 현재 배포 파일을 확인한 뒤, 공개 파일을 별도 임시 디렉터리에 받아 비교했다. 원격 코드를 확장 패키지에 추가하지 않았다.

## 배포 코드 비교

- [현재 페이지 코드](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-BBIPHoDO.js): SHA-256 `f5bcbd91f2e5f11d293babf66bf6e302f696d6b3f82ac4bd6cf9079b2dacd6ef`.
- [이전 조사 페이지 코드](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-C4sif-4p.js): SHA-256 `40a9c54387bb40ed0136147ba5626647f138777def7cecc574b7a41536d982fc`로 9월 14일 기록과 일치했다.
- [플레이어 SDK](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-BYg0wCyN.js)는 양쪽 페이지에서 동일한 URL을 사용한다. 아래 계약은 9월 23일 다시 받은 SDK 본문에서 확인했다.

이전 페이지에는 `preAdPlayerWrapper`·`preAdVideoContainer`가 없고 `linearAdRequest`를 감싼 라이브 광고 연결이 있었다. 현재 페이지는 별도 입장 광고 컴포넌트에서 GFP의 `createAdScheduleManager()`를 호출한다. `preAdContentPlayer` 영상과 `preAdVideoContainer`를 전달하고, `loadWithAdSchedule()` 이후 `startAdSchedule()`을 호출한다. 일반 광고 단위 ID는 `w_live_chzzk_naver_va`, 아시안게임 분기는 `event_w_live_chzzk_naver_va`다. 기존 중간 광고는 각각 `_mid`가 붙은 단위 ID를 사용한다.

현재 NLiveCast 연결에는 `linearAdRequest`가 없고 `playerType: "LIVE_PW"`만 전달된다. 바깥 클라이언트는 본방송과 연결되어 있으므로 그대로 유지한다. 정확한 변경 배포 시각은 확인하지 않았다.

SDK의 `createAdScheduleManager()`는 광고 컨테이너를 키로 WeakMap에 매니저를 등록한 뒤 반환한다. 공개 `getAdDisplayContainerInfo()`가 반환하는 객체는 `adVideoContainer`와 `contentVideo`를 보유한다. 해당 객체는 매니저 생성 시 전달된 두 요소로 만들어진다. 광고 항목이 비어 있으면 SDK의 `checkScheduleCompleted()`가 원래 `SCHEDULE_COMPLETE` 이벤트를 발생시키며, 현재 페이지는 광고 시작이 없었던 완료를 `NO_ADS`로 처리한다.

## 원인과 수정 경계

기존 WeakMap 처리는 `midAdVideoContainer`와 `midAdPlayerWrapper`의 DOM 이름에 묶여 있어 새 입장 광고 매니저를 포착하지 못했다. 광고 항목 검사도 중간 광고의 두 단위 ID만 지원했다.

- Element 키와 기존 SDK 메서드를 확인한 뒤 공개 표시 정보의 컨테이너가 등록 키와 일치하는 매니저만 감싼다. 연결 영상은 같은 문서의 HTMLVideoElement여야 한다.
- 호출할 때 현재 라이브 경로·활성 옵션·매니저 receiver·컨테이너 소유 관계·두 요소의 연결 상태를 다시 검사한다. DOM 이름과 부모 배치에는 의존하지 않는다.
- 실측한 네 단위 ID의 `adSources`만 새 배열로 비운다. 입력 객체, 다른 광고 항목, 메타데이터, 인자, 반환값과 원래 예외는 유지한다.
- SDK 정보 읽기 실패나 미확인 구조는 원래 입력으로 전달한다. 중복 등록은 중복 래핑하지 않는다.
- `blockedLiveSchedules`는 입장·중간 스케줄 처리 합계이며 `blockedLivePreRollSchedules`는 입장 광고 항목이 포함된 처리 횟수다. 실제 광고 배정 수나 시청 중 차단 성공 수를 의미하지 않는다.
- 기존 소스·JSON 처리 경로와 옵션 해제 후 새로고침 계약을 유지한다. 새로운 전역 패치, 타이머, observer, DOM 검색, 네트워크 요청, 권한은 추가하지 않는다.

컨테이너 이름·배치 변경에는 덜 민감하지만, SDK 등록 방식·공개 메서드·광고 식별값 자체의 변경이나 본방송 스트림에 포함된 광고를 자동 대응하는 것은 아니다.

## 검증

- 신규 회귀 테스트 3개는 수정 전 광고 소스가 남아 모두 실패했고 수정 후 통과했다. 관련 광고·등록 테스트는 31개가 통과했다.
- 일반·이벤트 입장/중간 광고, 이름이 없는 컨테이너, 중복 등록, 원본 불변성, 정상 완료 계약, SPA 이동, 영상 교체·분리·재부착, 옵션 해제·재활성화 대기, 미확인 ID·항목, 소유권 불일치, 정보 조회 실패, 읽기 전용 매니저와 원래 로드 오류를 검사했다.
- 기존 중간 광고 테스트에 실제 SDK의 공개 컨테이너·영상 소유 정보를 추가했다. 기존 완료·입력 보존·옵션 해제 assertion은 유지했다.
- 전체 `npm.cmd run test:all` 893개, `npm.cmd run lint`, `npm.cmd run format:check`가 통과했다.
- 브라우저 도구가 확장 관리 페이지 접근을 보안 정책으로 차단해 사용자에게 개발용 확장 재로드를 요청했다. 사용자는 정상 작동을 확인했다고 답했다.
- 이어 별도 검증 탭에서 피닉스박 라이브로 새 문서 진입했다. 실제 확장 ID `oijgeclpcafhkbaameifdomjononepol`과 새 `blockedLivePreRollSchedules` 필드로 수정본 주입을 확인했다. 입장 처리 후 `blockedLiveSchedules=1`, `blockedLivePreRollSchedules=1`, `reloadRequired=false`였고 입장 광고 컨테이너는 제거됐다. 본영상은 `readyState=4`, `paused=false`, 재생 시각 42.38초였으며 수집된 콘솔 error는 없었다.
- 같은 문서에서 사이드바의 네이티브 링크로 [랄로 라이브](https://chzzk.naver.com/live/3497a9a7221cc3ee5d3f95991d9f95e9)에 SPA 이동했다. 두 스케줄 카운터가 각각 2로 증가하고 입장 광고 컨테이너는 제거됐으며, 본영상은 `readyState=4`, `paused=false`, 재생 시각 52.08초였다. 수집된 콘솔 error는 없었다.
- 실제 중간 광고의 자연 발생, 이벤트 방송, 옵션 해제·재활성화 후 재입장과 SDK의 향후 변경은 이 실브라우저 확인에 포함되지 않는다. 옵션 수명주기·이벤트 광고 단위는 자동 테스트로 검사했다. UI·CSS 변경은 없다.
