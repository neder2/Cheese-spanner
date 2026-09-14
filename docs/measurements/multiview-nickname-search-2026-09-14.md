# 멀티뷰 닉네임 검색 실측 — 2026-09-14

## 공개 API 확인

- 인증 헤더나 쿠키 없이 PowerShell `Invoke-RestMethod`로 확인했다.
- `https://api.chzzk.naver.com/service/v1/search/channels?keyword=샘&offset=0&size=10&withFirstChannelContent=false`
    - `code: 200`, `content.data[].channel`에 `channelId`, `channelName`, `channelImageUrl`, `openLive`가 있다.
    - `샘웨`는 `openLive: true`, `윤 이 샘` 등은 `false`였다.
    - 시청자 수는 포함되지 않는다. `content.page.next.offset: 10`이 반환되었다.
    - `withFirstChannelContent=true` 조회에서는 첫 결과에 재생정보·영상 목록까지 포함되어, 목록용 조회에서는 사용하지 않는다.
- `https://api.chzzk.naver.com/service/v2/channels/feb20a676694b1163fed010da0848303/live-detail`
    - `code: 200`, `content.status: OPEN`, `content.channel.channelId` 일치, `content.concurrentUserCount: 2774`를 확인했다.
    - 인원은 조회 순간의 값이며 테스트에서 현재 인원으로 고정하지 않는다.
- `https://api.chzzk.naver.com/service/v2/channels/3fbe35e19e546bda4f4534869d35ac08/live-detail`
    - 오프라인 채널은 `code: 200, content: null`을 반환했다. 검색 후 종료된 채널의 선택 해제에 이 응답을 사용한다.
- `service/v1/channels/{id}/live-status`는 404여서 사용하지 않는다.
- 최종 표시 제한을 5개로 변경한 뒤 같은 검색을 `size=5`로 다시 조회했다. 샘웨(93,000), 윤 이 샘(16,495), 샘승아(10,343), 허샘(2,074), 샘물남(1,518) 순으로 `followerCount` 내림차순 5개가 반환됐다. 별도 추측 정렬 파라미터는 추가하지 않고 응답의 팔로워 수로 표시 순서를 정렬한다. 팔로워 수는 화면에 표시하지 않는다.

## 구현 범위

- 제출할 때만 검색 1회, 팔로워순 상위 최대 5개 결과 중 중복 없는 방송 중 채널만 상세 조회한다. 자동 완성·주기적 새로고침·전체 목록 스캔은 없다.
- 프로필은 기존 이미지 URL 검증 유틸을 사용하고 32px 크기·지연 로딩·비동기 디코딩을 적용한다. 프로필 전용 API 요청은 없다.
- 검색어 변경, 패널 닫기, 라우트 변경, 패널/플레이어 호스트 재마운트, 기능 비활성화 때 취소한다. 이전 응답은 새 결과를 덮지 못한다.
- 시청자 수 보조 조회 실패는 확인된 검색 결과를 폐기하지 않고 확인 불가로 표시한다.
- 기존 URL 입력·드롭의 추가 경로를 재사용한다. 닉네임 검색 결과의 선택도 중복·6개 제한·음소거 시작 계약을 따른다.

## 브라우저 검증 제한

- 실제 모듈과 당일 실측 응답을 사용하는 로컬 분리 화면을 Chrome 브라우저 도구로 확인했다. 280px 패널에서 라이트·다크 테마, 프로필 이미지 로딩, 5개 결과, 오프라인 비활성화, Tab 이동과 Enter 선택의 라이브 URL 전달을 확인했다. 이 화면은 설치 확장 주입·실제 플레이어 재생·브라우저의 치지직 API 직접 접근을 검증하지 않는다.

- Chrome 확장 관리 탭을 브라우저 도구로 선택했지만 `Chrome internal tab ... cannot be claimed`로 거부됐다. 우회하거나 컴퓨터 도구로 조작하지 않았다.
- 설치된 확장 다시 로드와 실제 치지직 페이지의 새 코드 주입은 미검증이다. 확장 관리에서 치즈 스패너를 다시 로드한 뒤 치지직 탭을 새로고침하고, 멀티뷰 방송 추가에서 닉네임 검색·결과 선택·URL 추가를 확인해야 한다.

## 자동 검증

- 닉네임 검색 관련 11개 검사와 최종 `npm.cmd run test:all` 709개가 통과했다.
- `npm.cmd run lint`, `npm.cmd run format:check`를 실행했다.
- 중간 전체 실행에서 기존 광고 차단 팝업의 overflow 복원 테스트가 한 번 실패했다. 해당 파일은 수정하지 않았으며 해당 테스트 단독 재실행과 최종 전체 실행은 통과했다.
- 기존 URL 입력 테스트의 `type=url` 선택자를 입력 이름 선택자로 바꿨다. 닉네임을 받는 텍스트 입력으로 계약이 확장된 데 따른 변경이며 기존 URL 추가 검사는 유지했다.
