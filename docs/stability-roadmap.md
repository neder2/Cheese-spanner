# Better Chzzk 안정화 로드맵 — 작업 지시서

> 이 문서는 다음 작업 세션(AI 모델 포함)이 사전 맥락 없이 바로 실행할 수 있도록 쓴 지시서다.
> 작성일: 2026-07-07 / 기준 버전: 1.2.1 (브랜치 1.2.2)
> **핵심 방침: 새 기능 추가는 아래 1~4단계가 끝날 때까지 동결한다.**

## 선행 조건 — 1.2.2 작업 마무리가 먼저다

2026-07-07 기준 작업 트리에 **34개 파일, +2,029/-275 줄의 미커밋 변경**(1.2.2 진행분)이
있다. 여기에는 chatTools 행 탐지 수정(docs/chat-tools-row-detection-fix-plan.md 참조)과
테스트 확장이 포함된다. **이 로드맵의 리팩토링을 미커밋 기능 변경 위에 얹지 말 것** —
회귀가 나면 원인 분리가 불가능해진다. 순서:

1. 1.2.2 릴리스 작업을 먼저 완결한다 (AGENTS.md 릴리스 규칙: manifest.json과
   package.json 버전 동시 인상, docs/update-history.md 갱신, 기능·옵션·권한 변경 시
   README.md 갱신).
2. 단, 이 로드맵이 만든 파일들(shared/selectors.js 신규, manifest.json의 로드 순서
   1줄, docs/stability-roadmap.md)은 dead code라 1.2.2에 포함해도 무해하고,
   빼고 싶으면 그 두 변경만 스테이징에서 제외하면 된다.
3. 릴리스 후 깨끗한 트리에서 1단계 치환을 시작한다.

## AGENTS.md와의 관계 (반드시 준수)

AGENTS.md가 이 저장소의 상위 지침이다. 로드맵 작업에 특히 걸리는 조항:

- **Fallback 금지**: 정상 경로가 성립하지 않으면 우회 구현을 만들지 말고 원인을
  고치거나 차단 근거를 보고한다. watchSelector는 "감지·보고" 장치이지 폴백 분기가
  아니므로 이 원칙과 충돌하지 않는다 — 경고 후 대체 동작을 넣으면 그때 위반이다.
- **파일 헤더 우선**: 모든 JS 소스 최상단에 역할·의존·구조 헤더 주석이 있다.
  치환 작업 시 파일을 통독하지 말고 헤더부터 읽어라 (토큰 절약 겸 규칙 준수).
  치환 후 해당 파일 헤더의 의존 설명도 갱신할 것.
- **UI는 화이트/다크 모드 모두 고려**: darkTheme 키 관련 작업 시 하드코딩 금지,
  네이티브 추종 우선순위는 AGENTS.md 구현 원칙 절 참조.
- **release-safety.test.js가 shared/·features/ 등 런타임 파일을 금지 패턴 스캔**한다
  (dynamic import 등). 새 shared 파일도 스캔 대상이므로 금지 패턴을 넣지 말 것.
  스모크 스크립트는 tests/ 하위라 스캔 대상 밖이다.

## 세션 예산 배분 (사용량 한도가 있는 환경 기준)

- **세션당 목표를 하나로 제한한다.** 권장 단위: "1단계 N차 묶음 하나" 또는 "2단계 스크립트 하나".
  1단계 전체를 한 세션에 끝내려 하지 말 것 — 치환 품질이 떨어지고 검증이 밀린다.
- 조사는 이미 끝났다(부록). **세션 시작 시 grep 재조사 금지** — 이 문서와
  shared/selectors.js 를 읽는 것으로 대체한다. 예외: 치환 중 부록과 실제 코드가
  다를 때만 해당 파일을 직접 읽는다 (그 경우 부록도 고친다).
- 각 세션 종료 시 이 문서의 해당 항목에 완료 표시(~~취소선~~ + 날짜)를 남긴다.
  이 문서가 세션 간 진행 상황의 단일 공급원이다.

## 배경 (왜 이 순서인가)

Better Chzzk는 치지직의 **비공개 DOM 클래스 해시**(`live_chatting_list_wrapper__xyz` 류)와
**비공개 API**(api.chzzk.naver.com, apis.naver.com)에 전면 의존하는 MV3 확장이다.
총 ~34,500줄, features/ 24개 파일. 실제 장애는 거의 항상 "치지직 쪽 변경"으로 발생하며,
기존 모의 DOM 테스트로는 이를 감지할 수 없다.

실사례: 고정공지가 있는 방송에서 chatRoot 자체에 `_exist_fixed_message_` 클래스가 붙어
`closest()` 행 탐색이 루트에 매치되면서 새 채팅이 전부 무시된 버그
(상세: docs/chat-tools-row-detection-fix-plan.md). 이런 유형의 장애는 조용히 발생하고
사용자가 한참 뒤에 발견한다. 아래 작업의 목적은 "치지직이 변해도 버티고, 못 버티면
즉시 알아차리는" 구조를 만드는 것이다.

