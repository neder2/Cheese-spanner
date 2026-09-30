# 라이브 PiP의 중간 광고 누락 (2026-09-29~30)

## 사용자 보고와 실제 화면

사용자가 2026-09-29 늦은 시간에 띄워둔 라이브 PiP에서 광고가 나왔다고 보고했어요. Chrome의 실제 페이지는 홈 `/`와 전체 방송 `/lives`였고 광고 상태는 active true, 입장 일정 처리 1회로 남아 있었어요. 본영상 1080p와 `midPlayer`가 같은 페이지에 유지됐어요. 광고 소재 자체는 도구로 다시 포착하지 않았으며 사용자 보고와 현재 화면 관측을 구분해요.

이 PiP는 치지직 페이지 안의 작은 라이브 플레이어였어요. `document.pictureInPictureElement`는 null이고 실제 본영상의 부모는 `.chzzk_player.type_live.pip_mode`였어요. 본영상 레이아웃과 `midAdPlayerWrapper`는 같은 부모 아래 형제로 유지됐고, 광고용 video와 `midAdVideoContainer`는 광고 wrapper의 직접 자식이었어요. 홈 미리보기 480p 영상도 별도로 존재했어요.

## 누락 조건과 소유 근거

기존 일정 연결부는 현재 주소가 `/live/`인지 먼저 확인하고, 소유 판별도 주소에서 채널 ID를 얻었어요. 라이브가 PiP로 계속 재생돼도 홈·목록에 있으면 중간 일정은 그대로 전달되는 조건이었어요. 이 분기는 실제 광고 ID와 무관하게 처리를 빠뜨려요.

현재 공개 페이지 `index-BBIPHoDO.js`의 SHA-256은 `F5BCBD91F2E5F11D293BABF66BF6E302F696D6B3F82AC4BD6CF9079B2DACD6EF`예요. 원격 코드를 실행하지 않고 다음 정적 계약을 대조했어요. 위치는 UTF-8을 JavaScript 문자열로 읽은 0 기반 문자 위치예요.

- 2585628 부근: 중간 광고 컴포넌트는 `player`, `channelId`, `liveId`를 입력으로 받고 첫 두 ref를 광고용 video·container로 사용해요.
- 2595009 부근: 광고용 두 요소는 `midAdPlayerWrapper` 안에 함께 렌더링돼요.
- 2677534와 2681382 부근: 본영상의 `.chzzk_player.type_live.pip_mode` 레이아웃과 중간 광고 컴포넌트가 형제로 생성되며 같은 실제 player와 방송 ID가 전달돼요.
- 3190486 부근: 바깥 라이브 화면은 PiP 상태에서 별도 section과 기존 라이브 정보를 유지해요.
- 중간 광고의 `miniMode`는 스크롤 축소 조건에서 계산되며 PiP 상태와 같지 않아요. PiP에서 이 값을 true로 요구하면 다시 누락될 수 있어요.

## 수정 범위

일반 라이브 페이지에서는 주소와 광고 컴포넌트의 채널 일치를 계속 요구해요. 다른 경로에서는 같은 컴포넌트의 두 ref·유효한 채널/liveId·서비스와 원래 SDK 등록을 확인한 뒤, `props.player.adsController`의 실제 본영상이 현재 라이브 PiP 레이아웃에 속하고 광고 wrapper와 같은 부모를 갖는 경우만 처리해요. PiP 종료·영상 교체·부모 이동·현재 등록 삭제는 적용 직전에 다시 확인해요.

추가 판별은 기존 한 IIFE와 세 전역 진입 안에서 수행해요. 새 전역 훅·옵션·권한·타이머·페이지 전체 탐색은 없어요. 홈의 JSON 판단·직접 소스 경로를 넓히지 않고, 목록 미리보기·VOD PiP·다른 플레이어와 잘못된 라이브 주소는 이 예외의 근거로 사용하지 않아요. 일정 항목과 네이티브 완료·본영상 연결은 유지해요.

## 자동 재현과 확인

회귀는 실제 화면의 관계와 공개 코드 계약을 최소 모델로 재현했어요. 실제 브라우저에 가짜 일정이나 이벤트를 주입한 검사가 아니에요.

- `live PiP schedules created after leaving the live route keep native completion`: 홈·전체 방송으로 이동한 다음 처음 만들어지는 일정도 실제 PiP 소유가 맞으면 소스만 비워요. 요소형/어댑터형 본영상, 원본 동결 입력·호출/반환·완료와 입장 집계 미증가를 확인해요.
- `PiP schedule ownership does not authorize previews, other players or mismatched live routes`: PiP 아님·VOD·다른 플레이어·잘못된 부모·분리·잘못된 채널/liveId/서비스와 다른 라이브 주소는 통과해요.
- `PiP schedules recheck retained video ownership, settings and concurrent homepage media`: 판별 중 PiP 종료·영상 교체, 등록 삭제와 OFF를 확인하고 홈 미리보기·JSON 판단은 보존해요.
- `PiP mid-roll sharing still requires the current registered content manager`: 공유 표시 정보도 현재 본영상과 실제 출처 등록을 요구해요.

수정 전 관련 62개 중 새 긍정 회귀 3개가 실패했고, 수정 후 관련 62개와 인접 기능 6파일 210개가 통과했어요. 전체 테스트 1,282개도 실패·취소·건너뜀 없이 통과했고 전체 lint·format:check와 diff 검사도 종료 코드 0이에요.

## 수정본 재적용 후 실제 Chrome 관측

사용자가 작업 폴더의 확장과 라이브 탭을 다시 로드하고 PiP로 띄웠다고 확인했어요. 확장 관리 페이지는 도구의 보안 정책상 접근할 수 없어 재로드는 이 사용자 확인에 근거해요. 이후 기존 사용자 탭을 이동·일시정지·새로고침하지 않고 읽기 전용으로 관측했어요.

2026-09-30 00:11:53~00:16:42 KST에 전체 방송 `/lives`에서 `.chzzk_player.type_live.pip_mode`가 연결된 상태로 본영상 시간이 118.534초에서 407.345초까지 진행했어요. 관측 시점의 영상은 853×480, paused false·readyState 4·error null이었어요. `midPlayer`는 시간 0·paused true·readyState 0이었어요. 확장 상태는 active true·reloadRequired false이고, 일정 처리 1회·입장 일정 처리 1회로 유지됐어요.

본영상 진행과 차단 기능 활성은 확인했지만, 이 구간에 실제 중간 일정 처리 횟수 변화는 관측하지 못했어요. 카운터는 처리 호출 수이며 광고 배정 자체를 증명하지 않으므로, 광고가 화면에 안 나왔다는 이유만으로 수정본의 중간 광고 차단 성공을 판정하지 않아요. 다음 자연스러운 중간 일정 도달과 처리 횟수 증가·본영상 진행을 함께 확인하는 것이 남아 있어요.

로컬 관측값과 화면은 `.dryforge/ad-pip-20260929/observations.json`, `reloaded.png`·`after.png`에 보관했어요. 새 일정이나 완료 이벤트를 실제 페이지에 강제로 주입하지 않았어요.
