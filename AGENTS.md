# Better Chzzk — 에이전트 작업 지침

이 문서는 대화 맥락 없이 저장소만 보고 작업하는 에이전트를 위한 안내서다.
모든 JS 소스 파일 최상단에 역할·의존·구조를 담은 헤더 주석이 있으니, 파일을 통독하기 전에 헤더부터 읽는다.

> **진행 중인 장기 작업**: 안정화 리팩토링 로드맵이 `docs/stability-roadmap.md`에 있다.
> 리팩토링·셀렉터 중앙화·스모크 테스트 관련 작업은 그 문서의 진행 상태를 먼저 확인하고 이어서 진행한다.

## 최상위 지침

- **Fallback 금지.** 기능이 정상 경로로 성립하지 않으면 우회 경로, 대체 UI, 임의 데이터, iframe/팝업/새 페이지, 조용한 실패 은폐를 추가하지 않는다. 먼저 정상 경로의 원인을 수정하고, 외부 서비스 변화처럼 직접 고칠 수 없는 경우에는 구현으로 보정하지 말고 차단 근거와 실패 조건을 보고한다.
- CSS 변수의 정적 fallback 값처럼 렌더러·테스트 환경에서 값 누락을 막기 위한 선언형 기본값은 예외로 둔다. 이 예외는 기능 동작을 대체하는 폴백 분기나 사용자에게 보이는 가짜 결과를 허용하지 않는다.

## 대화·커밋·릴리스 규칙

- 존댓말 사용.
- 커밋 제목의 첫 줄은 변경 내용 요약 대신 해당 변경이 속하는 릴리스 버전만 표시하는 `Better Chzzk <version>` 형식으로 통일한다. 예: `Better Chzzk 1.2.0`
- 버전 업데이트, GitHub 메인 머지, 릴리스 작업을 할 때는 GitHub Release 또는 업데이트 내역(`docs/update-history.md`)을 반드시 작성하거나 갱신한다.
- 버전은 `manifest.json`과 `package.json` 두 곳에 있다. 함께 올린다.
- 기능·옵션·권한이 바뀌면 README.md(기능 상세, 설정 항목 표, 권한 설명)도 같은 릴리스에서 갱신한다.

## 버그 수정 원칙

버그를 수정할 때는 보정용 우회 코드부터 만들지 말고, 기존 코드의 어느 경로가 어떻게 잘못되어 증상이 생겼는지 먼저 파악한다. 원인이 되는 기존 로직의 소유 표면에서 수정하는 것을 우선하며, 외부 서비스 변화처럼 직접 고칠 수 없는 원인일 때만 그 근거를 명확히 설명하고 보정 코드를 검토한다.

## 구현 원칙

- **UI는 화이트/다크 모드를 둘 다 고려해 만든다.** 치지직 디자인을 따라가는 요소는 색·크기를 하드코딩하지 말고 아래 우선순위로 네이티브를 따라간다:
    1. **치지직 CSS 디자인 토큰 참조(1순위).** 치지직은 `--Surface-*`, `--Content-*`, `--Border-*` 계열 디자인 토큰 1200여 개를 페이지 CSS 변수로 노출하며, 이 중 시맨틱 토큰들은 테마(`html.theme_dark`/`theme_light`)에 따라 값이 바뀐다(2026-07 실측). `var(--Surface-Neutral-Weaker, #1B1D20)`처럼 **다크 기준 fallback**과 함께 참조하면 다크 분기 셀렉터 없이 두 테마가 자동 대응된다. 자주 쓰는 쌍: 반전 강조 배경/텍스트 = `--Surface-Neutral-Strongest`/`--Content-Neutral-Inverse`, 팝업 배경 = `--Surface-Neutral-Weaker`, 기본/보조 텍스트 = `--Content-Neutral-Primary`/`--Content-Neutral-Cool-Base`, hover 오버레이 = `--Surface-Interaction-Lighten-Hovered`, 브랜드 강조 = `--Content-Brand-Base`·`--Surface-Brand-Alpha-Weak`·`--Border-Brand-Alpha-Base`. 선례: categoryTools.js 툴바·필터 메뉴, videoSearch.js.
    2. **네이티브 요소 계산 스타일 복사(2순위).** 토큰으로 표현이 안 되는 "옆 요소와 픽셀 단위로 똑같아야 하는" UI(칩 등)는 네이티브 요소의 getComputedStyle 값을 CSS 변수로 복사한다. 선례: categoryTools.js `syncFontWithHostUi`(툴바 폰트). **주의:** 색처럼 테마에 따라 달라지는 값을 복사하면 html class 변경을 감지해 재복사해야 한다. 복사 원본이 화면에 항상 존재하는 경우에만 안정적이다.
    3. **라이트/다크 셀렉터 분기(3순위).** 네이티브 대응물이 없는 확장 고유 UI(팝업 위젯 등)만 `[class*="dark"]` 계열 분기로 두 모드를 직접 스타일링한다(monthlyBroadcastTime.js 선례).
    - 공통: CSS 변수에는 항상 합리적인 fallback(다크 기준)을 함께 둔다 — jsdom 등 토큰이 없는 환경 대비.