---

## 1단계 — 셀렉터/엔드포인트 레지스트리 중앙화 + 자가 진단 (최우선)

### 목표

치지직 의존 지점(DOM 셀렉터, API 엔드포인트)을 한 곳으로 모으고,
셀렉터가 실효되면 콘솔 경고로 즉시 드러나게 한다.

### 실측으로 확인된 현재 상태 (2026-07-07, 부록 참조)

- 이 코드베이스는 이미 정확한 클래스 해시 대신 `[class*='...']` 퍼지 매칭과
  **여러 후보를 순서대로 시도하는 폴백 체인**을 쓴다
  (예: 제목 = `live_title`→`liveTitle`→`title_text`→`title`,
  썸네일 = `thumb`→`thumbnail`→`live_image`→`liveImage`).
  따라서 이 단계의 진짜 작업은 "해시 제거"가 아니라 **파일마다 중복된
  폴백 체인을 레지스트리로 통합**하는 것이다. 같은 썸네일 체인이
  followingPreviewTooltip.js 안에서만 3번 반복된다.
- `[class*=` 를 쓰는 파일은 features 14개 + content.js. 자기 소유 클래스
  (`.bcmb-*`, `.bcfp-*` 등 bc 접두사)와 `data-*` 속성 셀렉터는 치지직 의존이
  아니므로 **레지스트리 대상에서 제외**한다.
- content.js 는 이미 `window.BetterChzzk.utils` 허브다(라우트 감지 이벤트
  재배포, `createMutationObserverSync`, `injectStyleOnce`). 레지스트리도
  별도 파일보다 **이 utils 네임스페이스에 얹는 것**이 로드 순서상 자연스럽다
  — 단, content.js가 이미 457줄이므로 `shared/selectors.js`로 분리하고
  content.js 앞 로드 순서에 넣는 것도 무방. 어느 쪽이든 참조 방식은
  `window.BetterChzzk` 경유로 통일한다.

### 작업

1. ~~`shared/selectors.js` 신설 + manifest 로드 순서 등록~~ **완료(2026-07-07)**:
   `BetterChzzk.selectors`로 CHZZK 체인 레지스트리·queryChain/queryChainAll·
   watchSelector가 등록돼 있고 manifest에서 shared/data.js 다음에 로드된다.
   2026-07-10에 manifest의 정확한 로드 순서, 체인 우선순위, 구형 팝업 클래스 범위,
   watchSelector의 키별 1회 경고를 테스트로 고정했고 npm test 177개 통과를 확인했다.
   **단, 체인은 grep 실측 씨앗이라 아직 어느 feature와도 연결되지 않았다(dead code
   상태가 정상).** 치환하면서 실제 사용처와 대조해 체인 순서·구성을 확정하고 파일
   상단 사용처 주석을 갱신할 것.
   MAIN world 스크립트(routeBridgePage.js, autoQualityPage.js, volumeWheelPage.js)는
   별도 world라 이 파일을 공유할 수 없으니 **범위에서 제외**한다.
2. features/\*.js 전체에서 치지직 DOM 의존 패턴을 수집한다. 탐색 정규식 예:
    - `querySelector` / `querySelectorAll` / `closest` 호출의 문자열 인자
    - `class*=`, `className.includes(`, 정규식으로 클래스 해시를 매칭하는 부분
3. 수집한 셀렉터를 **의미 있는 키 이름**으로 레지스트리에 등록한다. 예:
    ```js
    const CHZZK_SELECTORS = {
        chatList: '[class*="live_chatting_list_wrapper"]',
        chatRow: '[class*="live_chatting_message_container"]',
        // ...
    };
    ```
    등록 시 각 항목에 사용처(파일명) 주석을 남긴다.
4. 각 feature는 문자열 리터럴 대신 레지스트리 키를 참조하도록 치환한다.
   **한 파일씩 치환 → `npm test` 통과 확인 → 다음 파일.** 일괄 치환 금지.
5. 자가 진단: 레지스트리에 헬퍼를 하나 추가한다.
    ```js
    // 셀렉터가 매치돼야 정상인 시점에 호출. N초(기본 15초) 내 매치 실패 시
    // console.warn('[Better Chzzk] selector stale: <key>') 1회 출력.
    watchSelector(key, root);
    ```
    각 feature의 "이 요소는 반드시 있어야 동작한다" 지점(채팅 리스트, 플레이어 등)에만
    삽입한다. 모든 셀렉터에 다는 게 아니라 **기능 생사를 가르는 앵커 셀렉터**에만 단다.

### 파일별 치환 실행 가이드 (2026-07-07 파일 단위 실측. 이 순서대로 1파일=1커밋)

