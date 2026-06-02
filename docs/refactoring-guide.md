# Better Chzzk 리팩토링 가이드 (Codex 작업 지시서)

> 이 문서는 **Codex가 단독으로 읽고 작업**하기 위한 지시서다. 대화 맥락 없이 이 문서 + 저장소만으로
> 작업이 가능하도록 작성했다. **동작(기능) 변경 없이 구조만 개선**하는 리팩토링이다.

---

## 0. 프로젝트 스냅샷

- **무엇:** "Better Chzzk" — 치지직(chzzk.naver.com)용 Chrome 확장 프로그램 (Manifest V3, **순수 vanilla JS, 빌드 단계 없음**).
- **규모:** JS/HTML/CSS 약 17,000줄. 큰 파일: `features/categoryTools.js`(3,403줄/함수 236), `features/videoSearch.js`(2,277), `features/monthlyBroadcastTime.js`(2,079), `features/vodBroadcastClock.js`(1,472), `history.js`(1,375), `features/autoQualityPage.js`(1,270).
- **핵심 구조 (양호, 유지할 것):**
  - `content.js` → `window.BetterChzzk.utils` 네임스페이스에 공용 유틸 등록.
  - `shared/settings.js` → `globalThis.BetterChzzkSettings`로 옵션 단일 공급원(`DEFAULT_OPTIONS`, `OPTION_KEYS`, `normalizeOptions`, `getOptions`, `addOptionsChangeListener` 등) 제공.
  - 각 기능은 자기완결적 IIFE (`features/*.js`).
- **현재 진단:** 구조는 건강함. 단, **(a) 개발 도구 전무, (b) 인프라 코드 파일 간 중복, (c) 일부 거대 단일 파일, (d) CSS 이중 관리, (e) 옵션 키 삼중 정의**가 누적되어 있음. 아래 Phase로 해소한다.

---

## 1. 절대 깨면 안 되는 제약 (HARD CONSTRAINTS)

이 항목들은 cold-start 에이전트가 가장 흔히 깨는 부분이다. **작업 전 반드시 숙지.**

1. **빌드리스 유지 + manifest 로드 순서가 곧 의존성 그래프다.**
   - `manifest.json`의 `content_scripts[].js` 배열 순서대로 전역에 로드된다. 번들러/`import`/`export`/ESM 도입 **금지**(아키텍처가 바뀜). 새 공용 파일을 만들면 **반드시 `manifest.json`의 올바른 위치(소비자보다 먼저)에 등록**한다.
   - 현재 로드 순서(두 번째 엔트리): `shared/settings.js` → `content.js` → `features/*`. 즉 `BetterChzzk.utils`(content.js)와 `BetterChzzkSettings`(settings.js)는 모든 feature보다 먼저 로드됨이 보장된다.

2. **content script가 두 개의 world로 분리되어 있다.**
   - `features/autoQualityPage.js`는 **`world: "MAIN"`**(페이지 컨텍스트)에서 단독 실행되며 `web_accessible_resources`에도 등록되어 있다 → **`BetterChzzk.utils`/`BetterChzzkSettings`에 접근할 수 없다.** 이 파일은 공용 유틸 추출 대상에서 **제외**한다. 건드리지 말 것(별도 지시 없는 한).
   - 나머지 feature 전부는 isolated world에서 실행되며 전역 네임스페이스를 공유한다 → 공용 유틸 추출 대상.

3. **`shared/settings.js`는 두 컨텍스트에서 로드된다.**
   - `background.js:1`에서 `importScripts("shared/settings.js")`로 **service worker**에서도 로드된다. 따라서 settings.js 안에서는 **`window`/`document`/DOM API를 무가드로 쓰면 안 된다**(`globalThis`, `chrome` 사용). 현재 그렇게 되어 있으니 유지.
   - `BetterChzzkSettings`의 **공개 export 형태(키 이름/시그니처)를 바꾸지 말 것.** 내부 구현만 리팩토링. (`background.js`, `options.js`, 모든 feature가 의존)

4. **동작 동등성(behavior parity).** 기능 추가/삭제/UX 변경 금지. 순수 구조 리팩토링. 사용자 눈에 보이는 결과·네트워크 호출·옵션 의미가 동일해야 한다.

