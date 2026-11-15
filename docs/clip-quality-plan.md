# 클립 화질 선택 — 중단 근거와 재개 조건

2026-07-14 조사 기록이며, 2026-11-08에 미구현 실행 계획을 정리했어요. 과거 조사 결과를 현재 치지직의 상태로 단정하지 않아요.

## 현재 작업 범위

클립 화질 선택은 **구현 중단** 상태예요. 당시 720p·480p 소스는 확인했지만, 네이티브 플레이어의 화질을 안전하게 선택하고 결과를 읽을 경로를 찾지 못했어요. 클립용 옵션·호스트 권한·주입·UI는 추가하지 않았어요. 당시 목표였던 Better Chzzk 1.2.5와 브랜치 이름은 과거 계획이며, 현재 버전 변경 지시가 아니에요.

## 재개 전 확인

1. 최근·과거 및 가로·세로 클립에서 실제 복수 화질 목록을 다시 측정해요.
2. 부모 SDK의 화질 명령, 프레임의 공개 레벨 API 또는 쓰기 가능한 트랙을 확인해요. 선택 상태와 실제 해상도를 함께 검증하고 재생·일시정지·음량·기본 조작을 보존해야 해요.
3. 앞의 두 조건이 충족된 뒤에만 필요한 선택 권한과 주입 수명을 설계해요. 치지직이 삽입한 클립에만 적용하고 일반 네이버 쇼츠는 제외해요.

소스 교체·대체 플레이어·새 창·추가 iframe·원격 실행 코드·비공개 객체 탈취로 실패를 우회하지 않아요. 서명 URL·쿠키·토큰은 기록하지 않아요. 현행 작업·권한·검증 기준은 [작업 규칙](standards.md), [보안](security.md), [운영 절차](operations.md)를 따라요.

## 자료와 해석

당시 부모 `/clips/jKL2mXAVW1`은 `m.naver.com/shorts`의 `serviceType=CHZZK`, `panelType=sdk_chzzk`, `embed=true` 프레임을 사용했어요. 제목은 `CHZZK Clip Player`였고 화질 메뉴는 없었어요. 기존 라이브·다시보기 자동 화질의 경로에 `/clips`를 더하는 것만으로 해결되지 않았어요.

아래 실행 결과와 비밀값을 제거한 fixture는 보존해요. 1~21절의 미구현 설계·가상 파일 목록·1.2.5 배포 체크리스트는 현재 작업으로 오인하지 않도록 이 요약으로 대체했어요. 이전 원문은 Git 이력에 남아 있어요. 아래의 ‘권한을 추가하지 않는다’는 2026-07-14 클립 작업의 판단이며 현재 확장 전체의 권한 목록은 manifest가 기준이에요.

## 22. 2026-07-14 단계 0 실행 결과

### 22.1 결론

| 게이트 | 결과       | 근거 요약                                                                                        |
| ------ | ---------- | ------------------------------------------------------------------------------------------------ |
| A      | 통과       | 세 클립의 카드 응답과 HLS master에서 모두 실제 720p·480p 변형이 확인됨                           |
| B      | 실패       | 부모 SDK에 화질 명령이 없고 프레임 내부 플레이어의 레벨 API는 비공개 번들 객체로만 존재함        |
| C      | 진입 안 함 | 안전한 제어 경로가 없으므로 선택적 호스트 권한과 동적 주입 경로를 추가해도 기능을 완성할 수 없음 |

따라서 단계 1 이후의 `manifest.json`, 옵션, 권한, 서비스 워커, 플레이어 UI 구현은 진행하지 않는다. 이는 “복수 변형은 있지만 안전한 네이티브 제어 경로가 없으면 중단한다”는 당시 기준에 해당한다.

### 22.2 표본과 실제 제공 화질

확인일은 모두 2026-07-14이며 API는 `https://creatorhub-api.naver.com/api/v5.0/clipviewer/card`의 origin과 pathname만 기록한다. CDN 서명 쿼리와 전체 재생 URL은 보존하지 않았다.

| 부모 경로           | 게시 시각                  | 실제 디코딩 | MPD/HLS 변형                               | 비고                  |
| ------------------- | -------------------------- | ----------- | ------------------------------------------ | --------------------- |
| `/clips/qt0eJeVvFh` | 최근 클립 목록에서 확인    | 1280×720    | 1280×720 1,496,000bps / 854×480 878,000bps | HLS master 변형 2개   |
| `/clips/h95iFKRFaw` | 2026-07-14 11:33:01 +09:00 | 1280×720    | 1280×720 994,000bps / 854×480 608,000bps   | 100.822초, 변형 2개   |
| `/clips/jKL2mXAVW1` | 2026-07-14 18:46:23 +09:00 | 1280×720    | 1280×720 1,198,000bps / 854×480 743,000bps | `mediaScaleType=CROP` |

카드 응답의 공통 경로는 다음과 같았다.

```text
body.card.content.vod.playback.MPD[0]
  .Period[0].AdaptationSet[]
```

- `video/mp4`와 `video/mp2t` AdaptationSet이 각각 하나씩 있었다.
- 두 세트 모두 `@maxWidth=1280`, `@maxHeight=720`이었다.
- 각 세트의 `Representation`은 `@width`, `@height`, `@bandwidth`, `@frameRate`, `@codecs`를 제공했다.
- `video/mp2t` 세트의 `@nvod:m3u`는 HLS master였고 두 개의 `#EXT-X-STREAM-INF`를 제공했다.
- 첫 표본의 master는 `RESOLUTION=1280x720`과 `RESOLUTION=854x480`을 각각 한 번 노출했다.
- 실제 `<video>`는 세 표본 모두 `blob:` 소스를 사용했고 자동 재생 결과의 `videoWidth/videoHeight`는 1280×720이었다.