`[class*=` 사용량 실측: chatTools 43 · followingPreviewTooltip 42 · categoryTools 18 ·
timeMachineLagLabel 16 · vodBroadcastClock 11 · monthlyBroadcastTime 10 · videoSearch 10 ·
titleTooltip 7 · volumeTooltip 7 · adblockPopup 5 · skipControl 5 · content.js 3 · autoQuality 2.
(autoQualityPage 2 · volumeWheelPage 5 는 **MAIN world라 치환 제외** — 건드리지 말 것)

**1차 — 워밍업 (작고 독립적, 회귀 위험 최소):**
| 파일 | 사용할 레지스트리 키 |
|---|---|
| autoQuality.js | playerRoot |
| content.js | playerRoot |
| volumeTooltip.js | playerRoot, volumeControl, volumeSlider |
| skipControl.js | playerRoot, playerBottomButtons, playerPlaybackSwitch (+`left`는 playerRoot 하위 탐색으로 흡수 검토) |
| adblockPopup.js | popupContainer, popupDimmed |

**2차 — 중간 규모:**
| 파일 | 키 |
|---|---|
| titleTooltip.js | liveTitle(→`title` 폴백), darkTheme (+카드 셀렉터 `card/item/video`는 레지스트리에 `videoCard` 키 신설) |
| timeMachineLagLabel.js | liveStatus, liveButton, liveTime, chatBadge(icon/dot/badge 체인), playerRoot, playerBottomButtons |
| vodBroadcastClock.js | vodTitle(5종 체인 전부 이 파일 소유), playerRoot, playerBottomButtons |

**3차 — 전용 테스트가 있는 파일 (치환 후 해당 테스트로 즉시 검증):**
| 파일 | 키 | 검증 |
|---|---|---|
| chatTools.js | chatRoot, chatRow, chatNickname, chatText (+toolbar/header는 `chatToolbar` 키 신설) | tests/chat-tools.test.js |
| followingPreviewTooltip.js | thumbnail(**파일 내 5회 중복 — 통합 효과 최대**), liveTitle, channelName, sidebar, followingItem, darkTheme | tests/following-preview-tooltip.test.js |

**4차 — 대형 파일:**
| 파일 | 키 |
|---|---|
| videoSearch.js | pagination, watchProgress |
| monthlyBroadcastTime.js | darkTheme(10회 — 이 파일이 다크 감지 최대 수요처) |
| categoryTools.js | categoryFilterBar, channelName(name_text 4회), liveTitle (+카드 정보 `information/link/time`은 `videoCardInfo` 키 신설) |

치환 중 레지스트리에 없는 체인을 만나면 즉석에서 키를 신설하되, 신설도 같은 커밋에 포함하고
selectors.js 상단 사용처 주석을 갱신한다. 기존 코드의 체인 순서가 레지스트리 씨앗과 다르면
**기존 코드 순서가 정답이다** (씨앗은 grep 수집이라 순서 보장이 없음).

### MAIN world 3개 파일 전략 (치환 제외 대상의 관리 방법)

`routeBridgePage.js`(셀렉터 0개), `autoQualityPage.js`(2개: pzp/player),
`volumeWheelPage.js`(5개: pzp/volume 계열)는 페이지 컨텍스트라 `BetterChzzk`
전역에 접근할 수 없다. 각 파일 헤더에 명시돼 있듯 isolated world와의 통신은
DOM attribute + CustomEvent 중계로만 이뤄진다 (예: volumeWheel.js가
`data-betterchzzk-volume-wheel-options`로 옵션을 넘겨줌).

관리 방침:

- **셀렉터 리터럴을 그대로 둔다.** attribute로 셀렉터 문자열을 중계하는 방식은
  가능은 하지만 로드 타이밍 의존과 복잡도가 늘어 이득이 없다 (총 7개뿐).
- 대신 두 파일의 해당 리터럴 옆에 `// registry: playerRoot` / `// registry: volumeControl`
  형태의 **상호 참조 주석**을 단다. 치지직이 클래스를 바꾸면 레지스트리와 이 두 파일을
  같이 고치라는 표식이다. shared/selectors.js 헤더에도 역방향 참조를 남긴다.
- 스모크 테스트의 `playerRoot`/`volumeControl` 검사가 사실상 이 파일들의 셀렉터도
  함께 검증한다 (같은 체인이므로) — 별도 검사 불필요.

### watchSelector 앵커 권장 배치 (기능 생사를 가르는 지점만)

- chatTools → `chatRoot` / volumeTooltip·skipControl → `playerRoot`
- followingPreviewTooltip → `sidebar` / vodBroadcastClock → `vodTitle`
- categoryTools → `categoryFilterBar`
- 나머지 기능은 달지 않는다 (경고 소음 방지).

### 주의

- 이 단계에서 **동작 변경은 0이어야 한다.** 순수 이동/치환만.
- 셀렉터 문자열을 "개선"하려는 유혹을 참을 것. 옮기기만 한다.
- `closest()` 탐색은 위 실사례처럼 루트 매치 함정이 있으니, 치환 과정에서
  기존 가드 로직(루트 도달 시 중단 등)을 절대 단순화하지 말 것.

