# 클립 화질 선택 기능 구현 계획

작성일: 2026-07-14

대상 브랜치: `codex/1.2.5`

목표 버전: Better Chzzk `1.2.5`

상태: 단계 0 완료 — 게이트 A 통과, 게이트 B 실패로 권한·UI 구현 중단

> 이 문서는 치지직 클립의 실제 미디어 형식과 제어 가능성을 먼저 검증한 뒤, 확인된 경로만 구현하기 위한 실행 계획이다. 조사 결과가 중단 조건에 해당하면 기능을 억지로 만들지 않고 근거를 보고한다.

## 1. 목표

치지직 클립 상세 화면에서 사용자가 **실제로 제공되는 화질만** 확인하고 선택할 수 있게 한다.

완료된 기능은 다음 조건을 만족해야 한다.

1. 클립 소스가 복수 해상도를 제공할 때만 화질 선택 UI를 노출한다.
2. `자동`과 현재 클립에서 확인된 해상도만 표시한다.
3. 사용자가 선택한 선호 높이를 다음 클립에도 적용하되, 존재하지 않는 해상도를 만들어 표시하지 않는다.
4. 단일 소스 클립은 현재 재생 해상도만 진단하고 선택 기능을 숨긴다.
5. 일반 네이버 쇼츠에는 개입하지 않고, 치지직이 임베드한 클립 프레임에서만 동작한다.
6. 사용자가 기능을 켜는 동작 안에서 필요한 선택적 호스트 권한을 요청한다.
7. 기능을 끄거나 권한을 제거하거나 SPA/클립 전환이 발생하면 UI·리스너·상태를 모두 정리한다.

## 2. 작업 경계

### 포함

- 치지직 `/clips/{clipUID}` 상세 화면의 클립 플레이어
- 실제 플레이어가 제공하는 `자동` 및 해상도 레벨 선택
- 클립 간 선호 화질 유지
- 옵션 토글, 선택적 권한 승인·거부·기존 승인 처리
- MAIN world와 isolated world 간 최소 상태 브리지
- 회귀 테스트, 사용자 문서, 권한·개인정보 설명, 1.2.5 버전 정합성

### 제외

- 서버에 존재하지 않는 1080p·고비트레이트 소스 생성
- 브라우저 내 실시간 업스케일·재인코딩·트랜스코딩
- 별도 플레이어, 새 창, 팝업, 새 탭, 추가 iframe으로 재생 경로 교체
- 클립의 풀버전 VOD로 이동해 화질 문제를 우회하는 동작
- 일반 `m.naver.com/shorts` 페이지 대상 기능
- 원격 JavaScript·WASM·문자열 코드 실행
- 서명된 미디어 URL, 쿠키, 토큰, 사용자 프로필 또는 재생 기록 저장·전송
- 확인되지 않은 비공개 객체 이름이나 응답 필드에 대한 추측성 호환 분기

## 3. 용어

| 용어               | 의미                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------- |
| 부모 페이지        | `https://chzzk.naver.com/clips/{clipUID}`                                                     |
| 클립 프레임        | 부모 페이지가 삽입한 `https://m.naver.com/shorts/` iframe                                     |
| 자동               | 플레이어의 기존 ABR 선택을 유지하는 상태                                                      |
| 수동 높이          | 사용자가 선택한 360·480·720·1080 등의 세로 해상도 값                                          |
| 레벨               | 플레이어가 실제로 선택할 수 있다고 노출한 인코딩 변형                                         |
| 안정적인 제어 경로 | 공식/관측된 SDK 메시지, 공개 레벨 API, 실제 writable 트랙처럼 선택 결과를 검증할 수 있는 경로 |

## 4. 현재 작업 트리와 보호 대상

브랜치는 `codex-refactor-1.2.4`에서 `codex/1.2.5`로 생성했다.

실제 Git 상태를 재검증한 결과, 계획 작성 전에 존재하던 tracked 수정·삭제는 없고 이 문서만 새 파일로 추가됐다. 기존 `docs/` 문서와 백업 파일은 현재 상태 그대로 보존하며, 구현 범위와 겹치는 `README.md`, `PRIVACY.md`, `docs/update-history.md`만 해당 단계에서 최소 범위로 수정한다.

커밋, push, 태그, GitHub Release는 별도 요청이 있기 전에는 수행하지 않는다.

단계 0 완료 후에는 이 계획 문서와 비밀값을 제거한 실측 fixture, fixture 무결성 테스트가 새 작업물로 추가됐다. 런타임 코드와 릴리스 파일은 변경하지 않았다.

## 5. 2026-07-14 사전 실측

### 5.1 실제 클립 화면

공개 클립 상세 화면 한 건을 확인했다.

- 부모 경로: `/clips/jKL2mXAVW1`
- 부모 페이지의 플레이어는 치지직 자체 DOM 플레이어가 아니라 `m.naver.com/shorts` iframe이다.
- iframe 쿼리에서 `serviceType=CHZZK`, `panelType=sdk_chzzk`, `embed=true`가 확인됐다.
- iframe 제목은 `CHZZK Clip Player`였다.
- 클립 프레임에는 음소거, 재생, 좋아요, 댓글, 공유, 더보기 UI가 있었지만 화질 메뉴는 없었다.
- 실제 `<video>`는 `blob:` URL로 재생 중이었고, 확인 시점의 디코딩 해상도는 `1280x720`이었다.
- 미디어는 `pstatic.net`의 HLS `.ts` 세그먼트로 재생됐다.
- DOM `videoTracks`, window 전역 또는 비디오 조상 요소에서 공개된 화질·HLS·레벨 제어 객체는 확인되지 않았다.