- **폴백 금지는 최상위 지침을 따른다.** 정상 경로 하나를 정확하게 맞추는 것을 우선한다. "혹시 안 되면 이 방법도"식의 폴백 분기는 실제로는 안 타는 죽은 코드가 되거나, 오동작을 조용히 가리는 원인이 된다. 과거에 정리한 폴백이 되살아나지 않도록 `tests/release-safety.test.js`가 일부를 가드하고 있다("low-risk fallback reductions stay removed").
- **Chrome 웹 스토어 정책을 지킨다.** 이 확장은 스토어에 게시되므로 모든 변경이 심사 대상이다:
    - 원격 호스팅 코드 금지(MV3): 실행 코드는 전부 패키지 안에 있어야 한다. 외부 스크립트 로드, 동적 코드 실행 계열 API 금지 — `tests/release-safety.test.js`가 텍스트 수준으로 가드한다.
    - 최소 권한: 새 권한·host 권한은 정말 필요할 때만 추가하고, 상시 필요가 아니면 `optional_host_permissions` + 기능을 켤 때 `chrome.permissions.request`로 요청한다(pstatic.net 선례). 권한이 늘면 기존 사용자에게 재승인 경고가 뜨고 심사가 길어진다.
    - 단일 목적 유지: "치지직 시청 경험 개선"에서 벗어나는 기능(예: 다른 사이트 대상, 수집·전송)은 넣지 않는다.
    - 개인정보: 수집 데이터(시청 기록 등)는 로컬(`chrome.storage`)에만 두고 외부 전송하지 않는다. 데이터 취급이 바뀌면 `PRIVACY.md`와 스토어 개인정보 고지를 함께 갱신한다.
    - 권한·기능 설명이 바뀌면 README와 스토어 등록 정보 문구도 같은 릴리스에서 맞춘다.

## 프로젝트 개요

- "Better Chzzk" — 치지직(chzzk.naver.com)용 Chrome 확장. Manifest V3, 순수 vanilla JS, **빌드 단계 없음**.
- 번들러·`import`/`export`·ESM 도입 금지. `manifest.json`의 `content_scripts[].js` 배열 순서가 곧 의존성 그래프다. 새 공용 파일을 만들면 소비자보다 먼저 오도록 manifest에 등록한다.
- 각 기능 파일은 자기완결적 IIFE. DOM 마커는 `betterchzzk-*` id와 `data-bc??-*` 속성 프리픽스(기능별 약어: bcgt=categoryTools, bcvs=videoSearch, bcfp=followingPreview, bcct=chatTools, bctm=timeMachine, bctt=titleTooltip, bcmb=monthlyBroadcast, bcra=rewardAuto).

## 실행 컨텍스트 지도

콘텐츠 스크립트는 두 world로 나뉜다 (둘 다 `document_start`):

| world           | 파일                                                                                                                                             | 특징                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| MAIN (페이지)   | features/routeBridgePage.js, features/autoQualityPage.js, features/volumeWheelPage.js                                                            | `BetterChzzk.utils`·`BetterChzzkSettings` 접근 불가. isolated 측과 CustomEvent·DOM 속성으로 통신 |
| isolated (확장) | shared/settings.js → shared/data.js → content.js → 나머지 features/\* → vendor/hls.light.min.js → followingPreviewTooltip.js → shortcutRescue.js | 전역 네임스페이스 공유. 나열 순서 = 로드 순서                                                    |