### 완료 기준

- features/_.js 에 치지직 의존 `[class_=`폴백 체인 리터럴이 남아 있지 않다
(MAIN world 3개 파일과 자기 소유`.bc*`/`data-*` 셀렉터는 제외).
- `npm test` (`node --test`) 전부 통과, `npm run lint` 통과.
- 실기 스모크(2단계 스크립트 또는 수동)로 채팅/플레이어 관련 기능 정상 확인.

---

## 2단계 — 실기 스모크 테스트 1개

### 목표

실제 치지직 페이지에서 레지스트리의 앵커 셀렉터들이 살아 있는지 확인하는
스크립트 하나. 유닛 테스트가 못 잡는 "치지직 변경"을 잡는 유일한 수단이다.

### 작업

1. `tests/smoke/` 에 Node 스크립트 작성. CDP(chrome-remote-interface 또는
   puppeteer-core)로 실제 Chrome을 띄운다.
2. **중요 (실측 사실): Chrome 137+는 `--load-extension` 플래그를 무시한다.**
   확장 로드는 CDP의 `Extensions.loadUnpacked` 명령을 사용해야 한다.
   (`--remote-debugging-port` + CDP 연결 후 loadUnpacked 호출)
3. 흐름: 치지직 메인 접속 → 라이브 목록에서 첫 방송 URL 추출 → 입장 → 5~10초 대기 →
   레지스트리의 검사 대상 키 각각에 대해 `queryChain` 로직과 동일한 평가
   (체인을 앞에서부터 시도) → 실패 목록 출력, 실패 있으면 exit code 1.
   **어느 폴백 단계에서 매치됐는지도 출력할 것** — 1순위가 아닌 하위 폴백으로만
   매치되기 시작하면 치지직 변경의 조기 신호다 (아직 안 죽었지만 곧 죽을 수 있음).
4. 검사 대상 키 (비로그인 라이브 페이지에서 확인 가능):
   `playerRoot`, `playerBottomButtons`, `volumeControl`, `chatRoot`, `chatRow`,
   `liveTitle`, `channelName`, `sidebar`, `followingItem`(비로그인은 스킵 허용),
   메인 페이지에서: `thumbnail`, `videoCard`(신설 후).
   스킵 목록(로그인/특정 상태 필요): `watchProgress`(시청 기록), `popupContainer`
   (광고 팝업 떠야 존재), `pagination`(검색 결과 페이지 필요), `categoryFilterBar`
   (카테고리 페이지 필요 — 여력이 되면 카테고리 페이지도 방문해 검사).
5. package.json에 `npm run smoke` 스크립트 등록. CI 연동은 하지 않는다
   (로컬 수동 실행 도구로 시작).

### 의사코드 (구현 시 이 흐름을 따를 것)

```
1. 임시 프로필 디렉터리 생성 (기존 브라우징 데이터와 격리)
2. chrome.exe 를 --remote-debugging-port=<포트> --user-data-dir=<임시 프로필>
   --no-first-run 으로 실행 (--load-extension은 137+에서 무시되므로 쓰지 않는다)
3. CDP 연결 → Extensions.loadUnpacked({ path: 저장소 루트 }) → 확장 ID 확보
4. Page.navigate("https://chzzk.naver.com/") → load 이벤트 대기
5. Runtime.evaluate 로 메인 페이지 검사 대상 키(thumbnail 등) 평가
6. 라이브 목록 첫 항목의 href 추출 → Page.navigate(방송 URL) → 8초 대기
   (플레이어·채팅 lazy 렌더 대기. networkIdle보다 고정 대기가 안정적)
7. 검사 대상 키마다: 체인을 index 0부터 querySelector 시도 →
   { key, matchedIndex | null } 수집
8. 리포트 출력:
   - null      → FAIL (셀렉터 실효)
   - index > 0 → WARN (1순위 폴백 실효 — 치지직 변경 조기 신호)
   - index 0   → PASS
9. 브라우저 종료, 임시 프로필 삭제. FAIL 있으면 exit 1, WARN뿐이면 exit 0
   (경고는 출력으로만 전달)
```

- 의존성은 devDependencies에 최소로 (chrome-remote-interface 또는 puppeteer-core
  중 하나만). vendor/ 나 런타임 파일에는 아무것도 추가하지 않는다.
- Chrome 실행 파일 경로는 Windows 기본 설치 경로 탐색 + `CHROME_PATH` 환경변수
  오버라이드 순으로 찾는다.
- 로그인 상태를 가정하지 않는다. 로그인 필요 키는 문서 상단 스킵 목록 참조.

### 완료 기준

