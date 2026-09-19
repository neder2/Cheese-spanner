# 아시안게임 라이브 고화질 제공 조건 조사

## 대상과 확인 범위

- 조사 시각: 2026-09-19 18:55~18:58 KST. 브랜치 `1.3.9`, 시작 HEAD `74ef00554537c5db926e4bf29de5583c28d96a05`.
- 대상: <https://chzzk.naver.com/live/dda025527999c166168474b9620bc8e0>, 아시안게임 TV조선의 `2026 아이치 나고야 아시안게임 개회식`.
- 사용자 스크린샷에는 해상도 목록 대신 `고화질 보기`, `선명한 화면`, `라디오 모드`가 표시됐다. 스크린샷만으로 실제 영상 해상도나 계정의 가입 상태를 확정하지 않는다.
- 공개 HTTP 응답과 현재 배포 JavaScript를 읽었다. 로그인 쿠키와 사용자 브라우저 세션은 사용하지 않았다. 미디어 세그먼트와 암호화 키는 받지 않았다.

## 공개 응답과 실제 재생목록

- `GET https://api.chzzk.naver.com/service/v3/channels/dda025527999c166168474b9620bc8e0/live-detail`: HTTP 200. `liveId=21193148`, `membershipBenefitType="MEMBER_PREFERRED"`, `p2pQuality=[]`.
- `GET https://api.chzzk.naver.com/service/v1.1/channels/dda025527999c166168474b9620bc8e0/live-playback-json-meta?tm=false`: HTTP 200. `pq=[]`, `tmp=false`.
- 두 응답의 재생 정보에는 `mediaId="HLS"`, `aes="hls_aes"`인 미디어가 있으며 영상 트랙은 852×480, 640×360이다. 720p·1080p 트랙은 없고, 별도 오디오 트랙이 있다.
- 응답에 포함된 `media.path`의 HLS master도 HTTP 200이었다. `EXT-X-STREAM-INF`의 영상 해상도는 852×480, 640×360이며 각각 `BANDWIDTH=992000`, `696000`, `FRAME-RATE=30.00`이었다.
- PowerShell `Invoke-WebRequest`가 이 master의 `Content`를 `Byte[]`로 반환했으므로 UTF-8 문자열로 변환한 후 태그를 확인했다. 서명된 주소는 문서에 보관하지 않는다.

## 고화질 버튼의 실제 동작

홈페이지가 참조한 [현재 배포 소스](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-DdGx9_UO.js)의 SHA-256은 `762468c6f788702c9a35a7929c5122ee692908ffdda63f9ef96bcb90f2f148ec`였다.

- 라이브 플레이어는 `membershipBenefitType === "MEMBER_PREFERRED"`와 멤버십·치트키 이용 상태를 함께 검사한다.
- `고화질 보기`는 `.custom-setting-home-item.show_high_quality` 요소다. 클릭 핸들러는 모달 상태를 켜고, 해당 모달은 네이버플러스 멤버십 가입 안내 및 치지직 치트키 이용자의 고화질 시청 가능 안내를 표시한다.
- 이 버튼의 핸들러는 영상 트랙 선택이나 고화질 재생 정보 재요청을 직접 실행하지 않는다.
- [NAVER가 게시한 치지직 앱 안내](https://play.google.com/store/apps/details?hl=ko&id=com.navercorp.game.android.community)의 아시안게임 업데이트 설명도 라이브 고화질을 치트키 또는 네이버플러스 멤버십 이용 혜택으로 안내한다.

## 확장 수정 가능 범위와 한계

- `features/autoQualityPage.js`의 `pickTargetTrack()`은 플레이어에 실제로 존재하는 트랙 중 선호 해상도 또는 가능한 하위 해상도를 고른다. `getLiveQualityPlayer()`의 선택 취소 보정도 이미 존재하는 실측 1080p·720p 저지연 트랙을 대상으로 한다.
- 이번 공개 API와 master에는 해당 고화질 트랙이 없다. 기존 화질 선택 보정을 넓히거나 메뉴만 바꾸는 것으로 이 응답에서 1080p 재생을 만들 수 없다. 로그인한 가입 계정의 재생 정보와 실제 트랙은 별도 확인이 필요하다.
- 모든 계정·기기·재생 경로에서 고화질 접근이 불가능하다는 의미는 아니다. 이번 조사에서는 비로그인 공개 경로와 버튼의 배포 구현을 확인했다.
- 런타임·옵션·권한·버전·릴리스 문서는 변경하지 않았다. 사용자 브라우저의 확장 주입, 실제 화질, 로그인·가입 상태, 재생 성공은 직접 검증하지 않았다. 문서만 추가했으므로 런타임 테스트는 실행하지 않았다.
