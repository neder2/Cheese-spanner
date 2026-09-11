# 다시보기 광고 판단 형식 조사 (2026-09-11)

- 작업 기준: branch `1.3.5`, HEAD `a93524859ee907a71cb1b468e6868efb8e55a517`, manifest/package 버전 `1.3.4`.
- 대상: https://chzzk.naver.com/video/15131992 (피닉스박), https://chzzk.naver.com/video/15123124 (랄로).
- 확인한 배포 파일: https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-C4sif-4p.js

## 확인한 클라이언트 계약

배포 파일의 라이브 및 VOD 호출부는 `/seoraksan`에 각각 `CHZZK_LIVE`, `CHZZK_VIDEO`를 전달한다.
반환 content에 `playerAdDisplayResponse`가 있으면 `preRoll`/`midRoll`을 읽고, 없으면
`livePlaybackJson.liveId`/`chatChannelId`를 읽는다. VOD는 이 값을 광고 스케줄의 pre/mid 정책에 전달한다.
요청은 클라이언트의 터널 요청 도우미를 통한다. 로그인된 페이지의 실제 응답 본문은 확보하지 못했다.
이 필드명은 9월 8일 저장소 테스트에도 있어 이번 업데이트에서 새로 생겼다고 단정할 수 없다.

## 피닉스박 암전 사례

- 19:23:30 KST: 본영상 3598.80초, video 요소 3개.
- 사용자 암전 제보 후 19:24:00 KST: 본영상 3629.51초, video 요소 4개.
- 추가 요소는 `gvAdContainerEl` 하위 `adVideoContainerEl`의 `videoEl`이며 `/service/t/` 주소가 설정되어 있었다.
- 광고 요소는 currentTime 0, readyState 0, paused true. 본영상은 재생 중이며 readyState 4.
- 수집된 콘솔 로그는 없었고 확장의 changedParses는 계속 0이었다. 애드가드 꺼짐은 미확인이다.
- 암전과 광고 진입의 관련성이 높지만, 해당 요청이 어느 응답 형식을 사용했는지와 복귀 원인은 미확인이다.

## 구현 및 검증 범위

사용자 요청에 따라 명시적 `playerAdDisplayResponse` 형식도 기존 JSON 처리 경로에 추가한다.
성공 응답, content의 단일 키, 정확히 두 boolean 필드라는 기존 제한을 유지한다.
추가 테스트 데이터는 배포 클라이언트 계약을 바탕으로 구성했으며 실측 서버 응답 fixture가 아니다.
회귀 테스트는 구현 전 midRoll 값이 true로 남아 실패했고, 구현 후 두 플래그가 false가 되어 통과했다.
이 호환 처리와 피닉스박 암전의 원인 관계 및 실제 광고 차단 효과는 별도의 실브라우저 검증이 필요하다.

## 광고 스케줄 연결 차단

- 추가로 확인한 배포 파일: https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-BYg0wCyN.js
- CSS: https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/player-vendor-Ct4cRQDi.css
- `.pzp-midroll-dimmed`는 10초 애니메이션의 마지막 30% 동안 opacity가 0에서 1로 올라간다.
- 광고 상태 ready → VOD의 adBreakCountdown 활성화 → 암전 → animationend의 startAd 호출 순서다.
- 치지직 VOD는 setVideoScheduleInfo로 CHZZK_NDP_SCH 및 customParam.svc=chzzk_video를 지정한 소스를 adsController.srcObject에 연결한다.
- AdsPlayer의 srcObject setter는 \_attachSourceObject로 전달한다. null이면 initAd가 조기 반환하며, 본영상 play 및 replay 경로도 srcObject가 없을 때 광고 시작 단계를 건너뛴다.
- document_start의 Object.defineProperty 래퍼에서 srcObject 접근자 정의를 포착하고, 실제 할당 때 광고 컨트롤러 메서드와 위 VOD 소스 식별자를 확인한 경우에만 null을 전달한다. 일반 영상 소스와 다른 서비스·라이브 소스는 통과한다.
- blockedVodSources는 이 연결 차단 횟수다. JSON 응답 처리 횟수 changedParses와 구분한다.
- 옵션을 끄면 전역 래퍼를 복원하고 이미 정의된 접근자도 원래 setter로 통과한다. 이전에 차단한 소스는 재주입하지 않으므로 새로고침해야 한다.
- 검증은 배포 코드의 계약을 모델링한 회귀 테스트다. 브라우저 보안 정책으로 확장을 재로드할 수 없어 수정본의 실브라우저 주입·암전 방지는 미검증이다.