- `npm run smoke`에서 비로그인으로 항상 확인 가능한 필수 키는 전부 PASS이고 FAIL은 0개.
- 로그인·특정 화면 상태가 필요한 조건부 키는 PASS 또는 사전에 명시한 사유의 SKIP을 허용한다.
  WARN은 하위 체인 매치를 분명히 출력하되 exit code 0, FAIL은 exit code 1로 처리한다.
- 셀렉터 하나를 일부러 틀리게 바꾸면 FAIL이 나는 것 확인(음성 검증).

---

## 3단계 — git 위생 (⚠ AGENTS.md 규칙과 충돌 — 사용자 결정 필요)

### 초판 오류 정정

초판은 "커밋 메시지가 전부 동일한 것"을 문제로 지목했으나, **AGENTS.md가
커밋 제목을 `Better Chzzk <version>` 형식으로 통일하도록 명시**하고 있다.
즉 이는 실수가 아니라 프로젝트 규칙이다. 로드맵이 AGENTS.md를 임의로
뒤집을 수 없으므로, 아래는 **규칙을 지키면서** bisect 가능성을 확보하는 절충안이다.

### 절충안 (AGENTS.md 개정 없이 가능)

1. 커밋 **제목**은 규칙대로 `Better Chzzk <version>` 유지.
   **본문(body)에 변경 내용 한 줄을 필수로** 추가한다. 예:

    ```
    Better Chzzk 1.2.2

    selectors: volumeTooltip 셀렉터를 레지스트리 참조로 치환 (동작 변경 없음)
    ```

    `git log --oneline`으로는 여전히 구분이 안 되지만 `git log --format='%h %b'`와
    `git bisect`는 가능해진다.

2. 릴리스 시점에 `git tag v1.2.2` 태그. 과거 커밋은 건드리지 않는다(히스토리 재작성 금지).
3. 리팩토링 작업은 "1파일=1커밋" 원칙을 지킨다 — 제목이 같아도 커밋이 잘게
   쪼개져 있으면 회귀 지점 추적이 된다.

### 사용자 결정 대기 항목

커밋 제목 자체에 요약을 허용하도록 AGENTS.md를 개정할지는 **사용자만 결정할 수
있다.** 다음 세션은 개정 없이 위 절충안으로 진행하고, 사용자가 개정을 원하면
AGENTS.md의 "대화·커밋·릴리스 규칙" 절을 함께 수정한다.

---

## 4단계 — 공통 계층 추출 리팩토링

### 목표

대형 feature 파일(categoryTools 4,294줄 / monthlyBroadcastTime 2,591줄 /
videoSearch 2,399줄 / chatTools 2,015줄 / skipControl 1,979줄)에 반복 구현된
패턴을 shared/ 로 추출한다. **1~2단계가 끝난 뒤에만 착수한다**
(스모크 테스트가 있어야 리팩토링 회귀를 잡을 수 있으므로).

### 작업

1. 실측 결과(부록), **observer/라우트/스타일 주입은 이미 content.js utils로
   중앙화돼 있다** — 이건 추출 대상이 아니다. 남은 실측 확인된 후보:
    - **API 클라이언트 계층**: api.chzzk.naver.com / apis.naver.com 직접 fetch가
      6개 파일에 분산(categoryTools, followingPreviewTooltip, liveWatchHistory,
      monthlyBroadcastTime, videoSearch, vodBroadcastClock). 단, 저수준
      `fetchJson`(타임아웃+credentials)은 **이미 shared/data.js utils에 있으므로**
      재발명하지 말 것 — 추출 대상은 그 위층인 엔드포인트 URL 구성·공통 에러 처리·
      커서 페이징 루프(lives API는 size 최대 50, sortType 3종뿐)다.
      `shared/api.js` 신설 또는 shared/data.js 확장 중 택일.
    - **다크 테마 감지**: `[class*="dark"]` 판정이 4개 파일에 총 19회 반복된다.
      테마 감지 헬퍼 1개로 통합.
    - 패널/오버레이 UI 생성 보일러플레이트 (categoryTools 4,294줄 /
      monthlyBroadcastTime 2,591줄의 자기 소유 `.bc*` UI 부분).
2. **가장 중복이 심한 패턴 하나만** 골라 `shared/ui.js` 또는 `shared/observe.js`로
   추출하고, 사용처를 한 파일씩 이관한다. 파일당: 이관 → `npm test` →
   `npm run smoke` → 커밋(3단계 규칙대로).
3. 한 사이클(패턴 1개 완료) 후 멈추고 사용자에게 결과를 보고한다.
   여러 패턴을 한 번에 걷어내려 하지 말 것.

### 주의

- 기존 docs/refactoring-guide.md, docs/optimization-plan.md 가 있다면 착수 전
  한 번 읽고 중복 계획을 만들지 말 것.
- 추출은 "동작 동일" 원칙. 추출하면서 버그 수정을 섞지 말고, 발견한 버그는
  별도 커밋으로 분리한다.

---