그 외 컨텍스트:

- `background.js` — MV3 service worker. `importScripts("shared/settings.js")`로 settings를 로드하므로 **settings.js에서는 DOM API 사용 금지** (`globalThis`/`chrome`만).
- `options.html` + `options.js` — 액션 팝업(`action.default_popup`)이자 옵션 페이지(`options_page`). **확장 아이콘 클릭 시 열리는 작은 팝업 창이 1차 사용 환경**이므로 UI 작업·검증은 좁은 뷰포트 기준으로 한다. 작은 글씨에서 뭉개지는 특수문자 나열(",/." 등)은 한글로 풀어쓴다(예: "쉼표·마침표 키").
- `history.html` + `history.js` — 시청 기록 페이지. `chrome.storage.local`의 `betterChzzkLiveWatchHistory`를 읽는다.

## 공용 인프라

- **`BetterChzzkSettings`** (shared/settings.js): `OPTION_SCHEMA`가 옵션의 단일 공급원. 공개 API(`normalizeOptions`, `getOptions`, `addOptionsChangeListener`, `OPTION_KEYS`, `FEATURE_KEYS`, `DEFAULT_OPTIONS` 등)의 키 이름·시그니처는 background/options/모든 feature가 의존하므로 바꾸지 않는다.
- **`BetterChzzk.utils`**: shared/data.js(데이터·KST 날짜·시청 구간·스토리지 유틸)와 content.js(DOM·라우트·MutationObserver 유틸)가 병합 등록한다.
- 옵션 추가 절차: ① `OPTION_SCHEMA`에 항목 추가 → ② `options.html`에 `data-option` 입력 추가(의존 관계는 `data-depends-on`) → ③ feature에서 `bindFeatureOptions`로 구독 → ④ README 설정 표와 `docs/update-history.md` 갱신.
- 라우트 변경 감지: MAIN world의 routeBridgePage.js가 history API 훅으로 `betterchzzk:routechange`를 쏘고, content.js가 이를 받아 `betterchzzk:routechange:detected`로 feature들에 재배포한다. feature는 `startPageChangeDetection(handler)`만 쓰면 된다.

## 검증

- `npm test` — `node --test`. `tests/extension-pages.test.js`는 jsdom으로 options/history 페이지를 실제 구동한다.
- `npm run lint`(eslint), `npm run format:check`(prettier: 4칸 들여쓰기, printWidth 120).
- **`tests/release-safety.test.js`는 소스 파일의 원문 텍스트를 정규식으로 검사한다 — 주석도 걸린다:**
    - 전 런타임 파일 금지: 동적 코드 실행·원격 코드 로딩 계열 문자열(테스트 파일의 `forbiddenPatterns` 참고). 주석에도 해당 단어를 쓰면 안 된다.
    - followingPreviewTooltip.js 전용 금지 패턴이 더 있다(팝업/새 창/외부 프레임 폴백 계열).
    - autoQualityPage·categoryTools·chatTools·liveWatchHistory·monthlyBroadcastTime·videoSearch에는 특정 코드 시퀀스 사이 간격(`[\s\S]{0,N}`)을 검사하는 최적화 가드가 있어, **해당 지점 사이에 줄(주석 포함)을 추가하면 테스트가 깨진다.** 이 파일들을 수정하면 반드시 `npm test`로 확인한다.
    - volumeTooltip.js에는 cheese-knife/jebibot 출처 표기가 남아 있어야 한다(THIRD_PARTY_NOTICES.md와 세트).
- 수동 스모크 매트릭스와 리팩토링 하드 제약 상세는 `docs/refactoring-guide.md` 참고.

## 실브라우저 자동 검증 방법 (2026-07 확립)