5. **IIFE 모듈 패턴과 전역 네임스페이스 컨벤션 유지.** `data-bc*` 속성 마커 네이밍, 기존 명명 규칙을 따른다.

---

## 2. 검증 방법 (테스트 스위트 없음 — 필수 절차)

자동 테스트가 없으므로 **각 Phase 완료 후 아래 수동 스모크 매트릭스를 통과**시켜야 한다. 한 Phase = 한 커밋/PR, 그 사이에 반드시 검증.

**확장 로드:** `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램을 로드" → 저장소 루트 선택. 코드 수정 후 매번 **리로드(↻)**.

**스모크 매트릭스 (회귀 확인용 최소 셋):**

| 기능 | 확인 페이지 | 기대 동작 |
|---|---|---|
| autoQuality / autoQualityPage | 라이브 시청 페이지 | 진입 시 설정 화질(기본 1080p) 자동 적용 |
| skipControl | 다시보기(VOD) | 키보드/휠/필(pill)로 스킵 동작 |
| vodBroadcastClock | VOD | 재생 위치의 실제 방송 시각 라벨 표시 |
| timeMachineLagLabel | 타임머신/라이브 | 지연 라벨 표시 |
| monthlyBroadcastTime | 채널 홈 | 월 방송시간/캘린더 집계 표시 |
| liveWatchHistory | 라이브 시청 → `history.html` | 시청 기록 적재/조회 |
| videoSearch | 채널 `…/videos` 탭 | 검색바·필터·댓글검색 동작 |
| categoryTools | 카테고리/탐색 목록 | 팔로워/시청자 필터, 정렬, 뱃지 |
| 옵션 화면 | 확장 아이콘 → `options.html` | 저장/복원/의존성 비활성화 정상 |
| 콘솔 | 모든 위 페이지 | **에러 0건**(특히 `BetterChzzk … undefined` 류 로드 순서 오류) |

> **권장:** Phase 0(도구)을 먼저 끝내고 나면, 이후 모든 Phase에서 `npm run lint`가 **무경고**여야 한다. 이것을 1차 게이트로 사용.

---

## 3. 작업 순서 (의존성 + ROI 순)

> **각 Phase는 독립 커밋/PR.** 여러 Phase를 한 커밋에 섞지 말 것. Phase 1·2·3은 서로 독립적이라 순서 조정 가능하나, **Phase 0을 가장 먼저** 한다. Phase 4는 선택(저우선).

---

### Phase 0 — 개발 도구 도입 (최우선 · 저위험 · 고효과)

**목표:** 정적 분석·포맷·기본 검증 자동화. **출력물(확장 코드) 자체는 변경 없음**(dev 의존성만 추가).

**작업:**
1. 루트에 `package.json` 추가 (private, dev 전용). 빌드 스크립트는 **만들지 않는다**(빌드리스 유지).
2. **ESLint** 추가. 환경에 맞춘 설정이 중요:
   - `env`: `browser`, `webextensions`, `es2022`, `serviceworker`.
   - 전역(globals) **read-only 선언**: `BetterChzzk`, `BetterChzzkSettings`, `chrome`.
   - 처음에는 규칙을 과격하게 켜지 말 것. `eslint:recommended` + `no-unused-vars`, `no-undef`, `no-var`, `prefer-const` 정도로 시작해 **현 코드가 통과**하도록 한 뒤 점진 강화. (대량 자동수정으로 diff를 폭발시키지 말 것 — Phase 0의 목적은 "그물 설치"지 "대청소"가 아니다.)
3. **Prettier** + `.editorconfig` 추가. **기존 코드 스타일(4-space indent, 큰따옴표 등)에 맞춰** 설정해 재포맷 diff를 최소화한다. Prettier 일괄 적용은 **별도 커밋**으로 분리(리뷰 가능하게).
4. `.gitignore`에 `node_modules/` 추가 확인.
5. (선택, 권장) `web-ext lint`를 dev 의존성으로 추가해 manifest/확장 정합성 점검.
6. `package.json`에 `scripts`: `lint`(eslint), `format`(prettier --write), `format:check`.

**수용 기준:**
- `npm install` 후 `npm run lint` 실행 가능, 결과는 **0 error**(경고는 점진 축소 대상으로 남겨도 됨).
- `git diff`에 **확장 런타임 코드의 의미 변경이 없음**(Prettier 재포맷 커밋은 의미 보존).
- 확장 로드 후 스모크 매트릭스 통과(도구 추가가 런타임에 영향 없음 확인).

---

### Phase 1 — 공용 `fetchJson` 헬퍼 추출 (중복 제거)

**현재 문제:** 거의 동일한 timeout fetch 래퍼가 최소 5곳에 흩어져 있고 시그니처가 제각각이다.
- `features/liveWatchHistory.js:236` `fetchJsonWithTimeout(url)` — `credentials:"include"`, `!ok`시 throw, `await res.json()`.
- `features/categoryTools.js:1305` `fetchJson(url)` — 위 + `headers:{Accept:"application/json"}`, `window.setTimeout`.
- `features/vodBroadcastClock.js:876` `fetchJsonWithTimeout(url, options={})` — fetch init 병합.
- `features/monthlyBroadcastTime.js:855` `fetchJsonWithTimeout(url, options={}, timeoutMs=FETCH_TIMEOUT_MS)` — **호출별 타임아웃** 지원.
- `features/videoSearch.js:624,780` — 인라인 `AbortController`로 **외부 신호 기반 취소**(라우트 변경 시 abort)를 직접 운용.

**목표:** 위 다섯의 기능을 **모두 포괄하는 superset** 헬퍼 하나를 `BetterChzzk.utils`에 추가하고, 5개 호출부를 이관한다.

**추가 위치:** `content.js`의 `root.utils` 블록(line 142 부근 객체에 `fetchJson` 키 추가). content.js는 모든 feature보다 먼저 로드되므로 안전. **(autoQualityPage.js는 MAIN world라 사용 불가 — 이관 대상 아님.)**

**제안 API (이 형태를 그대로 구현):**
```js
// content.js, root.utils 에 추가
async function fetchJson(url, { signal, timeoutMs = 12000, ...init } = {}) {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (signal) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            credentials: "include",
            ...init,                       // 호출부가 headers/method 등 덮어쓸 수 있게
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();           // 본문 수신 동안 timeout 유지(await 필수)
    } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
}
```
- **호출부 이관 매핑:**
  - `fetchJsonWithTimeout(url)` → `fetchJson(url)`
  - categoryTools `fetchJson(url)` → `fetchJson(url, { headers: { Accept: "application/json" } })`
  - `fetchJsonWithTimeout(url, opts)` → `fetchJson(url, { ...opts })`
  - `fetchJsonWithTimeout(url, opts, ms)` → `fetchJson(url, { ...opts, timeoutMs: ms })`
  - videoSearch 인라인 패턴 → `fetchJson(url, { signal })` 로 외부 `AbortController.signal` 전달(기존 취소 동작 보존).
- 각 feature의 로컬 `fetchJsonWithTimeout`/`fetchJson` 정의와 (불필요해진) `FETCH_TIMEOUT_MS` 상수는 호출부 이관 후 제거. 단 **호출별 타임아웃 값이 다르면** `timeoutMs`로 명시 전달해 기존 값 보존.

**주의/수용 기준:**
- videoSearch의 "라우트 변경 시 진행 중 요청 취소" 동작이 **그대로** 유지될 것(외부 signal 경로 확인).
- monthlyBroadcastTime의 호출별 타임아웃이 보존될 것.
- credentials/headers 등 **요청 형태가 기존과 바이트 단위로 동등**할 것(네트워크 탭으로 확인).
- 스모크 매트릭스에서 videoSearch/categoryTools/monthlyBroadcastTime/vodBroadcastClock/liveWatchHistory 정상.

---

### Phase 2 — 옵저버 + 라우트 감지 + 기능 스캐폴드 공용화

**현재 문제:**
- `new MutationObserver`가 10개 파일에 16회. 각자 "자기 변경(self-mutation) 필터 → 스로틀 적용" 패턴을 재구현(예: `categoryTools.js:3318-3351`의 `isOurMutation` 루프 + `observer.observe(...)`).
- 라우트 변경 감지가 11개 파일에 산재(55회). `content.js:112`에 `startPageChangeDetection` 유틸이 **이미 있는데도** categoryTools는 `popstate`/`hashchange`를 직접 재배선(`categoryTools.js:3398-3399`).
- 기능 초기화 보일러플레이트 반복: `BetterChzzkSettings.getOptions(applyOptions)` + `addOptionsChangeListener(applyOptions)` + `onReady(() => { startObserver(); scheduleApply(); …리스너 })` 패턴(`categoryTools.js:3379-3402` 등 모든 feature).

**목표(점진, 2단계로 나눠도 됨):**
1. **옵저버 헬퍼**를 `BetterChzzk.utils`에 추가: 콜백 + `attributeFilter`/`subtree` 옵션 + (이미 있는) `createThrottledDomSync`와 결합 + self-mutation 무시 훅을 받는 형태. 기존 `mutationMatchesSelector`(content.js:69)와 결을 맞춘다.
2. **라우트 워처 일원화:** 자체 `popstate`/`hashchange` 배선을 전부 `startPageChangeDetection`(content.js:112) 사용으로 교체. 필요한 "URL 변경 시에만 트리거" 비교(예: `lastUrl`/`routeKey`)는 유틸에 흡수 검토.
3. (여력 시) **feature 스캐폴드 유틸:** `getOptions`+`addOptionsChangeListener`+`onReady`+옵저버 기동을 묶는 `BetterChzzk.utils.defineFeature({ onOptions, onReady, observe })` 류의 얇은 헬퍼. **단, 각 feature의 `applyOptions` 분기 로직(옵션 diff 반응, 비활성 시 teardown)은 feature 고유이므로 강제로 일반화하지 말 것** — 공통 배선만 걷어낸다.

**리스크 (중요):**
- 옵저버는 **무한 루프 위험**이 있다. 각 feature가 "자기 DOM 변경"을 무시하는 로직을 갖고 있으니, 공용화 시 이 가드를 **그대로 보존**해야 한다(자기 변경 판별 함수를 콜백으로 주입받게 설계).
- feature마다 `attributeFilter` 목록과 관찰 대상(`document.body || documentElement`)이 다르다 → 옵션으로 받아 보존.
- 이 Phase는 표면적이 넓다. **한 번에 모든 feature를 바꾸지 말고**, 먼저 1개 feature(예: `videoSearch` 또는 비교적 단순한 `timeMachineLagLabel`)로 헬퍼를 검증한 뒤 확산한다.

**수용 기준:**
- 각 feature가 SPA 라우팅(치지직은 클라이언트 라우팅)으로 페이지 이동 시 **마운트/언마운트가 기존과 동일**.
- 콘솔에 옵저버 폭주/재귀 징후 없음(CPU 스파이크·중복 주입 없음).
- 스모크 매트릭스 전체 통과.

---

### Phase 3 — 옵션을 스키마 기반으로 (삼중 정의 제거)

**현재 문제:** 옵션 키가 **세 곳**에 중복 정의되어, 새 옵션 추가 시 세 곳을 모두 고쳐야 한다(누락 시 버그).
1. `shared/settings.js` — `DEFAULT_OPTIONS`(11-58) + `normalizeOptions`(87-291, **키별 ~200줄 반복**).
2. `options.html` — 각 입력의 `data-option` 속성.
3. `options.js:52-64` — `getEnabledFeatureCount`가 9개 기능 토글 키를 **하드코딩**.

**목표:** `shared/settings.js`에 **단일 스키마**를 두고 `DEFAULT_OPTIONS`/`OPTION_KEYS`/`normalizeOptions`를 거기서 파생. 기능 토글 키도 스키마에서 파생해 `options.js`의 하드코딩 제거.

**제안 형태:**
```js
// shared/settings.js (DOM/window 사용 금지 — service worker에서도 로드됨)
const OPTION_SCHEMA = {
    autoQualityEnabled:        { kind: "bool", default: true, feature: true },
    skipSeconds:               { kind: "skipSeconds" },                  // 기존 특수 정규화 보존
    skipWheelStep:             { kind: "int", default: 1, min: 1, max: 60 },
    monthlyBroadcastTimeMaxCalendarPages:
                               { kind: "int", default: 60, min: MONTHLY_CALENDAR_MIN_PAGES, max: MONTHLY_CALENDAR_MAX_PAGES },
    // …현재 DEFAULT_OPTIONS의 모든 키를 1:1로 이전(min/max/default는 현 normalizeOptions의 값 그대로)
};
// 파생:
const DEFAULT_OPTIONS = Object.freeze(/* schema → default 맵 */);
const OPTION_KEYS = Object.freeze(Object.keys(OPTION_SCHEMA));
function normalizeOptions(value = {}) { /* schema 순회 + kind별 normalizeInteger/Boolean/SkipSeconds */ }
```
- `kind`: `bool`(`normalizeBoolean`), `int`(`normalizeInteger` + min/max), `skipSeconds`(`normalizeSkipSeconds`) 등 **현재 함수 재사용**.
- `feature: true` 태그로 "기능 on/off 토글" 키를 표시 → `BetterChzzkSettings`에 `FEATURE_KEYS`(또는 헬퍼) 추가 export → `options.js:getEnabledFeatureCount`가 이를 사용하도록 교체.
- **각 키의 min/max/default 값은 현재 코드와 정확히 일치**시킬 것(아래 표가 진실 공급원: `settings.js:104-288`). 값이 바뀌면 동작 회귀.

**제약 재확인:**
- `BetterChzzkSettings`의 **공개 export 형태 불변**(`DEFAULT_OPTIONS`, `OPTION_KEYS`, `normalizeOptions`, `getOptions`, `addOptionsChangeListener`, `normalizeSkipSeconds`, 기존 상수들). 내부만 교체.
- `options.html`의 `data-option` 키들과 `OPTION_KEYS`가 **완전히 일치**하는지 점검(이 Phase에서 불일치 발견 시 보고).

**테스트 추가(권장, 저위험):** `normalizeOptions`는 **순수 함수(DOM 무관)** 이므로 Node로 단위 테스트가 가능하다. Phase 0의 도구 위에 가벼운 테스트(예: node:test)로 "잘못된 값 → 기본값/클램프" 케이스 몇 개를 고정하면 이후 회귀를 잡는다.

**수용 기준:**
- 기존 옵션 키 집합/기본값/클램프 경계가 **리팩토링 전후 동일**(가능하면 위 단위 테스트로 증명).
- `options.html` 저장/복원, 의존성 비활성화, 기능 카운트 표시가 동일.
- service worker(`background.js`)에서 `importScripts` 후 정상 동작(설치 시 정규화 로직 `background.js:5-16`).

---

### Phase 4 — (선택·저우선) 거대 파일 분할 & CSS 일원화

> ROI 대비 위험·노동이 크다. Phase 0~3가 끝나고 여력이 있을 때만. **요청 없으면 보류 가능.**

**4a. CSS 이중 관리 정리.**
- 별도 `styles.css`(1,225줄)가 있는데도 7개 feature가 **거대한 CSS-in-JS 템플릿 문자열**을 따로 주입한다. 대표: `features/categoryTools.js`의 `injectStyleOnce()`는 **186~655행, 약 470줄의 CSS 문자열**(`!important` 다수).
- 방향(택1, 일관성 우선): ① 동적으로 ID/속성 보간이 필요 없는 정적 CSS는 `styles.css`(또는 feature별 `.css`)로 이전하고 `manifest`/주입으로 로드, 동적 부분만 JS에 남김. 또는 ② 현 방식을 유지하되 feature별 `*.css.js` 같은 규약으로 **문자열만 분리**해 로직 파일을 가볍게.
- **주의:** `!important`와 셀렉터 특정성은 치지직 원본 스타일과의 싸움 결과물일 수 있다. 옮길 때 **계산된 스타일이 동일**한지 화면으로 확인(레이아웃 회귀 주의).

**4b. 거대 feature 파일 분할.**
- 대상: `categoryTools.js`(3,403), `videoSearch.js`(2,277), `monthlyBroadcastTime.js`(2,079). 단일 IIFE라 내부 모듈 경계가 없다.
- **빌드리스 제약 때문에 ESM `import`는 못 쓴다.** 분할 방법은 둘 중 하나:
  - (보수적) 한 feature를 여러 파일로 쪼개되 `window.BetterChzzk.<feature>` 하위 네임스페이스로 노출하고 `manifest.json`에 **순서대로** 등록(예: `categoryTools/state.js` → `categoryTools/api.js` → `categoryTools/ui.js` → `categoryTools/index.js`). 로드 순서·전역 오염에 주의.
  - (보류) 번들러 도입은 제약 1을 깨므로 **이 가이드 범위 밖**. 하려면 별도 합의 필요.
- 분할은 "줄 수 줄이기"가 목적이 아니라 **응집도 높은 단위(상태/네트워크/DOM주입/렌더)** 로 나누는 것. 무리하면 보류.

**수용 기준:** 화면·동작 완전 동일 + 콘솔 에러 0 + 로드 순서 오류 없음.

---

## 4. 하지 말 것 (Out of scope / Do-not-touch)

- ❌ 번들러/ESM/TypeScript 도입(별도 합의 전까지). 빌드리스 유지.
- ❌ `features/autoQualityPage.js`를 공용 유틸에 의존시키기(MAIN world — 접근 불가).
- ❌ `BetterChzzkSettings` / `BetterChzzk.utils`의 **공개 인터페이스 형태 변경**(소비자 다수).
- ❌ 기능 추가·삭제·UX 변경, 옵션 의미/기본값/경계 변경.
- ❌ `manifest.json`의 `version` 임의 변경, 권한(`permissions`/`host_permissions`) 변경.
- ❌ 한 커밋에 여러 Phase 혼합, Prettier 일괄 포맷과 로직 변경 혼합.
- ⚠️ 작업 트리에 이미 수정된 `features/autoQualityPage.js`가 있을 수 있음(기존 변경) — 이 리팩토링과 섞지 말 것.

---

## 5. 진행 체크리스트

- [ ] **Phase 0** 도구(`package.json`/ESLint/Prettier/.editorconfig) — `npm run lint` 0 error, 런타임 코드 의미 불변
- [ ] **Phase 1** `BetterChzzk.utils.fetchJson` 추출 + 5개 호출부 이관, 로컬 래퍼 제거
- [ ] **Phase 2** 옵저버/라우트 감지/스캐폴드 공용화(1개 feature 검증 후 확산)
- [ ] **Phase 3** 옵션 스키마화(삼중 정의 제거) + `normalizeOptions` 단위 테스트
- [ ] **Phase 4** (선택) CSS 일원화 / 거대 파일 분할
- [ ] 각 Phase 후 **스모크 매트릭스(2장) 통과** + 콘솔 에러 0

---

### 부록: 핵심 좌표 빠른 참조

| 항목 | 위치 |
|---|---|
| 공용 유틸 등록부 | `content.js:142` (`root.utils = { … }`) |
| 기존 라우트 감지 유틸 | `content.js:112` `startPageChangeDetection` |
| 스로틀 DOM 동기화 유틸 | `content.js:83` `createThrottledDomSync` |
| 옵션 단일 공급원 | `shared/settings.js` (`DEFAULT_OPTIONS` 11-58, `normalizeOptions` 87-291) |
| service worker 로드 | `background.js:1` `importScripts("shared/settings.js")` |
| 옵션 키 하드코딩(제거 대상) | `options.js:52-64` `getEnabledFeatureCount` |
| fetch 중복 | `liveWatchHistory.js:236`, `categoryTools.js:1305`, `vodBroadcastClock.js:876`, `monthlyBroadcastTime.js:855`, `videoSearch.js:624,780` |
| 옵저버 예시 | `categoryTools.js:3318-3351`, 기능 init `:3379-3402` |
| CSS-in-JS 거대 문자열 | `categoryTools.js:186-655` (`injectStyleOnce`) |
| 두 world 분리 | `manifest.json:16-46` (entry1 `world:"MAIN"` autoQualityPage / entry2 isolated) |