## 5단계 — 그 이후에만: 새 기능

1~4가 끝나면 기능 추가를 재개해도 된다. 새 기능 1건의 절차 체크리스트:

**설계 시:**

- [ ] 치지직 의존 셀렉터는 `shared/selectors.js` 경유. 새 체인이 필요하면 키 신설 + 사용처 주석.
- [ ] 기능 생사를 가르는 앵커가 있으면 `watchSelector` 1개 배치 (남용 금지).
- [ ] API 호출은 shared 계층(fetchJson 또는 4단계 이후의 api 계층) 경유.
- [ ] Fallback 금지 원칙 검토: 정상 경로가 막힐 때의 동작은 "조용한 대체"가 아니라
      "명시적 중단 + 사유"여야 한다.
- [ ] 실행 컨텍스트 결정: isolated world로 충분한가? MAIN world가 필요하면
      attribute/CustomEvent 중계 설계까지 포함 (volumeWheel ↔ volumeWheelPage 패턴 참조).

**구현 시:**

- [ ] 파일 최상단 헤더 주석 (역할·실행 컨텍스트·의존·옵션 키·통신 — 기존 파일 양식 준수).
- [ ] 옵션이 있으면 shared/settings.js의 OPTION_SCHEMA에 추가 (기본값·정규화 자동 파생).
      options.html에 data-option 연결 — settings.test.js가 키 일치를 강제한다.
- [ ] UI는 화이트/다크 모드 모두. 색·크기 하드코딩 금지 (AGENTS.md 구현 원칙).
- [ ] options 팝업 UI를 건드리면 좁은 팝업 폭에서 먼저 확인.

**검증·마감 시:**

- [ ] 테스트 추가 (기존 스타일: 실제 치지직 마크업 픽스처 기반 — tests/chat-tools.test.js 참조).
- [ ] 스모크 테스트 검사 대상에 새 앵커 키 추가.
- [ ] `npm test` + `npm run lint` + (UI 변경 시) 실기 확인.
- [ ] 릴리스 문서: update-history.md(사용자 관점 서술), README(기능 상세·설정 표·권한),
      manifest.json + package.json 버전 동시 인상.
- [ ] 새 권한이 필요하면 optional 권한 우선 검토 (1.2.1의 pstatic.net 선택 권한 전환 선례).

---

## 릴리스 노트(update-history.md) 작성 양식 — 이 로드맵 작업분 반영 방법

docs/update-history.md 는 사용자 대상 문서다. 실측한 기존 양식(1.2.1 항목 기준):

- 버전 헤더: `## <버전> (YYYY-MM-DD)` / 하위 분류: `### 새 기능`, `### 탐색 및 옵션 화면`,
  `### 수정 및 안정화`, `### 문서`
- 문체: 존댓말 합니다체("바꿨습니다", "고쳤습니다"). **사용자 체감 관점**으로 서술하고
  내부 용어(레지스트리, 셀렉터, 폴백 체인 등)를 쓰지 않는다.
- 특수문자 나열 대신 한글로 풀어쓴다 (options 팝업 등 좁은 화면 가독성 원칙과 동일).

이 로드맵 작업분의 반영 규칙:

- **동작 변경 0인 치환·추출 커밋**은 릴리스 노트에 항목별로 나열하지 않는다.
  해당 릴리스의 "수정 및 안정화"에 다음 한 줄로 묶는다:
  "치지직 화면 구조 변경에 더 잘 견디도록 내부 구조를 정리했습니다. 사용 방법이나
  동작 변화는 없습니다."
- watchSelector 경고가 처음 포함되는 릴리스에는 한 줄 추가:
  "치지직 개편으로 일부 기능이 화면 요소를 찾지 못하면 개발자 도구 콘솔에 경고를
  남기도록 했습니다."
- 스모크 테스트(2단계)는 개발 도구라 릴리스 노트 대상이 아니다. "### 문서" 또는
  생략.

## 공통 규칙 (모든 단계)

- 각 단계는 독립 커밋(들)로. 단계를 섞은 거대 커밋 금지.
- `npm test` 는 매 커밋 전 실행. (테스트 러너는 package.json 확인)
- options.html은 default_popup 기준의 **좁은 팝업**이 1차 환경이다.
  UI를 건드릴 일이 있으면 좁은 폭에서 먼저 확인할 것.
- 치지직 API/DOM에 대해 확신이 없으면 실측 우선. 문서의 기존 실측 기록:
  docs/ 폴더 및 chat-tools-row-detection-fix-plan.md 참조.
- 막히면 우회 구현으로 뭉개지 말고, 막힌 지점과 근거를 남기고 사용자에게 보고.

---

## 부록 — 실측 인벤토리 (2026-07-07 grep 실측. 다음 세션은 이 조사를 반복하지 말 것)

### 빌드/테스트 명령 (package.json)

- `npm test` → `node --test` (Node 내장 러너)
- `npm run lint` → eslint / `npm run format:check` → prettier

