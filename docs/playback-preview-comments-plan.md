# 재생·미리보기·댓글 개선 계획

작성일: 2026-07-11

대상: Better Chzzk 현재 `1.2.3` 작업 브랜치
상태: 구현·통합 검증 완료 (2026-07-12, 전체 테스트 368개 통과)

> 이 문서는 완료된 작업의 설계·검증 근거를 보존한 기록이다. 아래의 "현재" 표현과 작업 트리 상태는 계획 작성 당시를 뜻한다.

## 목표와 작업 경계

이번 작업은 다음 다섯 항목을 한 묶음으로 구현하되, 각 기능의 소유 파일과 회귀 테스트를 분리한다.

1. 라이브 방향키 이동·깊은 되감기 뒤 강제 라이브 복귀 수정 및 가짜 캐시 저장량 옵션 삭제
2. 미리보기 볼륨을 설정값으로 고정
3. 다시보기에서 Space를 길게 누르는 동안 2배속
4. `/lives` 미리보기 우클릭 집중 모드에서 진행 시간 숨김 및 가능한 범위의 화질 상향
5. 다시보기 채팅 영역에 댓글 탭 추가

계획 작성 당시 작업 트리에는 `followingPreviewTooltip.js`, `categoryTools.js`, 설정·테스트·README 등의 미커밋 작업이 이미 있었다. 이를 되돌리거나 별도 기능을 덮어쓰지 않고 당시 상태 위에 필요한 변경만 추가했으며, 버전 증가, 커밋, push, 태그, Release는 원래 요청 범위에 포함하지 않았다.

## 사전 실측과 판단

### 라이브 위치 유지

- `skipLivePauseResumeDepthMinutes`는 HLS·플레이어 캐시 양을 바꾸지 않는다. 확장이 기억한 위치를 보호할지 결정하는 기본 120분 임계값일 뿐이다.
- 실제 이동 가능 범위는 매 순간 `HTMLVideoElement.seekable`로 결정된다.
- 현재 가드는 120분보다 깊은 위치에서 보호 상태를 지우므로, 그 뒤 플레이어가 라이브 엣지로 점프하면 복원할 정보가 없다.
- 강제 라이브 점프가 짧은 간격으로 연속 발생하면 첫 점프는 복원해도 두 번째 점프가 복원 쿨다운에 걸린다. 현재 코드는 이 두 번째 라이브 엣지 값을 새 정상 상태처럼 처리해 기존 보호 상태를 지울 수 있다.

### 현재 치지직 다시보기 DOM과 댓글 데이터 흐름

2026-07-11 실제 다시보기에서 다음 구조를 확인했다.

- 우측 채팅 다시보기 패널: `aside#vod-aside`
- 하단 네이티브 댓글 루트: `#commentArea`
- 댓글 행: `commentBox-${commentId}`. 2026-07-12 재측정에서는 아바타가 이미지가 아닌 `button[class*="_thumbnail_"] > span`, 작성자 이름이 `button[class*="_information_"] > strong` 구조였고 두 버튼은 서로 별도 동작이었다.
- 댓글 타임라인: `button[type="button"]` 안의 `H:MM:SS` 또는 `MM:SS` 텍스트
- 두 영역은 같은 `#root` 아래에 있지만 서로 다른 React 레이아웃 가지에 있다.

네이티브 댓글 노드를 채팅 패널로 직접 옮기면 React 재렌더와 이벤트 위임을 깨뜨릴 수 있다. 원본은 제자리에 두고 우측 패널의 댓글·답글 데이터는 `fetchChzzkCommentPage()`를 통한 댓글 API에서 가져와 확장 소유 DOM으로 렌더한다. 하단 `#commentArea`는 댓글 데이터 추출에 사용하지 않고, 원본 댓글 글꼴과 같은 `commentId`의 프로필·버프 컨트롤 및 네이티브 아이콘·상태를 확인하는 데만 사용한다.

## 항목별 구현 계획

### 1. 라이브 복귀 수정과 저장량 옵션 삭제

대상 파일:

- `features/skipControl.js`
- `shared/settings.js`
- `options.html`
- `tests/settings.test.js`
- `tests/extension-pages.test.js`
- `README.md`
- `docs/update-history.md`

구현:

- `skipLivePauseResumeDepthMinutes` 스키마, 상수, 옵션 UI, 공개 설정값, 문서 표를 완전히 삭제한다.
- `skipControl.js`의 깊이 계산 helper와 live/pause snapshot의 임의 시간 제한을 삭제한다.
- 위치 유효성은 오직 현재 `seekable` 범위와 유한한 시간 값으로 판정한다. 확장이 실제 버퍼 범위를 늘리거나 존재하지 않는 과거 구간을 만들지는 않는다.
- 같은 보호 상태에서 강제 라이브 점프가 연속 발생하면, 쿨다운·복원 중이라 즉시 다시 seek하지 못하더라도 라이브 엣지 샘플을 정상 사용자 위치로 저장하지 않고 기존 상태를 보존한다.
- 명시적인 라이브 버튼 클릭, 실제 사용자 seek, SPA 이동, 비디오 교체 시의 기존 초기화 규칙은 유지한다.

회귀 기준:

- 기존 120분보다 깊지만 `seekable` 안인 사용자 위치도 강제 라이브 점프 뒤 복원된다.
- 같은 tick 또는 복원 쿨다운 안에서 강제 점프가 두 번 발생해도 보호 상태가 남아 다음 동기화에서 복원된다.
- 깊은 위치에서 사용자가 일시정지했다가 재생해도 현재 `seekable` 안이면 해당 위치로 복원된다.
- 명시적 라이브 복귀, 초기 지연 진입, 비시크 슬라이더, 새 비디오 교체 회귀 테스트는 그대로 통과한다.

### 2. 미리보기 고정 볼륨

대상 파일:

- `shared/settings.js`
- `options.html`
- `features/followingPreviewTooltip.js`
- `tests/settings.test.js`
- `tests/extension-pages.test.js`
- `tests/following-preview-tooltip.test.js`
- `README.md`

구현:

- 숫자 옵션 `followingPreviewVolumePercent`를 추가한다.
- 범위는 1~100%, 기본값은 15%로 한다.
- `followingPreviewSoundEnabled`가 켜진 모든 확장 미리보기는 주 플레이어·localStorage 볼륨을 추적하지 않고 이 값만 사용한다.
- 이미 소리가 켜진 미리보기는 옵션 변경 즉시 새 볼륨을 반영한다. 음소거 중인 미리보기를 옵션 변경만으로 임의 해제하지 않는다.
- `/lives` 네이티브 미리보기는 우클릭 집중 모드 동안에만 설정 볼륨을 적용하고, 해제할 때 원래 `muted`, `defaultMuted`, `volume`을 정확히 복원한다.

회귀 기준:

- 메인 플레이어 볼륨과 무관하게 15% 또는 사용자가 저장한 값이 적용된다.
- 1 미만·100 초과 저장값은 스키마에서 보정된다.
- 미리보기 음소거 fallback과 소리 잠금 해제 흐름은 유지된다.

### 3. 다시보기 Space 홀드 2배속

대상 파일:

- 새 파일 `features/holdSpeed.js`
- `manifest.json`
- `shared/settings.js`
- `options.html`
- `tests/settings.test.js`
- `tests/extension-pages.test.js`
- `README.md`
- `docs/update-history.md`

구현:

- `holdSpeedEnabled` 토글을 추가하며 기본값은 켜짐으로 한다.
- 기능 범위는 `/video/*` 다시보기 전용, 배속은 고정 2배로 제한한다.
- Space keydown을 capture 단계에서 소유하고 350ms 동안 홀드 여부를 판정한다.
- 350ms 전에 keyup이면 재생/일시정지를 정확히 한 번 실행한다.
- 350ms가 지나면 기존 `playbackRate`를 기억하고 2배로 바꾸며, keyup·blur·탭 숨김·옵션 끄기·SPA 이탈 때 원래 값으로 복원한다.
- 입력창, textarea, select, summary, 링크, 실제 button, role 기반 컨트롤, contenteditable처럼 Space를 직접 소비하는 대상에는 개입하지 않는다.
- `features/holdSpeed.js`는 `features/shortcutRescue.js`보다 먼저 로드해 Space를 이중 처리하지 않게 한다. 라이브의 Space·타임시프트 흐름에는 개입하지 않는다.

회귀 기준:

- 짧은 탭은 1회 토글되고 배속을 남기지 않는다.
- 홀드는 재생 상태를 바꾸지 않고 2배속만 임시 적용하며 기존 1.25배·1.5배 등으로 정확히 돌아간다.
- 반복 keydown, editable/Space 소비 요소, 옵션 끔, 라이브 라우트에서는 부작용이 없다.

### 4. `/lives` 우클릭 집중 모드

대상 파일:

- 현재 미커밋 작업의 `features/followingPreviewTooltip.js`
- `tests/following-preview-tooltip.test.js`
- `options.html`
- `README.md`

구현:

- `/lives` 카드 우클릭 확대는 `livePreviewRightClickSoundEnabled`와 분리해 항상 집중 모드로 동작한다. 해당 옵션은 이름대로 우클릭 시 소리를 켤지 여부만 결정한다.
- 집중 모드 속성 `data-bcfp-list-expanded="1"` 아래의 확장 소유 진행 시간 배지 `data-bcgt-live-elapsed-badge="1"`를 숨긴다.
- 확장 소유 HLS 미리보기는 평상시 480p 상한을 유지하고, 집중 모드에서는 가용 레벨 중 최고 1080p 이하로 상한을 올린다. 해제 시 480p로 복원한다.
- ABR을 유지하기 위해 수동 고정 레벨 대신 `autoLevelCapping`과 가능한 자동 레벨 힌트를 사용한다.
- 치지직 네이티브 미리보기의 비공개 React/HLS 객체에는 접근하지 않는다. 확대된 렌더 크기에 따른 네이티브 ABR 상향만 허용하고, 관측되지 않으면 강제 화질 전환을 만들지 않는다.
- 재우클릭, ESC, 카드 밖 클릭, 스크롤, SPA 이동, 카드/비디오 제거 때 확대·시간 숨김·화질·오디오를 모두 원복한다.

회귀 기준:

- 확장 진행 시간 배지는 집중 모드에서만 숨고 모든 종료 경로에서 다시 보인다.
- HLS 레벨 360/480/720/1080이 있으면 평상시 480 → 집중 모드 1080 → 해제 480 순서로 바뀐다.
- 네이티브 카드에는 추가 HLS 인스턴스나 추가 네트워크 요청을 만들지 않는다.

### 5. 다시보기 채팅/댓글 탭

대상 파일:

- 새 파일 `features/vodCommentTabs.js`
- `manifest.json`
- `shared/settings.js`
- `options.html`
- 새 집중 테스트 `tests/vod-comment-tabs.test.js`
- `tests/settings.test.js`
- `tests/extension-pages.test.js`
- `README.md`
- `docs/update-history.md`

구현:

- `vodCommentTabsEnabled` 토글을 추가하며 기본값은 켜짐으로 한다.
- `/video/*`의 `#vod-aside` 상단에 접근 가능한 `채팅`/`댓글` 탭 버튼을 삽입하고 기본 탭은 채팅으로 둔다.
- 네이티브 `#vod-aside`와 실제 채팅 log가 확인된 뒤에만 탭을 마운트한다. 확장 문구 때문에 `vodReplayChatFix.js`가 채팅 탑재를 성공으로 오인하지 않게 한다.
- VOD가 유휴 상태일 때 댓글 API의 첫 10개를 미리 받고, 댓글 탭에서는 `page.next` offset을 이어 붙인다. 등록순·최신순·인기순 상태는 VOD별 메모리 캐시로 유지하며 새로고침은 현재 정렬만 다시 요청한다.
- API의 전체 댓글 래퍼와 직접 댓글 객체 형태의 `replyComments`를 모두 정규화해 답글을 표시하고, 같은 `commentId`는 중복 제거한다. 한 댓글의 답글은 최대 50개, 한 정렬 화면 전체에서는 최대 300개까지 렌더하고 초과 사실을 해당 부모 댓글에 안내한다.
- 삭제·클린봇 숨김·nullable 사용자/댓글·잘못된 날짜를 안전한 실제 상태로 표시한다. 요청 timeout의 `AbortError`와 형식을 확인할 수 없는 응답은 빈 결과로 오인하지 않고 재시도 가능한 오류 상태로 둔다.
- 댓글 정보는 `도구 모음 → 댓글 목록 → 다음 offset` 구조의 확장 소유 DOM으로 렌더한다. 치지직 시맨틱 색상 토큰, 명시적인 라이트·다크 루트 상태와 하단 원본 댓글에서 측정한 글꼴·작성자·날짜·본문 타이포그래피를 반영한다. 300px 이하에서는 도구 모음을 두 줄로 재배치하며 더 좁은 헤더에서는 긴 채팅 탭에 우선 너비를 배분한다.
- 하단 `commentBox-${commentId}`에서 원본 프로필·버프 컨트롤을 확인할 수 있을 때만 우측 아바타·작성자·버프 버튼을 활성화한다. 아바타의 thumbnail 버튼과 작성자 information 버튼을 구분해 각각 정확히 한 번 위임하고, 원본 아바타가 CSS 배경이면 계산된 배경을 안전한 확장 소유 span에 복사한다. 버프의 활성 상태·개수와 컨트롤 활성 여부를 다시 동기화한다. 원본이 없거나 비활성 상태이면 우측 버튼도 비활성화하고 스크린 리더용 이유 안내를 연결한다.
- 원본 댓글 MutationObserver는 `#commentArea`에만 연결해 프로필·버프 컨트롤, 아바타·버프 아이콘, `aria-pressed`·`aria-disabled`와 텍스트 노드 개수 변화를 동기화한다. 페이지 전체 observer는 댓글 상태 속성을 보지 않고 마운트·원본 댓글 영역 교체만 감지한다. 댓글 작성·삭제·신고는 우측 탭에서 노출하거나 전달하지 않는다.
- 타임코드 클릭은 `MM:SS`/`H:MM:SS`를 파싱해 현재 메인 VOD의 `currentTime`만 바꾸고, 페이지 스크롤이나 댓글 탭 선택은 유지한다.
- 댓글 탭 선택 시 네이티브 채팅 콘텐츠만 숨기고, 채팅 탭으로 돌아오면 그대로 복원한다. 원본 하단 댓글은 이동·삭제하지 않는다.
- 짧은 aside 재마운트 공백은 기존 패널·진행 요청을 유지해 견디고, 영구 분리되면 요청과 확장 UI를 정리한 뒤 새 aside에서 다시 마운트한다. SPA 이탈과 옵션 끄기에서는 body observer, 주입 UI, 요청, aria 상태를 모두 정리한다.