이 결과는 **해당 샘플이 720p로 재생됐다는 근거**일 뿐, 모든 클립이 단일 720p라는 증명은 아니다. master playlist 또는 클립 카드 응답에 다른 변형이 존재하는지 추가 확인해야 한다.

### 5.2 현재 확장 동작

- `content.js`의 `isPlaybackRoute()`는 `/live`와 `/video`만 지원한다.
- `features/autoQualityPage.js`의 `PLAYBACK_ROUTE_RE`도 `/live|video`만 허용한다.
- 클립 부모 페이지에서 자동 화질 상태는 `enabled: false`, 선호 화질은 `1080p`로 게시됐다.
- 기존 자동 화질 코드는 치지직 페이지의 PZP 계열 플레이어와 `videoTracks`를 대상으로 한다.
- 클립 프레임은 교차 출처이므로 부모 페이지 스크립트가 내부 DOM·플레이어 객체에 직접 접근할 수 없다.
- 현재 manifest는 `chzzk.naver.com` 콘텐츠 스크립트만 등록하며 `m.naver.com` 접근 권한이 없다.

따라서 기존 정규식에 `/clips`를 추가하는 변경만으로는 기능이 동작하지 않는다.

## 6. 구현 전 필수 확인 사항

다음 세 게이트를 순서대로 통과해야 한다. 앞 게이트가 실패하면 뒤 단계의 코드·권한·UI를 추가하지 않는다.

### 게이트 A — 복수 화질 소스 존재

확인할 내용:

- 클립 카드 API 응답에 해상도별 프로필 또는 playlist 목록이 있는가
- HLS master playlist에 둘 이상의 `#EXT-X-STREAM-INF`가 있는가
- 각 변형에 `RESOLUTION`과 `BANDWIDTH`가 있는가
- 가로·세로·오래된 클립·최근 클립에서 응답 형태가 같은가
- 클립 전환 시 동일 문서 안에서 레벨 목록이 교체되는가

통과 기준:

- 최소 한 가지 실측 형식에서 둘 이상의 실제 영상 높이가 확인된다.
- 각 높이를 결정적으로 식별할 필드 또는 playlist 태그가 있다.
- 선택 후 `videoWidth/videoHeight`, 플레이어의 현재 레벨 또는 실제 요청 경로 중 하나로 결과를 검증할 수 있다.

실패 시:

- 서버가 단일 변형만 제공한다고 보고한다.
- 권한, 설정, UI, 가짜 해상도 선택지를 추가하지 않는다.

### 게이트 B — 안전한 제어 경로 존재

다음 우선순위로 확인한다.

1. 치지직 부모와 쇼츠 SDK 사이에 실측된 `postMessage` 화질 명령이 있는지 확인한다.
2. 클립 프레임 안에서 공개되거나 안정적으로 관측된 HLS 레벨 API가 있는지 확인한다.
3. 실제 writable 미디어 트랙 또는 플레이어 설정 API가 있는지 확인한다.

통과 기준:

- 선택 요청과 현재 선택 상태를 모두 읽을 수 있다.
- 같은 요청을 반복해도 중복 플레이어·중복 네트워크 세션이 생성되지 않는다.
- 재생 위치, 재생/일시정지, 음소거, 좋아요·댓글·공유 UI가 유지된다.
- 클립이 바뀌면 이전 객체를 버리고 새 객체를 다시 찾을 수 있다.

실패 시:

- 네이버 플레이어를 확장 소유 HLS 플레이어로 교체하지 않는다.
- `<video>.src`를 임의 playlist로 바꾸지 않는다.
- 비공개 번들 코드를 복제하거나 원격 스크립트를 실행하지 않는다.
- “복수 소스는 있으나 안전한 선택 경로 없음”으로 보고하고 중단한다.

### 게이트 C — 최소 권한 주입 경로 검증

게이트 B의 제어가 부모 `postMessage`만으로 가능하면 새 호스트 권한 없이 기존 치지직 콘텐츠 스크립트에서 구현한다.

클립 프레임 내부 접근이 필요하면 다음을 검증한다.

- `optional_host_permissions` 승인 후 `chrome.scripting.registerContentScripts()`로 클립 프레임에만 등록 가능한가
- `allFrames: true`와 `https://m.naver.com/shorts/*` 조합이 현재 iframe에 정확히 매칭되는가
- 이미 열린 클립에 사용자 새로고침 없이 안전하게 1회 주입 가능한가
- 기능 끄기·권한 제거 후 이미 주입된 스크립트가 자체 teardown하는가
- 등록 중복, 서비스 워커 재시작, 확장 업데이트 후 상태가 일관적인가

Chrome 공식 문서상 동적 콘텐츠 스크립트는 런타임 등록이 가능하고, 각 프레임은 URL 조건을 독립적으로 검사한다. 반면 등록을 해제해도 이미 주입된 스크립트는 제거되지 않으므로 코드 자체의 teardown이 반드시 필요하다.