### 셀렉터 호출 밀도 (querySelector·closest 호출 수)

categoryTools 128 · videoSearch 45 · monthlyBroadcastTime 29 · chatTools 25 ·
followingPreviewTooltip 13 · vodBroadcastClock 12 · skipControl 10 · 나머지는 한 자릿수.
단, 대부분은 자기 소유 UI(`.bcmb-*` 등)나 범용 태그(`img`, `video`, `a[href]`) 셀렉터이고
치지직 의존은 `[class*=` 계열에 집중돼 있다.

### 치지직 의존 `[class*=` 폴백 체인 (레지스트리 등록 씨앗)

- 플레이어: `pzp`, `pzp-pc`, `video_player`, `player` / 볼륨: `volume-control`,
  `volume-button`, `volume`, `slider` / 하단바: `bottom-buttons`, `playback-switch`, `left`, `right`
- 채팅: `chatroom`/`chat-room`/`chatting_area`/`chat_area`/`live_chatting`/`chatting`/`chat` +
  행: `row`/`item`/`message`/`comment` + 닉네임: `nickname`/`nick`/`author`/`name` +
  본문: `message`/`content`/`text`/`comment` + 뱃지: `icon`/`Icon`/`dot`/`Dot`/`badge`/`Badge`
- 제목: `live_title`/`liveTitle`/`title_text`/`title`, `vod_title`/`video_information_title`/
  `video-info-title`/`videoInfoTitle`/`VideoInfo_title`
- 채널명: `name_text`/`channel_name`/`channelName`/`nickname`/`name`
- 썸네일: `thumb`/`thumbnail`/`live_image`/`liveImage` (followingPreviewTooltip 내 3회 중복)
- 사이드바/팔로잉: `sidebar`/`side_bar`/`aside`/`navigation`, `following`/`follow`,
  `live-status`/`LiveStatus`, `live-button`/`LiveButton`, `live_time`/`live-time`/`LiveTime`
- 목록/페이징: `navigation_component_filter`, `Pagination`/`Paging`/`pagination`/`paginator`/`paging`(i)
- 시청기록: `progress`/`history`/`played`/`playback`/`resume`(i)
- 팝업: `popup_container__`, `popup_dimmed__`, `overlay`/`backdrop`/`dimmed`
- 테마: `[class*="dark"]` — 4개 파일에 총 19회 분산
  (monthlyBroadcastTime 10 · followingPreviewTooltip 7 · chatTools 1 · titleTooltip 1).
  ※ 초판에서 "한 파일 30회"라고 썼던 것은 grep 중복 집계 오류. 이 수치가 실측이다.
- 카드: `card`/`item`/`video`, `information`/`link`, `toolbar`/`header`(대소문자 변형)

`[class*=` 사용 파일(15개): adblockPopup, autoQuality, autoQualityPage, categoryTools,
chatTools, followingPreviewTooltip, monthlyBroadcastTime, skipControl, timeMachineLagLabel,
titleTooltip, videoSearch, vodBroadcastClock, volumeTooltip, volumeWheelPage, content.js

### API 직접 호출 (shared/api.js 추출 대상)

- 엔드포인트: `api.chzzk.naver.com/service`, `/service/v1/channels`, `/service/v1/live`,
  `/service/v2/channels`, `/service/v2/videos`, `apis.naver.com/nng_main/nng_comment_api/v1`
- 호출 파일(6개): categoryTools(1) · followingPreviewTooltip(2) · liveWatchHistory(1) ·
  monthlyBroadcastTime(2) · videoSearch(2) · vodBroadcastClock(1)
- shared/data.js·background.js에는 API URL 없음 → API 계층이 아직 없다는 뜻.

### 치지직 실측 지식 모음 (과거 세션 실기 측정 결과 — 재측정 불필요)

**lives API (2026-07-06 실측):**

- `sortType`은 3종뿐이며 size 파라미터 최대값은 50이다. 그 이상 요청해도 50으로 잘린다.
- LATEST 정렬 커서의 liveId를 조작하면 목록 끝으로 점프할 수 있다.
- 응답 파싱 시 맨숫자 19 자리 ID를 정규식으로 다룰 때 자릿수 가정 함정이 있다
  (상세: 과거 categoryTools 관련 작업 기록).

**HLS/플레이어 (2026-07-02~06 실측):**

- 일반 HLS는 `TARGETDURATION 10` 때문에 hls.js 시작점이 라이브 엣지에서 정확히
  30초 뒤다. LLHLS + lowLatencyMode 조합은 3~4초. `hls.light` 빌드도 LL-HLS를
  지원하므로 경량 빌드로 충분하다.
- CHZZK HLS 오디오는 muxed다. 소리 안 남 문제는 런타임 문제가 아니라
  브라우저 오토플레이 정책/unmute UX 문제다.