회귀 기준:

- 정렬별 첫 페이지·다음 offset·캐시·새로고침이 서로 섞이지 않고, 전체/직접 형태 답글과 nullable·삭제 행이 안전하게 표시된다.
- 아바타·작성자 프로필과 버프 컨트롤이 같은 `commentId`의 대응 원본에만 정확히 한 번 위임되고, 없거나 `aria-disabled`이면 해당 우측 버튼만 비활성화된다. 텍스트 노드만 바뀐 버프 개수, 지연 마운트, 원본 영역 제거·교체도 기존 API 행을 다시 만들지 않고 반영된다.
- timeout과 잘못된 응답은 빈 댓글이 아니라 재시도 상태로 표시된다.
- 타임코드를 여러 번 자유롭게 눌러도 댓글 패널 스크롤과 영상 재생 상태가 유지된다.
- 정렬·새로고침·초기 재시도·다음 댓글 불러오기 후 포커스가 대응하는 새 컨트롤이나 첫 추가 행으로 복원되고, 탭의 좌우·Home·End 키 이동이 순환한다.
- 짧은 aside 교체에서는 패널과 진행 요청을 유지하고, 영구 제거·새 VOD SPA 이동·옵션 끄기 뒤에는 중복 UI나 observer가 남지 않는다.
- 라이트·다크 모드와 300px 이하 우측 패널에서 탭 제목, 정렬 바, 댓글·답글, 포커스 표시와 스크롤이 잘리거나 수평으로 넘치지 않는다.

## 검증 순서

1. 각 기능의 집중 회귀 테스트와 `node --check`를 먼저 실행한다.
2. 변경 파일을 Prettier로 검사한다.
3. 전체 검증을 실행한다.

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run format:check
```

전체 `format:check`가 기존 범위 밖 drift로 실패하면 변경 파일만 `npx.cmd prettier --check ...`로 분리 검증하고 전체 실패 원인을 별도 기록한다.

## 실동작 검증

1. Computer Use로 `chrome://extensions`의 Better Chzzk를 새로고침한다.
2. 실제 `/live/*`, `/lives`, `/video/*`에서 다음을 확인한다.
    - 연속 방향키 seek와 깊은 seek 뒤 위치 유지
    - 미리보기 고정 볼륨
    - VOD Space 짧은 탭/홀드/해제
    - `/lives` 우클릭 집중 모드의 시간 숨김·확대·오디오·가능한 화질 상향
    - 채팅/댓글 탭 전환과 반복 타임코드 클릭
3. 확장 새로고침이나 실제 페이지 주입 확인이 환경상 불가능하면, 빈 페이지에 현재 치지직 DOM 구조를 복제한 수동 fixture를 만들어 동일한 주입·전환·정리·테마 동작을 검증한다.
4. 실브라우저에서는 실행 명령 성공만으로 확장 로드를 판단하지 않고 확장 DOM 마커와 실제 옵션 반영을 확인한다.

## 완료 조건

- 다섯 항목의 코드·설정·manifest·README·현재 릴리스 변경 내역·테스트가 서로 일치한다.
- 기존 미커밋 작업을 보존하고 범위 밖 파일을 되돌리거나 포맷하지 않는다.
- 자동 검증 결과와 실브라우저 또는 빈 페이지 복제 검증 결과를 구분해 보고한다.