- [Chrome `scripting` API](https://developer.chrome.com/docs/extensions/reference/api/scripting)
- [Chrome 콘텐츠 스크립트](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome 권한 선언](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)

## 7. 실측 절차와 기록 형식

### 7.1 표본

최소 다음 표본을 확인한다.

1. 최근 생성된 일반 게임 클립
2. 오래된 클립
3. 세로 또는 비표준 화면비 클립
4. 원본 VOD가 1080p인 클립
5. 다음/이전 쇼츠 전환으로 같은 iframe 문서에서 로드된 클립

표본 수를 기계적으로 늘리는 대신, 응답 형식이 달라지는 사례가 발견되면 그 형식별로 fixture를 하나씩 보존한다.

### 7.2 기록 항목

각 실측에는 다음을 기록한다.

| 항목        | 기록 내용                                 |
| ----------- | ----------------------------------------- |
| 확인일      | `YYYY-MM-DD`                              |
| 부모 경로   | `/clips/{clipUID}`                        |
| 프레임 조건 | host, pathname, CHZZK 식별 쿼리 키        |
| API         | origin과 pathname만 기록                  |
| HLS         | master/media 여부, 변형 수                |
| 변형        | 높이, 대역폭, 코덱처럼 선택에 필요한 필드 |
| 현재 선택   | 자동/수동 상태와 검증 신호                |
| 전환        | 다음 클립에서 객체·레벨이 어떻게 바뀌는지 |

서명 쿼리, 쿠키, 전체 CDN URL, 사용자 식별값은 문서·fixture·로그에 남기지 않는다.

### 7.3 fixture

실측된 형식만 `tests/fixtures/clip-quality/` 아래에 비밀값을 제거해 저장한다.

- master playlist fixture는 host와 서명 쿼리를 가짜 값으로 바꾼다.
- API fixture는 선택에 필요한 필드만 남긴 최소 JSON으로 만든다.
- fixture 머리말 또는 인접 테스트 이름에 실측 날짜와 형식을 기록한다.
- 확인하지 않은 1080p·480p 변형을 테스트 편의를 위해 임의 생성하지 않는다.

## 8. 권한·주입 설계

### 8.1 선택지 비교

| 안  | 방식                                                      | 장점                                       | 위험·비용                                                              | 판단                     |
| --- | --------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------- | ------------------------ |
| A   | 부모 페이지에서 실측된 SDK `postMessage` 사용             | 새 호스트 권한 없음, 프레임 내부 결합 최소 | 실제 명령 계약이 있어야 함                                             | 발견되면 최우선          |
| B   | `m.naver.com/shorts/*` 선택적 권한 + 동적 콘텐츠 스크립트 | 사용자 동의 후 프레임 내부 제어 가능       | `scripting` 권한, 등록·현재 프레임 주입 수명주기 필요                  | A가 없을 때 권장         |
| C   | manifest 정적 콘텐츠 스크립트                             | 구현이 단순함                              | 업데이트 시 필수 호스트 권한 경고 가능, 기능을 쓰지 않는 사용자도 영향 | 기본안으로 사용하지 않음 |
| D   | 별도 HLS 플레이어 또는 소스 교체                          | 내부 레벨 API 불필요                       | 정상 플레이어 흐름 교체, 상태·분석·재생 회귀 위험                      | 금지                     |

### 8.2 권장안 B의 manifest 초안

게이트 A·B가 통과하고 프레임 내부 접근이 필요할 때만 다음 변경을 검토한다.

- `permissions`에 `scripting` 추가
- `optional_host_permissions`에 `https://m.naver.com/shorts/*` 추가
- `features/clipQualityPage.js`를 해당 origin에서만 접근 가능한 `web_accessible_resources`로 등록
- 정적 `content_scripts.matches`에는 `m.naver.com`을 추가하지 않음

Chrome 공식 문서상 `content_scripts.matches`나 필수 `host_permissions` 변경은 권한 경고를 유발할 수 있으므로, 사용자가 기능을 켤 때 요청하는 선택적 권한을 우선한다.

### 8.3 동적 등록 수명주기

서비스 워커가 고정 ID 하나로 isolated 콘텐츠 스크립트를 등록한다.

예상 등록값:

- id: `betterchzzk-clip-quality`
- matches: `https://m.naver.com/shorts/*`
- allFrames: `true`
- runAt: `document_start`
- persistAcrossSessions: `true`
- js 순서: `shared/settings.js` → `features/clipQuality.js`

등록 규칙:

1. `clipQualityEnabled=true`이고 선택적 호스트 권한이 있을 때만 등록한다.
2. 이미 같은 정의가 등록돼 있으면 다시 등록하지 않는다.
3. 정의가 달라졌으면 `updateContentScripts()` 또는 명시적 해제 후 재등록한다.
4. 옵션을 끄거나 권한이 제거되면 등록을 해제한다.
5. `onInstalled`, `onStartup`, 권한 추가·제거, 옵션 변경 시 상태를 재조정한다.
6. 서비스 워커 재시작 후에도 등록 상태와 실제 옵션·권한을 비교한다.

이미 주입된 문서는 등록 해제로 제거되지 않는다. 따라서 `features/clipQuality.js`는 storage 변경을 받아 즉시 UI와 리스너를 정리해야 한다.

### 8.4 이미 열린 클립에 적용

동적 등록은 이후 생성되는 문서에는 적용되지만 이미 로드된 iframe을 자동으로 소급 처리한다고 가정하지 않는다.

권장 흐름:

1. 치지직 부모 페이지에 작은 호스트 오케스트레이터 `features/clipQualityHost.js`를 추가한다.
2. 옵션이 켜지고 현재 경로가 `/clips/{id}`이면 신뢰된 runtime 메시지를 service worker로 보낸다.
3. service worker는 `sender.id`, `sender.url`, `sender.tab.id`를 검증한다.
4. `scripting.executeScript()`의 읽기 전용 프레임 판별 함수로 현재 탭의 frameId를 확인한다.
5. host/path/query/referrer 조건이 모두 맞는 클립 프레임에만 packaged isolated 파일을 1회 주입한다.
6. 동일 documentId/frameId에는 중복 주입하지 않는다.

이 경로가 추가 `tabs` 또는 `webNavigation` 권한 없이는 안정적으로 구현되지 않으면, 새 권한을 임의로 추가하지 않고 권한 경고와 “페이지 새로고침 필요” 대안을 비교해 사용자에게 결정받는다.

## 9. 기능·설정 설계

### 9.1 기존 자동 화질과 분리

클립은 플레이어 host·world·권한·수명주기가 라이브/VOD와 다르므로 기존 `autoQualityEnabled` 의미를 넓히지 않는다.

새 옵션 초안:

| 키                           | 형식          | 기본값  | 의미                                               |
| ---------------------------- | ------------- | ------- | -------------------------------------------------- |
| `clipQualityEnabled`         | bool, feature | `false` | 클립 화질 선택 기능과 선택적 권한 게이트           |
| `clipQualityPreferredHeight` | int           | `0`     | `0`은 자동, 양수는 사용자가 마지막으로 선택한 높이 |

기본값을 끈 상태로 두는 이유:

- 기능 사용 전에는 `m.naver.com` 접근 권한이 필요하지 않다.
- 사용자가 옵션을 켜는 명확한 제스처 안에서 권한 목적을 설명할 수 있다.
- 복수 화질이 없는 환경에서 불필요한 권한을 요청하지 않는다.

`clipQualityPreferredHeight` 범위는 실측 후 확정한다. 예상 범위는 `0` 또는 144~4320이지만, 실제 제공값만 UI에서 저장한다.

### 9.2 옵션 UI

플레이어 탭의 자동 처리 그룹에 다음을 추가한다.

- 토글명: `클립 화질 선택`
- 설명: 치지직 클립 플레이어 안에 실제 제공 화질 선택기를 표시
- 권한 안내: 치지직이 사용하는 네이버 쇼츠 클립 프레임 접근이 필요하며 일반 쇼츠에는 동작하지 않음

권한 흐름:

1. 꺼짐 → 켜짐 저장 동작 안에서 `chrome.permissions.contains()`를 확인한다.
2. 미승인 상태면 `chrome.permissions.request()`를 호출한다.
3. 승인되면 옵션 저장과 동적 등록을 진행한다.
4. 거부되면 토글을 원래대로 되돌리고 저장하지 않으며 이유를 표시한다.
5. 이미 승인된 경우 추가 팝업 없이 저장한다.
6. 미리보기의 기존 pstatic 권한 흐름과 서로 섞이지 않게 각각 테스트한다.

### 9.3 플레이어 내 UI

복수 레벨이 확인된 경우에만 프레임 안에 선택기를 마운트한다.

표시 규칙:

- 현재 상태: `자동`, `720p`처럼 명확한 텍스트 사용
- 메뉴: `자동` + 실제 레벨을 높은 순서로 표시
- 중복 높이: 같은 높이에 코덱·대역폭 변형이 여러 개면 플레이어의 현재 계열과 호환되는 하나만 대표로 표시
- 단일 영상 높이: 메뉴를 만들지 않음
- 레벨 정보 대기 중: 로딩 선택지를 만들지 않고 UI를 보류
- 오류: 성공처럼 보이지 않으며 재시도 루프를 만들지 않음

접근성:

- 실제 `<button type="button">` 사용
- 접근 가능한 이름과 현재 선택 상태 제공
- 메뉴 열기, Escape 닫기, 위/아래 또는 좌/우 이동, Home/End, Enter/Space 선택 지원
- 닫을 때 트리거로 포커스 복원
- 플레이어의 Space 재생, 방향키 탐색, 터치 재생 제스처를 가로채지 않음

스타일:

- 실제 쇼츠 컨트롤의 계산 스타일을 필요한 속성만 복사하거나 확인된 테마 상태를 사용
- 라이트·다크 정적 fallback 제공
- `theme` 쿼리 변화, iframe 교체, 클립 전환 때 스타일 재동기화
- 좁은 모바일형 프레임에서 메뉴가 잘리거나 화면 밖으로 나가지 않게 배치

## 10. MAIN/isolated world 책임 분리

### isolated world: `features/clipQuality.js`

- URL·referrer·iframe 조건 1차 검증
- `BetterChzzkSettings`로 옵션 읽기·변경 구독
- packaged MAIN 스크립트 주입 또는 상태 브리지 초기화
- 확장 소유 버튼·메뉴 렌더
- 사용자 선택을 storage에 저장
- MAIN world가 게시한 실제 레벨·현재 레벨·오류 상태 표시
- 옵션 끄기·권한 제거·DOM 교체 시 UI와 observer 정리

### MAIN world: `features/clipQualityPage.js`

- URL·referrer·iframe 조건을 다시 검증
- 실측된 플레이어 제어 객체만 탐색
- 실제 레벨 목록 정규화
- 자동/수동 선택 적용
- 선택 결과 검증
- 클립 identity와 플레이어 identity 변경 감지
- 진단 상태 게시
- isolated 요청 리스너와 플레이어 이벤트 리스너 대칭 해제

### 부모 오케스트레이터: `features/clipQualityHost.js`

- 치지직 `/clips/{id}` 경로에서만 현재 iframe 주입 요청
- history API를 다시 패치하지 않고 `startPageChangeDetection()` 사용
- 부모 페이지에서 iframe 내부 데이터를 읽거나 복제하지 않음
- 옵션·라우트·iframe 교체 이벤트를 스로틀해 service worker에 중복 요청하지 않음

### 브리지

기존 자동 화질 패턴처럼 이름이 고정된 DOM 속성과 `CustomEvent`를 사용한다.

예상 이름:

- `betterchzzk:clip-quality:state`
- `betterchzzk:clip-quality:apply`
- `betterchzzk:clip-quality:levels`
- `data-betterchzzk-clip-quality-state`
- `data-betterchzzk-clip-quality-result`
- `data-betterchzzk-clip-quality-status`

브리지 데이터에는 다음만 포함한다.

- 요청 sequence
- `enabled`
- 선호 높이
- 실제 높이 목록
- 현재 높이 또는 자동 상태
- `pending`, `selected`, `already`, `unavailable`, `error` 같은 제한된 상태 코드

미디어 URL, clipUID, API 응답 원문, 사용자 정보는 브리지에 넣지 않는다.

## 11. 대상 프레임 판정

다음 조건을 모두 만족할 때만 기능을 설치한다.

1. `location.protocol === "https:"`
2. `location.hostname === "m.naver.com"`
3. `location.pathname === "/shorts/"` 또는 실측된 동등 경로
4. `window.top !== window`
5. `serviceType=CHZZK`
6. `panelType=sdk_chzzk`
7. `embed=true`
8. 가능한 경우 `document.referrer` origin이 `https://chzzk.naver.com`

referrer가 브라우저 정책 때문에 비어 있을 수 있는지는 구현 전 실측한다. 비어 있는 정상 CHZZK 프레임이 확인되면, referrer를 생략해도 되는 추가 결정 조건을 실측 근거와 함께 정의한다. 단순히 referrer 검사를 제거하지 않는다.

일반 네이버 쇼츠 top-level 페이지와 다른 서비스의 embedded 쇼츠에서는 모든 마커·UI·리스너가 없어야 한다.

## 12. 레벨 정규화와 선택 규칙

### 12.1 정규화

각 레벨에서 실측된 필드만 읽어 다음 내부 형태로 변환한다.

```text
{
  id: 안정적인 현재 문서 내 식별자,
  height: 양의 정수,
  width: 선택 값,
  bitrate: 선택 값,
  automatic: boolean,
  selected: boolean
}
```

해상도는 다음 순서로 판정한다.

1. 숫자 `height`
2. `width x height` 해상도 필드
3. 확인된 레이블의 `NNNp`

숫자를 찾을 수 없는 레벨은 UI에 표시하지 않는다. 문자열에 숫자가 있다는 이유만으로 대역폭·ID 값을 높이로 오인하지 않는다.

### 12.2 선택

- 선호값 `0`: 플레이어 자동 모드 복원
- 정확한 높이 존재: 해당 높이 선택
- 정확한 높이가 없고 더 낮은 높이가 존재: 가장 높은 하위 높이 선택
- 더 낮은 높이도 없음: 현재 자동 상태를 유지하고 `unavailable` 게시
- 동일 높이 복수: 현재 코덱/트랙 계열과 호환되는 실측 기준으로 선택
- 이미 목표 높이: write 없이 `already`

선택 뒤에는 실제 현재 레벨 또는 디코딩 해상도가 목표와 일치할 때만 `selected`를 게시한다. 단순 setter 호출 성공만으로 성공 처리하지 않는다.

### 12.3 클립 전환

클립 전환 identity는 실측된 카드 ID, media ID 또는 플레이어 source identity 중 비밀값을 저장하지 않는 값으로 정한다.

전환 시:

1. 이전 레벨 객체와 선택 상태 폐기
2. 이전 이벤트 리스너 해제
3. 새 플레이어·레벨 준비 대기
4. 새 실제 레벨 목록 게시
5. 저장된 선호 높이를 한 번 적용

MutationObserver는 문서 전체를 무제한 스캔하지 않는다. 실제 플레이어 root 또는 확인된 카드 컨테이너만 관찰하고, 이벤트를 사용할 수 있으면 이벤트를 우선한다.

## 13. 파일별 변경 계획

게이트 A·B·C 통과 후 예상되는 변경이다. 실측 결과에 따라 파일을 줄일 수는 있지만 근거 없이 늘리지 않는다.

| 파일                              | 변경                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| `manifest.json`                   | 1.2.5 버전, 필요 시 `scripting`, m.naver 선택적 권한, MAIN 스크립트 web-accessible 범위 |
| `package.json`                    | manifest와 동일한 1.2.5 버전                                                            |
| `shared/settings.js`              | `clipQualityEnabled`, `clipQualityPreferredHeight` 정의와 정규화                        |
| `options.html`                    | 플레이어 탭 토글, 권한·동작 설명, 좁은 팝업 대응                                        |
| `options.js`                      | 클립 권한 요청·거부·기존 승인 처리; 기존 미리보기 권한 흐름 보존                        |
| `background.js`                   | 동적 콘텐츠 스크립트 등록/해제/재조정, 신뢰된 현재 프레임 주입 메시지                   |
| `features/clipQualityHost.js`     | 치지직 부모 페이지의 옵션·라우트·iframe 주입 오케스트레이션                             |
| `features/clipQuality.js`         | 클립 프레임 isolated UI·설정·브리지·teardown                                            |
| `features/clipQualityPage.js`     | 클립 프레임 MAIN world 플레이어 레벨 탐색·적용·검증                                     |
| `tests/clip-quality.test.js`      | 페이지/오케스트레이터 집중 회귀 테스트                                                  |
| `tests/settings.test.js`          | 기본값·키·정규화·options.html 일치                                                      |
| `tests/extension-pages.test.js`   | manifest, 옵션 권한, 로드 순서, 버전 정합성                                             |
| `tests/options-save-race.test.js` | 권한 요청 중 저장 경쟁·거부·중복 저장 회귀                                              |
| `tests/release-safety.test.js`    | 동적 등록 파일 존재, 원격 코드·대체 플레이어 금지 가드                                  |
| `README.md`                       | 사용자 기능, 조작법, 권한 목적, 지원 한계                                               |
| `PRIVACY.md`                      | m.naver 클립 프레임 접근 범위와 외부 전송 없음 검토·반영                                |
| `docs/update-history.md`          | 1.2.5 변경 내역; 현재 삭제 상태 해결 후 갱신                                            |

`features/autoQualityPage.js`의 트랙 파싱 코드는 클립 제어 형식이 실제로 같다고 확인되기 전에는 공용화하지 않는다. 서로 다른 플레이어를 억지로 한 추상화에 묶지 않는다.

## 14. 자동 테스트 계획

### 14.1 설정

- 새 기본값과 `FEATURE_KEYS` 포함 여부
- `clipQualityPreferredHeight`의 자동 값, 정상 값, NaN, 문자열, 음수, 상한 초과 정규화
- 옵션 HTML의 `data-option` 키와 스키마 키 일치
- legacy 옵션이 없는 새 설치와 기존 1.2.4 저장값 모두 정상 정규화

### 14.2 옵션·권한

- 꺼짐 → 켜짐에서만 클립 호스트 권한 요청
- 승인 시 정확한 옵션 1회 저장
- 거부 시 토글 복원, 저장 없음, 오류 메시지
- 기존 승인 상태에서 재요청 없음
- 미리보기 권한과 클립 권한을 동시에 변경해도 서로 다른 origin spec 유지
- 비동기 권한 요청 중 추가 입력·저장 클릭이 중복 write를 만들지 않음
- 권한 API가 없는 테스트 환경 fallback을 명시적으로 검증

### 14.3 서비스 워커·등록

- enabled + granted에서 정확한 ID·matches·allFrames·runAt·파일 순서로 등록
- disabled 또는 ungranted에서 등록 해제
- 이미 올바르게 등록된 상태는 no-op
- 오래된 정의는 update 또는 교체
- onInstalled/onStartup/storage/permissions 이벤트의 재조정 결과 일치
- 등록 실패가 옵션 저장 성공으로 위장되지 않음
- unregister 뒤 이미 주입된 스크립트가 storage state로 teardown
- 신뢰되지 않은 sender, 비클립 URL, 다른 extension sender의 현재 프레임 주입 거부

### 14.4 MAIN world

- CHZZK iframe 조건 전체 일치 시에만 설치
- 일반 네이버 쇼츠, top-level shorts, 다른 serviceType에서는 무동작
- 실제 fixture별 레벨 정규화
- 자동 복원, 정확한 높이 선택, 최고 하위 높이 fallback, unavailable
- 동일 레벨 재요청은 write 생략
- setter 호출 후 상태 검증 실패 시 `selected`를 게시하지 않음
- 클립·video·player 교체 시 이전 참조와 리스너 폐기
- 늦게 나타난 레벨은 제한된 이벤트/재시도 창 안에서만 처리
- 기능 off 후 전역 hook, 타이머, observer가 남지 않음

### 14.5 isolated UI

- 실제 복수 높이만 메뉴에 표시
- 단일 높이·레벨 없음·오류 상태에서 가짜 선택지 없음
- 선택 시 storage와 MAIN 요청 sequence가 정확히 한 번 갱신
- MAIN 응답이 오래된 sequence이면 무시
- 키보드 이동, Escape, 포커스 복원, accessible name·checked 상태
- 메뉴 외부 클릭, blur, 클립 전환, iframe 교체, option off에서 닫힘·정리
- 라이트·다크·좁은 프레임 CSS 규칙

### 14.6 manifest·릴리스 안전

- manifest/package 버전 일치
- 기존 치지직 MAIN/isolated 콘텐츠 스크립트 순서 보존
- 동적 등록 대상 파일이 패키지 안에 존재
- `web_accessible_resources`가 m.naver의 필요한 path로만 제한
- 원격 script/WASM/import/eval/문자열 코드 실행 없음
- 새 창·팝업·추가 iframe·대체 플레이어 fallback 없음
- signed URL 또는 인증 query를 fixture·로그에 포함하지 않음

## 15. 수동 브라우저 검증

### 15.1 권한

1. 미승인 상태에서 기능 켜기 → 목적이 명확한 권한 요청 표시
2. 승인 → 이미 열린 클립 또는 명시된 적용 방식으로 기능 활성화
3. 거부 → 기능 꺼짐 유지, 클립 재생 영향 없음
4. 기존 승인 → 추가 요청 없이 활성화
5. Chrome 확장 설정에서 권한 제거 → 등록 해제와 현재 UI 정리
6. 기능 다시 켜기 → 새 사용자 제스처에서 재요청

### 15.2 클립 흐름

1. `/clips` 목록에서는 플레이어 선택 UI가 없음
2. `/clips/{id}` 새로고침 진입에서 실제 레벨 표시
3. 자동 → 수동 → 자동 전환
4. 다음/이전 쇼츠 이동에서 레벨 목록과 현재 선택 갱신
5. 선호 높이가 없는 클립에서 결정된 fallback 또는 unavailable 표시
6. 단일 소스 클립에서 선택 UI 숨김
7. 부모 SPA 이동으로 클립 이탈 후 UI·리스너 정리
8. 다시 클립 진입 후 UI 1개만 마운트

### 15.3 기존 플레이어 회귀

- 재생/일시정지
- 음소거와 볼륨
- 진행 위치
- 좋아요, 댓글, 공유, 더보기
- 라이브/채널/풀버전 링크
- 광고 또는 로딩 상태
- 화면 클릭·Space·방향키·터치 제스처

### 15.4 화면

- 라이트·다크 테마
- 일반 데스크톱 폭과 좁은 모바일형 iframe
- 메뉴가 viewport 밖으로 넘치지 않는지
- 텍스트가 잘리지 않는지
- focus-visible이 명확한지
- 플레이어 네이티브 컨트롤과 겹치지 않는지

### 15.5 안정성·성능

- 콘솔 오류 없음
- 클립 하나당 UI·observer·플레이어 리스너 1세트
- 짧은 반복 timer 없음
- 동일 playlist/API 중복 요청 없음
- UI를 열지 않은 상태에서 지속적인 문서 전체 DOM 스캔 없음
- 20회 이상 클립 전환 후 detached DOM·레벨 객체가 누적되지 않음

## 16. 검증 명령

집중 테스트와 변경 파일 형식 검사를 먼저 실행한 뒤 전체 검증을 실행한다.

```powershell
node --test tests/clip-quality.test.js
node --test tests/settings.test.js tests/options-save-race.test.js
npx.cmd prettier --check manifest.json package.json shared/settings.js options.html options.js background.js features/clipQualityHost.js features/clipQuality.js features/clipQualityPage.js tests/clip-quality.test.js README.md PRIVACY.md docs/clip-quality-plan.md
npm.cmd test
npm.cmd run lint
npm.cmd run format:check
```

전체 `format:check`가 범위 밖 기존 drift 때문에 실패하면 변경 파일 검사 결과와 전체 실패 파일을 분리해 보고하고, 범위 밖 파일을 포맷하지 않는다.

## 17. 단계별 실행 순서

### 단계 0 — 증거 확보

작업:

- API/HLS 실측
- 복수 레벨 확인
- 안전한 제어 경로 확인
- sanitized fixture 작성

종료 조건:

- 게이트 A·B 결과가 명확하다.
- 실패하면 구현을 중단하고 조사 결과만 보고한다.

### 단계 1 — 권한과 주입 기반

작업:

- 옵션 스키마·UI
- 권한 승인/거부
- 동적 등록·해제·재조정
- 현재 프레임 주입과 sender 검증

종료 조건:

- 아직 화질 UI가 없어도 대상 CHZZK 프레임에서만 설치/teardown이 검증된다.
- 일반 네이버 쇼츠에는 아무 흔적도 없다.

### 단계 2 — 플레이어 제어 코어

작업:

- 레벨 정규화
- 자동/수동 선택
- 결과 검증
- 클립 전환·플레이어 교체 처리

종료 조건:

- fixture 단위 테스트와 실제 클립에서 같은 선택 결과가 나온다.
- 재생 상태와 기존 컨트롤 회귀가 없다.

### 단계 3 — 사용자 UI

작업:

- 실제 레벨 기반 버튼·메뉴
- 설정 저장
- 접근성·테마·좁은 폭
- 오류·단일 소스 상태

종료 조건:

- 사용자가 실제 제공 레벨만 구분하고 키보드·마우스·터치로 선택할 수 있다.
- 모든 종료 경로에서 UI와 상태가 정리된다.

### 단계 4 — 릴리스 정리

작업:

- 전체 회귀 테스트
- 실브라우저 검증
- README·PRIVACY·업데이트 내역
- manifest/package 1.2.5 정합성
- 스토어 권한 설명 초안

종료 조건:

- 자동 검증과 수동 검증 결과가 구분되어 기록된다.
- 기존 작업 트리 변경을 덮어쓰지 않는다.
- 커밋·push·Release는 사용자 요청이 있을 때만 수행한다.

## 18. 위험과 대응

| 위험                         | 영향                           | 대응                                            | 중단 조건                               |
| ---------------------------- | ------------------------------ | ----------------------------------------------- | --------------------------------------- |
| 클립이 단일 720p만 제공      | 선택 기능 자체가 무의미        | 복수 샘플의 master/API 확인                     | 복수 변형 없음                          |
| 비공개 플레이어 객체 변경    | 업데이트마다 기능 파손         | 공식/관측된 안정 경로 우선, fixture와 상태 검증 | 결정적 제어 경로 없음                   |
| m.naver 권한 경고            | 업데이트 신뢰·설치 유지율 영향 | optional 권한, 기본 off, 목적 설명              | 선택적 방식 불가하고 필수 권한만 가능   |
| 등록 해제 후 코드 잔존       | 기능 off인데 UI/리스너 잔존    | storage 기반 자체 teardown, idempotent install  | teardown 검증 실패                      |
| 이미 열린 iframe 주입 복잡성 | 옵션 즉시 반영 실패            | sender tab 기반 정확한 frameId 주입 검증        | 추가 광범위 권한이 필요하면 사용자 결정 |
| 클립 전환 시 stale 객체      | 잘못된 클립에 화질 적용        | clip/player identity와 sequence 사용            | identity 결정 불가                      |
| native UI와 이벤트 충돌      | 재생·좋아요·키보드 회귀        | 확장 소유 root로 범위 제한, 이벤트 테스트       | 정상 조작 회귀                          |
| 서명 URL fixture 유출        | 보안·개인정보 문제             | origin/path와 최소 필드만 보존                  | 비밀 제거 불가                          |
| 전체 DOM observer·재시도     | CPU/메모리 증가                | 이벤트 우선, 좁은 root, 제한된 재시도           | 안정 상태에서 반복 작업 지속            |

## 19. 명시적 중단 조건

다음 중 하나라도 해당하면 구현을 멈추고 사용자에게 근거와 영향 범위를 보고한다.

1. 실제 클립 응답에 선택 가능한 복수 영상 변형이 없다.
2. 변형은 있지만 native player에서 안전하게 전환할 결정적 API가 없다.
3. 전환을 위해 별도 플레이어·새 페이지·소스 교체가 필요하다.
4. 일반 네이버 쇼츠까지 포괄하는 필수 권한만으로 구현할 수 있다.
5. 선택 결과를 실제 상태로 검증할 수 없다.
6. 클립 전환이나 기능 off에서 기존 hook·리스너를 완전히 제거할 수 없다.
7. 원격 코드 실행 또는 비밀값 저장이 필요하다.

## 20. 완료 정의

- [ ] 게이트 A·B·C의 실측 결과가 날짜·대상·필드와 함께 기록됨
- [ ] 실제 복수 레벨 fixture만 존재함
- [ ] 일반 네이버 쇼츠 무동작이 자동·수동으로 확인됨
- [ ] 권한 승인·거부·기존 승인·제거 흐름 통과
- [ ] 이미 열린 클립과 새로 연 클립의 적용 규칙 검증
- [ ] 자동/실제 해상도 선택과 fallback 검증
- [ ] 단일 소스에서 가짜 UI 없음
- [ ] 클립 전환·SPA 이탈·옵션 off teardown 검증
- [ ] 기존 플레이어 조작 회귀 없음
- [ ] 라이트·다크·좁은 iframe·키보드 접근성 검증
- [ ] 원격 코드·대체 경로·중복 네트워크 요청 없음
- [ ] `manifest.json`과 `package.json` 버전 1.2.5 일치
- [ ] README·PRIVACY·업데이트 내역과 실제 동작 일치
- [ ] `npm.cmd test`, `npm.cmd run lint`, `npm.cmd run format:check` 결과 보고
- [ ] 기존 삭제·미커밋 변경 보존

## 21. 계획 승인 후 첫 작업

승인 후에도 바로 manifest나 UI를 수정하지 않는다. 먼저 단계 0만 수행해 다음 세 결과를 보고한다.

1. 실제 제공된 해상도 목록
2. 선택 가능한 제어 경로와 검증 신호
3. 새 호스트 권한이 필요한지 여부

이 세 결과가 모두 구현 가능 쪽으로 확인된 뒤에만 단계 1을 시작한다.

## 22. 2026-07-14 단계 0 실행 결과

### 22.1 결론

| 게이트 | 결과       | 근거 요약                                                                                        |
| ------ | ---------- | ------------------------------------------------------------------------------------------------ |
| A      | 통과       | 세 클립의 카드 응답과 HLS master에서 모두 실제 720p·480p 변형이 확인됨                           |
| B      | 실패       | 부모 SDK에 화질 명령이 없고 프레임 내부 플레이어의 레벨 API는 비공개 번들 객체로만 존재함        |
| C      | 진입 안 함 | 안전한 제어 경로가 없으므로 선택적 호스트 권한과 동적 주입 경로를 추가해도 기능을 완성할 수 없음 |

따라서 단계 1 이후의 `manifest.json`, 옵션, 권한, 서비스 워커, 플레이어 UI 구현은 진행하지 않는다. 이는 19절의 “변형은 있지만 native player에서 안전하게 전환할 결정적 API가 없음” 중단 조건에 해당한다.

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