- claude-in-chrome MCP는 chzzk.naver.com을 안전 제한으로 차단한다 — 사용 불가.
- **Chrome 137+ 정식 빌드는 `--load-extension` 플래그를 에러 없이 조용히 무시한다** (격리 월드가 아예 안 생김). headless Chrome을 `--enable-unsafe-extension-debugging`으로 띄우고, 브라우저 레벨 CDP로 `Extensions.loadUnpacked { path }`를 호출해야 한다.
- Node 24 내장 WebSocket으로 의존성 없는 raw CDP 클라이언트를 만들 수 있다. `Input.dispatchKeyEvent`는 trusted 키 이벤트라 네이티브·확장 리스너 모두 실제처럼 반응한다.
- 격리 월드 주입 판정: `Runtime.enable` 후 `executionContextCreated`에서 `auxData.type === "isolated"`이고 이름이 "Better Chzzk"인 컨텍스트 존재 확인.
- VOD는 https://chzzk.naver.com/videos 에서 `a[href^="/video/"]` 첫 링크로 로그인 없이 재생 가능. `--autoplay-policy=no-user-gesture-required --mute-audio` 플래그가 필요하다.

## 치지직 플랫폼 실측 지식 (2026-07 실측 — 외부 서비스라 변할 수 있으니 의심되면 재측정)

- 라이브 재생 정보 API(auto-play-info)의 `livePlaybackJson.media`에는 `mediaId: "HLS"`(경로 `_hls_playlist.m3u8`)와 `mediaId: "LLHLS", latency: "lowLatency"`(경로 `_playlist.m3u8`) 두 항목이 온다. `previewPlaybackJson`은 비어 있을 수 있다.
- **오디오는 muxed**: 마스터 플레이리스트에 `EXT-X-MEDIA`(TYPE=AUDIO)가 없고 모든 화질 variant의 CODECS에 `mp4a.40.2`가 포함된다 → vendor의 hls.light(alternate audio 미지원)로도 소리까지 재생된다. 소리가 안 나면 대부분 Chrome 오토플레이 정책(unmuted는 sticky activation 필요)이나 unmute UX 문제다. 치지직이 demuxed로 바꾸면 full 빌드(hls.min.js)로 교체해야 한다.
- 지연: 일반 HLS는 세그먼트가 2초여도 `EXT-X-TARGETDURATION:10`이라 hls.js 비-LL 모드 기본 시작점(targetduration×3)이 정확히 30초 뒤가 된다. LLHLS(`PART-HOLD-BACK≈3.05`)를 `lowLatencyMode: true`로 재생하면 실측 지연 3~4초. hls.light 번들도 LL-HLS를 정상 지원한다.
- 네이티브 플레이어(pzp)는 Space keydown마다 재생/일시정지를 토글하고 **repeat keydown도 무시하지 않는다** — 키 이벤트를 가로채는 기능은 repeat 누수에 특히 주의.
- API 도메인: `api.chzzk.naver.com`(서비스 API), `apis.naver.com`(댓글 API), `*.pstatic.net`(미리보기 HLS — `optional_host_permissions`라 기능을 켤 때만 `chrome.permissions.request`로 요청).

## 조사·작업 방식

- 상수값·호출 지점 몇 개를 확인하는 수준의 조사는 에이전트 팬아웃 대신 직접 Grep/Read(호출부와 주변만)로 처리한다. 에이전트를 띄울 때는 개수를 최소화하고 프롬프트에 읽기 범위를 좁혀 지시한다.
- 큰 파일은 헤더 주석의 "구조" 지도를 먼저 읽고 필요한 함수만 Read한다.
- 코드 구조가 크게 바뀌는 수정을 하면 해당 파일의 헤더 주석도 함께 갱신한다.

## 문서 지도

- `README.md` — 사용자 문서(기능 상세, 조작 방법, 설정 항목 표, 권한).
- `docs/update-history.md` — 릴리스별 업데이트 내역(Release 본문의 원본).
- `docs/refactoring-guide.md` — 구조 리팩토링 지시서(하드 제약·스모크 매트릭스 상세).
- `PRIVACY.md`, `THIRD_PARTY_NOTICES.md` — 스토어 게시·서드파티 고지.

<!-- vowline:start -->

Always use the skill `vowline` consistently, including for all sub-agents.

<!-- vowline:end -->