비밀값을 제거한 동일 형식은 다음 fixture에 보존한다.

- `tests/fixtures/clip-quality/observed-card-playback-2026-07-14.json`
- `tests/fixtures/clip-quality/observed-master-2026-07-14.m3u8`

### 22.3 부모 SDK 제어 계약

치지직 부모 페이지가 로드한 현재 SDK 청크에서 실제 클래스 메서드와 메시지 타입을 확인했다.

노출된 플레이어 조작 메서드는 재생, 일시정지, 음소거, 볼륨, 이전·다음 이동, 좋아요·팔로우·댓글·공유 상태, UI 옵션과 모달 제어 범위였다. 메시지 액션은 다음 범위였다.

```text
shorts-viewer.action.ack
shorts-viewer.action.comment
shorts-viewer.action.config
shorts-viewer.action.dialog
shorts-viewer.action.follow
shorts-viewer.action.intercept
shorts-viewer.action.jump
shorts-viewer.action.like
shorts-viewer.action.modalClassName
shorts-viewer.action.moreMenu
shorts-viewer.action.mute
shorts-viewer.action.playing
shorts-viewer.action.shareUrl
shorts-viewer.action.toast
shorts-viewer.action.volume
```

화질, 해상도, 트랙 또는 HLS 레벨을 읽거나 쓰는 메서드와 메시지는 없었다. `shorts-viewer.action.config`가 처리하는 확인된 옵션도 `customStyle`, `preventDefault`, `interceptor`, `moreMenu`, `uiMessage` 계열이었고 화질 설정은 포함하지 않았다.

따라서 부모 페이지의 `postMessage`만으로 구현하는 게이트 B의 1순위 경로는 사용할 수 없다.

### 22.4 프레임 내부 플레이어 제어 표면

`https://mm.pstatic.net/js/build/shorts.09a01730.js` 배포 번들에는 HLS의 `currentLevel`, `manualLevel`, 자동 레벨 로직과 플레이어 내부 `videoTracks`, `player.event.onVideoTrackChange` 구현이 존재했다. 그러나 실제 프레임 런타임에서는 다음 결과가 확인됐다.

- `window` 전역과 그 1단계 공개 객체에 `corePlayer`, HLS 레벨, `videoTracks`, 품질 API가 노출되지 않았다.
- `<video>`와 플레이어 조상 DOM 요소에는 관련 공개 속성이나 메서드가 없었다.
- 브라우저의 `HTMLVideoElement.videoTracks`도 존재하지 않았다.
- `<video>.currentSrc`는 `blob:`이므로 MPD의 개별 변형을 DOM 속성으로 선택할 수 없었다.
- 실제 디코딩 높이는 `videoHeight`로 확인할 수 있지만 자동/수동 상태나 선택 가능한 레벨을 읽는 공개 상태 신호는 없었다.

번들 클로저나 내부 React 컨텍스트에서 비공개 `corePlayer` 참조를 탈취하거나 HLS 요청을 가로채는 방식은 안정적인 공개 API가 아니며, 계획의 비공개 객체·소스 교체 금지 조건을 위반한다. `<video>.src`를 개별 playlist로 바꾸는 방식도 정상 플레이어 흐름을 교체하므로 사용하지 않는다.

따라서 게이트 B의 2·3순위 경로도 실패했다.

### 22.5 권한 판단

부모 SDK 경로는 새 호스트 권한이 필요 없지만 화질 제어를 지원하지 않는다. 프레임 내부에 코드를 주입하려면 이론적으로 `https://m.naver.com/shorts/*` 선택 권한이 필요하지만, 권한을 받아도 호출할 안전한 제어 API가 없다.

그러므로 이번 단계에서는 다음을 추가하지 않는다.

- `scripting` 권한
- `https://m.naver.com/shorts/*` 선택적 호스트 권한
- 동적 콘텐츠 스크립트 등록
- `clipQualityEnabled` 또는 선호 높이 설정
- 플레이어 내 화질 버튼·메뉴
- 1.2.5 버전 증가와 릴리스 내역

### 22.6 조사 한계와 재개 조건

이번 표본 세 건은 모두 2026-07-14 최근 목록에서 확인한 가로 720p 계열이므로 오래된 클립과 세로 원본의 모든 응답 형식을 증명하지 않는다. 다만 게이트 B의 실패는 개별 클립 데이터가 아니라 현재 부모 SDK 계약과 쇼츠 플레이어의 공개 제어 표면 부재에 따른 것이어서, 표본을 더 늘려도 현재 구현 중단 판단은 바뀌지 않는다.

다음 중 하나가 실제 환경에서 확인될 때만 단계 0부터 다시 수행한다.

1. 부모 SDK에 화질/트랙 선택과 현재 상태 조회 메시지가 추가된다.
2. 쇼츠 프레임이 공개 HLS 레벨 API 또는 writable 미디어 트랙을 노출한다.
3. 선택 결과를 자동/수동 상태와 실제 현재 높이로 함께 검증할 수 있다.

재개 시에는 현재 fixture를 계약으로 고정하지 않고 API/playlist 형식을 다시 측정한다.
