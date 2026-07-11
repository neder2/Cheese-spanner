# 재생·미리보기·댓글 개선 계획

작성일: 2026-07-11

대상: Better Chzzk 현재 `1.2.3` 작업 브랜치
상태: 구현 완료, 통합 검증 진행 중

## 목표와 작업 경계

이번 작업은 다음 다섯 항목을 한 묶음으로 구현하되, 각 기능의 소유 파일과 회귀 테스트를 분리한다.

1. 라이브 방향키 이동·깊은 되감기 뒤 강제 라이브 복귀 수정 및 가짜 캐시 저장량 옵션 삭제
2. 미리보기 볼륨을 설정값으로 고정
3. 다시보기에서 Space를 길게 누르는 동안 2배속
4. `/lives` 미리보기 우클릭 집중 모드에서 진행 시간 숨김 및 가능한 범위의 화질 상향
5. 다시보기 채팅 영역에 댓글 탭 추가

현재 작업 트리에는 `followingPreviewTooltip.js`, `categoryTools.js`, 설정·테스트·README 등의 미커밋 작업이 이미 있다. 이를 되돌리거나 별도 기능을 덮어쓰지 않고 현재 상태 위에 필요한 변경만 추가한다. 버전 증가, 커밋, push, 태그, Release는 이번 요청 범위에 포함하지 않는다.

## 사전 실측과 판단

### 라이브 위치 유지

- `skipLivePauseResumeDepthMinutes`는 HLS·플레이어 캐시 양을 바꾸지 않는다. 확장이 기억한 위치를 보호할지 결정하는 기본 120분 임계값일 뿐이다.
- 실제 이동 가능 범위는 매 순간 `HTMLVideoElement.seekable`로 결정된다.
- 현재 가드는 120분보다 깊은 위치에서 보호 상태를 지우므로, 그 뒤 플레이어가 라이브 엣지로 점프하면 복원할 정보가 없다.
- 강제 라이브 점프가 짧은 간격으로 연속 발생하면 첫 점프는 복원해도 두 번째 점프가 복원 쿨다운에 걸린다. 현재 코드는 이 두 번째 라이브 엣지 값을 새 정상 상태처럼 처리해 기존 보호 상태를 지울 수 있다.

### 현재 치지직 다시보기 DOM

2026-07-11 실제 다시보기에서 다음 구조를 확인했다.

- 우측 채팅 다시보기 패널: `aside#vod-aside`
- 하단 네이티브 댓글 루트: `#commentArea`
- 댓글 타임라인: `button[type="button"]` 안의 `H:MM:SS` 또는 `MM:SS` 텍스트
- 두 영역은 같은 `#root` 아래에 있지만 서로 다른 React 레이아웃 가지에 있다.

네이티브 댓글 노드를 채팅 패널로 직접 옮기면 React 재렌더와 이벤트 위임을 깨뜨릴 수 있다. 원본은 제자리에 두고, 우측 패널에는 댓글 정보만 추출해 좁은 폭에 맞춘 확장 소유 읽기 전용 UI로 다시 렌더한다.

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
- 댓글 탭은 `#commentArea`에서 댓글 수, 정렬 상태, 작성자·작성 시각·아바타·본문·타임코드·첨부 이미지와 페이지 정보만 추출한다. 본문용 해시 클래스와 넓은 레이아웃 DOM은 복제하지 않는다.
- 추출한 정보는 `도구 모음 → 댓글 목록 → 페이지 이동` 구조의 확장 소유 DOM으로 렌더하고, 353px 우측 패널에 맞춘 치지직 시맨틱 색상·타이포·간격을 적용한다.
- 원본 댓글의 MutationObserver 변화를 짧게 묶어 댓글 탭이 보일 때만 반영한다. 댓글 정렬·페이지 이동으로 원본이 교체되면 새 `#commentArea`를 다시 연결한다.
- 댓글 탭에서는 댓글 읽기, 정렬·새로고침·페이지 이동, 타임코드 이동만 제공한다. 댓글 작성, 버프/반응, 삭제·신고 등 외부 상태를 바꾸는 조작은 노출하거나 전달하지 않는다.
- 타임코드 클릭은 `MM:SS`/`H:MM:SS`를 파싱해 현재 메인 VOD의 `currentTime`만 바꾸고, 페이지 스크롤이나 댓글 탭 선택은 유지한다.
- 댓글 탭 선택 시 네이티브 채팅 콘텐츠만 숨기고, 채팅 탭으로 돌아오면 그대로 복원한다. 원본 하단 댓글은 이동·삭제하지 않는다.
- SPA 이동, 옵션 끄기, aside 교체 때 주입 UI·observer·aria 상태를 정리한다.

회귀 기준:

- 댓글 탭에서 원본 댓글 텍스트·정렬 상태·페이지가 갱신된다.
- 타임코드를 여러 번 자유롭게 눌러도 댓글 패널 스크롤과 영상 재생 상태가 유지된다.
- 채팅 탭 전환, 새 VOD SPA 이동, 댓글/aside DOM 교체, 옵션 끄기 뒤 중복 UI나 observer가 남지 않는다.
- 라이트·다크 모드와 좁은 우측 패널에서 탭, 포커스 표시, 스크롤이 읽기 쉽게 유지된다.

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