- timeMachineLagLabel 등 지연 표시 기능 검증 시 위 수치가 기준선이다.

**실기 검증 환경 (2026-07-04 실측):**

- Chrome 137+는 `--load-extension` 플래그를 무시한다. CDP `Extensions.loadUnpacked`가
  유일한 자동 로드 경로다 (2단계 스모크의 전제).
- 치지직 네이티브 단축키는 OS 키 반복(repeat keydown)에도 토글이 재발동한다 —
  키 입력 시뮬레이션으로 검증할 때 repeat 이벤트를 걸러야 오탐이 없다.

**고정공지 채팅 DOM (2026-07-07 실기 재현):**

- 고정공지가 있는 방송은 chatRoot 요소 자체에 `_exist_fixed_message_` 클래스가 붙는다.
  `closest()` 기반 행 탐색이 chatRoot에 매치되면 새 채팅이 전부 무시된다.
- 클린봇 차단 문구는 BLIND_SIGNAL_RE에 포함되지 않은 사례가 있었다.
- 풀스캔 시 wrapper 요소가 행을 삼키고 원문 캐시가 오염되는 문제도 함께 발견됨.
  상세: docs/chat-tools-row-detection-fix-plan.md.

### shared/api.js 인터페이스 스케치 (4단계용 — 구현 전 사용자와 형태 합의 권장)

shared/data.js의 `fetchJson`(타임아웃+credentials include)을 하부로 쓰고, 그 위에:

```js
BetterChzzk.api = {
    // 엔드포인트 상수 (부록의 6개 base URL을 여기로)
    ENDPOINTS: { ... },
    // 커서 페이징 전체 순회. size는 자동으로 50 상한. maxPages 필수(무한 루프 방지).
    fetchAllPages(endpoint, params, { maxPages, onPage }) → Promise<items[]>,
    // 단건 조회 + 공통 에러 처리(HTTP 에러/치지직 code 필드 검사)를 일원화
    fetchOne(endpoint, params) → Promise<content|null>,
};
```

원칙: 재시도·폴백 응답 생성 금지(AGENTS.md Fallback 금지). 실패는 null/예외로
정직하게 전달하고 호출측이 기능 단위로 처리한다.

### 테스트 지도 (2026-07-10 실측 — 총 177개, 리팩토링 시 안전망 위치)

| 파일                              | 개수 | 커버 범위                                                                                                       | 로드맵 작업과의 관계                                                                                                                                            |
| --------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| extension-pages.test.js           | 121  | content.js utils(createMutationObserverSync, 라우트 감지), shared fetchJson·selector registry, 옵션/기록 페이지 | **1단계 치환의 주 안전망.** selectors.js의 manifest 위치, 체인 우선순위, 구형 팝업 클래스 범위, watchSelector 1회 경고를 직접 검증한다                          |
| chat-tools.test.js                | 26   | 블라인드 원문 복원, 모아보기 수집 판정. **실제 치지직 마크업 픽스처** 포함                                      | 3차 chatTools 치환 직후 실행 필수                                                                                                                               |
| following-preview-tooltip.test.js | 14   | 미리보기 카드, LLHLS 우선/HLS 폴백, 썸네일 선택                                                                 | 3차 followingPreviewTooltip 치환 직후 실행 필수                                                                                                                 |
| release-safety.test.js            | 8    | 원격 코드 금지, 폴백 재도입 금지, **"optimization guards stay in the hot paths"**                               | ⚠ 함정: 핫 패스 최적화 가드의 존재 자체를 테스트가 강제한다. 4단계 추출 중 이 테스트가 깨지면 가드를 실수로 제거한 것이니 되돌릴 것 (테스트를 고치는 게 아니라) |
| reward-auto-collect.test.js       | 8    | 통나무 버튼 판정·쿨다운·해제                                                                                    | —                                                                                                                                                               |
| settings.test.js                  | 4    | OPTION_SCHEMA ↔ options.html data-option 키 일치 강제                                                           | 새 옵션 추가 시 자동 검문소                                                                                                                                     |

### vendor/ 내용

`hls.light.min.js` 하나 (+ LICENSE). followingPreviewTooltip의 미리보기 재생용.
LL-HLS 지원 확인됨(실측 지식 참조). release-safety가 muxed master 픽스처 유지를 강제한다.

### 이미 중앙화된 것 (재발명 금지)

content.js = `window.BetterChzzk.utils` 허브:

- 라우트 감지: MAIN world의 `betterchzzk:routechange` 이벤트를 받아
  `betterchzzk:routechange:detected`로 재배포 (`startPageChangeDetection`)
- `createMutationObserverSync`: 대상 노드 대기 + 분리 후 재연결 감시 옵저버 팩토리
- `injectStyleOnce`: 스타일 주입
- MutationObserver 직접 생성은 content.js(3), autoQualityPage(1, MAIN world),
  categoryTools(1)뿐 — 나머지는 이미 팩토리를 쓴다.
