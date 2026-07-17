# Better Chzzk — 에이전트 작업 지침

이 문서는 대화 맥락 없이 저장소를 다루는 에이전트가 지켜야 할 **지속 규칙**이다.
현재 구조·버전·권한·로드 순서는 항상 `manifest.json`, `package.json`, 실제 소스와 테스트를 기준으로 판단한다. 이 문서의 예시나 과거 문서가 현재 코드와 다르면 현재 저장소를 우선한다.

## 작업 경계

- 요청의 범위와 성공 조건을 먼저 확인하고 관련 파일·호출부·테스트만 읽는다.
- 작업 시작 시 현재 branch, HEAD, `git status`, 기존 diff와 요청 대상 branch·version을 확인한다.
- 현재 branch가 사용자 요청의 대상과 다르면 구현 전에 중단하고 차이를 보고한다. 다른 버전·기능의 계획, fixture, 테스트, 문서를 현재 작업 branch에 섞지 않는다.
- 새 branch 생성이나 전환은 사용자가 요청했거나 작업에 필요하다고 합의한 경우에만 한다.
- 사용자가 리뷰를 요청하면 읽기 전용으로 근거와 결과를 먼저 보고하고, 계획을 요청하면 구현 전 계획에서 멈춘다. 구현을 요청하면 안전한 범위에서 구현과 검증까지 완료한다.
- 사용자가 만든 변경과 추적되지 않은 파일을 임의로 되돌리거나 덮어쓰거나 삭제하지 않는다. 충돌 가능성이 있으면 멈추고 보고한다.
- 커밋, push, 병합, 태그, 버전 증가, GitHub Release 생성은 사용자가 명시적으로 요청했을 때만 한다.
- `git reset --hard`, `git clean`, 강제 push처럼 복구가 어렵거나 범위가 넓은 명령은 사용자의 명시적 요청과 정확한 대상 확인 없이 실행하지 않는다.
- 버그 수정이나 기능 구현에 관계없는 정리·이름 변경·전면 포맷을 같은 변경에 섞지 않는다.
- 큰 파일은 필요한 함수와 호출부부터 읽는다. 상단에 구조 설명이 **있는 경우** 활용하되, 모든 파일에 헤더가 있다고 가정하지 않는다.
- 하위 에이전트는 독립적으로 나눌 수 있는 큰 조사에만 최소한으로 사용하고, 작업 범위와 이 문서의 제약을 함께 전달한다.
- 사용자에게는 한국어 존댓말로 답하고, 실제로 수행한 검증과 수행하지 못한 검증을 구분해 보고한다.

## 버그 수정과 대체 경로

1. 증상을 재현하고 기대 동작과 실제 동작을 구분한다.
2. 이벤트·상태·DOM·네트워크 흐름에서 최초로 잘못된 값이나 분기가 생기는 지점을 찾는다.
3. 원인 로직을 소유한 파일과 함수에서 최소 범위로 수정한다.
4. 가능하면 수정 전 실패하고 수정 후 통과하는 회귀 테스트를 추가한다.
5. SPA 이동, 새로고침, 옵션 켜기·끄기, DOM 재마운트 경로를 함께 확인한다.

증상을 가리려고 타이머·재시도·광범위 DOM 스캔을 먼저 늘리거나 기존 기능을 꺼서 문제를 없애지 않는다.

다음과 같이 **원래 기능과 다른 사용자 흐름으로 바꾸는 임의 우회**는 추가하지 않는다.

- 페이지 안 기능 실패를 새 탭·새 창·팝업·iframe·다른 페이지 열기로 대신하는 동작
- 원격 스크립트·WASM·문자열 코드를 가져와 실행하는 동작
- 확인할 수 없는 데이터·문구·진행률·썸네일을 지어내는 동작
- 실패를 성공처럼 표시하거나 별도 UI로 정상 경로의 실패를 숨기는 동작

`null` 가드, 파싱 기본값, 캐시 미스 처리, 기능 감지, CSS 변수 기본값, 실제 응답에서 확인된 스트림·응답 형식 선택은 위 금지 대상이 아니다. 새 호환 분기는 **실측된 변형, 결정적인 선택 조건, 회귀 테스트**가 있을 때만 추가한다. 직접 고칠 수 없는 외부 장애라면 다른 흐름을 발명하지 말고 실패 조건·영향 범위·확인 근거를 보고한다.

## 커밋·버전·릴리스

- 커밋을 요청받으면 제목 첫 줄은 프로젝트 규칙인 `Better Chzzk <version>` 형식을 사용한다. 예: `Better Chzzk 1.2.0`
- 버전을 올릴 때는 `manifest.json`과 `package.json`을 함께 변경하고 값이 같은지 확인한다.
- 릴리스 또는 버전 업데이트를 요청받으면 `docs/update-history.md`를 갱신한다.
- 사용자에게 보이는 기능·옵션·조작법·권한이 바뀌면 같은 릴리스에서 `README.md`를 갱신한다.
- 데이터 처리 방식이 바뀌면 `PRIVACY.md`, 서드파티 코드·라이선스가 바뀌면 `THIRD_PARTY_NOTICES.md`와 해당 소스 고지를 확인한다.
- 스토어 등록 문구 변경이 필요한 경우 저장소 밖 작업으로 누락하지 말고 필요한 변경 내용을 보고한다.
- GitHub Release는 명시적인 릴리스 요청이 있을 때만 만들고 본문은 `docs/update-history.md`와 맞춘다.

## 프로젝트 구조와 실행 컨텍스트

- Better Chzzk는 `chzzk.naver.com`용 Chrome Manifest V3 확장이다.
- 런타임은 순수 vanilla JS이며 빌드 단계가 없다. `package.json`은 개발·검증과 vendored 의존성 관리에 사용한다.
- 별도 아키텍처 변경 요청이 없으면 번들러, 런타임 ESM, `import`/`export`, 생성된 배포 산출물을 도입하지 않는다.
- `manifest.json`의 `content_scripts[].js` 배열 순서가 런타임 의존성 순서다. 공용 파일을 추가하면 소비자보다 먼저 로드되도록 등록한다.
- 각 기능은 기존 IIFE 패턴과 전역 네임스페이스 규칙을 유지한다.

콘텐츠 스크립트 파일 목록과 순서는 작업 시점의 `manifest.json`을 다시 확인한다.

- MAIN world와 isolated world의 실제 파일 목록·순서는 작업 시점의 `manifest.json`을 기준으로 확인한다.
- MAIN world와 isolated world는 JavaScript 전역을 직접 공유하지 않는다. MAIN world 스크립트는 isolated world의 `BetterChzzk.utils`와 `BetterChzzkSettings`에 직접 접근할 수 없다.
- isolated world 스크립트는 `manifest.json` 배열 순서대로 로드되며 기존 `BetterChzzk` 전역 네임스페이스를 공유한다. 새 shared 모듈은 모든 소비자보다 먼저 등록한다.
- world 간 통신은 기존 `CustomEvent`, DOM 속성 등 명시적 브리지를 따른다. 새 전역 공유를 임의로 만들지 않는다.
- `background.js`는 필요한 shared 파일을 `importScripts()`로 로드하는 service worker다. 실제 의존 목록은 `background.js`를 기준으로 확인한다.
- 시청 기록 변경은 background의 단일 writer 경계를 우회하지 않는다.
- background에서 사용하는 shared 파일은 `window`, `document` 등 DOM 전역을 무가드로 참조하지 않는다.
- `options.html`과 `options.js`는 액션 팝업이자 옵션 페이지다. 좁은 팝업을 1차 환경으로 검증한다.
- `history.html`과 `history.js`는 별도 확장 페이지이며 시청 기록을 `chrome.storage.local`에서 읽는다.

## 공용 인프라

- `shared/settings.js`의 내부 `OPTION_SCHEMA`가 옵션 정의의 단일 공급원이다.
- 공개 객체는 현재 `OPTION_SPEC`, `DEFAULT_OPTIONS`, `OPTION_KEYS`, `FEATURE_KEYS`, `normalizeOptions`, `getOptions`, `addOptionsChangeListener` 등을 노출한다. 실제 export 목록을 확인하고 기존 키 이름과 시그니처를 함부로 바꾸지 않는다.
- 옵션 변경 시 `OPTION_SCHEMA` → `options.html`의 `data-option`·`data-depends-on` → feature의 `bindFeatureOptions`와 비활성화 정리 → 관련 테스트 → README·릴리스 문서를 함께 확인한다.
- 권한이 필요한 옵션은 사용자 제스처 안의 승인·거부·기존 승인 흐름을 모두 처리한다.
- `shared/data.js`와 `content.js`는 기존 `BetterChzzk.utils` 객체를 병합해 확장한다. 같은 유틸을 feature마다 다시 만들기 전에 공용 구현을 확인한다.
- 콜백형 `chrome.storage` API를 직접 사용할 때는 같은 콜백 안에서 `chrome.runtime.lastError`를 즉시 확인한다. 가능한 경우 기존 `storageGet`·`storageSet`·`storageRemove` 또는 `getStorageLastError`를 재사용한다.
- SPA 라우트 변경은 `routeBridgePage.js`와 `content.js`가 연결한다. feature에서는 history API를 다시 패치하지 말고 `startPageChangeDetection(handler)`를 사용한다.
- DOM 마커는 기존 `betterchzzk-*` ID와 기능별 `data-bc*` 접두어를 따른다.

## DOM·React 수명주기

- 치지직이 만든 DOM 노드는 React의 가상 스크롤이나 재렌더 과정에서 다른 데이터에 재사용되거나 통째로 교체될 수 있다. DOM 노드 객체 자체를 메시지·댓글·카드의 영구 정체성으로 간주하지 않는다.
- 노드에 저장한 marker, expando, `WeakMap` 상태는 해당 노드가 현재도 같은 데이터와 연결되어 있는지 확인한 뒤 사용한다. 안정적인 원본 ID, 현재 속성, 작성자·본문 같은 검증 가능한 fingerprint와 재사용 신호를 함께 검토한다.
- 닉네임·역할 배지·본문처럼 서로 연관된 필드가 여러 mutation에 걸쳐 갱신될 수 있으면 중간의 혼합 상태를 완성된 데이터로 확정하지 않는다. 실제 안정화 조건이나 세대·정체성 확인을 사용하고, 단순 지연 시간 증가에 의존하지 않는다.
- 원본 DOM 노드를 보관해 스크롤·클릭·스타일 복사에 사용할 때는 실행 직전에 저장 당시의 데이터 정체성과 현재 노드의 정체성이 같은지 다시 확인한다.
- React가 소유한 트리를 불필요하게 비우거나 재부모화하지 않는다. 확장이 소유하는 wrapper와 marker를 명확히 구분하고, 네이티브 DOM 교체 시 필요한 요소만 재부착한다.
- `MutationObserver`, `ResizeObserver`, `IntersectionObserver`, 이벤트 listener, timer, RAF, abort controller는 기능 비활성화·라우트 변경·DOM 교체 때 정리한다. 재마운트 후 중복 observer나 listener가 남지 않게 한다.

## 비동기·네트워크 수명주기

- 라우트나 대상 VOD·채널에 종속된 요청에는 가능한 경우 `AbortSignal`을 전달하고, generation·token 또는 현재 대상 ID 확인으로 늦은 응답이 새 화면 상태를 덮지 못하게 한다.
- 외부 signal 취소와 요청 내부 타임아웃이 같은 `AbortError`로 표현될 수 있으면 오류 이름만으로 의미를 추정하지 말고 실제 외부 signal 상태와 호출 계약을 확인한다.
- 하위 보조 조회 실패가 상위 핵심 데이터까지 폐기해야 하는지 기존 계약을 확인한다. 현재 데이터로 안전하게 계산 가능한 실측 기반 폴백이 있으면 보조 조회만 중단하고, 실패를 성공처럼 표시하지 않는다.
- 진행 중 Promise나 응답을 캐시할 때 취소된 요청, 실패한 Promise, 다른 소비자의 signal이 캐시에 미치는 영향을 명시한다. 캐시는 상한과 무효화 조건을 갖고 라우트·옵션 수명주기를 넘겨 stale 상태를 보존하지 않는다.
- 동일 대상의 foreground 요청과 prefetch가 겹치면 기존 요청 공유 여부를 검토하고, observer나 mutation 폭주로 중복 네트워크 요청이 발생하지 않게 한다.

## UI 구현

- 새 UI와 변경 UI는 라이트·다크 모드를 모두 확인한다.
- 치지직 UI를 따르는 요소는 현재 페이지에서 실제로 노출되는 `--Surface-*`, `--Content-*`, `--Border-*` 계열 시맨틱 CSS 변수를 우선 검토하고, 토큰이 없는 테스트 환경을 위한 정적 기본값을 함께 둔다. 현재 예시는 `features/videoSearch.js`를 참고하되 토큰 이름을 불변으로 가정하지 않는다.
- 네이티브 요소와 정확히 같아야 하고 적절한 토큰이 없으면 `getComputedStyle()` 복사를 검토한다. 복사 값은 테마 전환과 DOM 교체 때 다시 동기화한다.
- 직접 테마 분기가 필요하면 현재 페이지에서 확인한 루트 테마 상태를 사용한다. `[class*="dark"]` 같은 넓은 부분 문자열 셀렉터는 오탐 가능성을 검토한다.
- 옵션 팝업은 좁은 너비, 긴 한글 문구, 키보드 탐색과 focus 표시를 확인한다. 작은 글씨에서 읽기 어려운 기호 나열은 의미가 드러나는 문구로 쓴다.
- 클릭 가능한 요소는 적절한 요소 타입, `type="button"`, 접근 가능한 이름과 키보드 동작을 갖춘다.
- 로딩·빈 결과·오류 상태는 실제 상태만 표시하고 가짜 콘텐츠를 만들지 않는다.

## Chrome 웹 스토어·권한·개인정보

- 실행 코드는 모두 확장 패키지 안에 둔다. 원격 JavaScript·WASM 실행, 원격 코드 import, 문자열 코드 실행을 추가하지 않는다. API에서 받은 JSON·미디어 등 데이터는 실행하지 않는다.
- `tests/release-safety.test.js`의 금지 패턴과 Chrome 웹 스토어 정책을 함께 지킨다.
- 권한은 최소화한다. 상시 필요하지 않은 host 접근은 가능한 경우 `optional_host_permissions`로 선언하고, 사용자가 기능을 켜는 제스처 안에서 `chrome.permissions.request()`를 호출한다.
- 새 권한과 match pattern은 설치·업데이트 경고와 심사 범위에 영향을 줄 수 있으므로 필요성·대안·사용 시점을 먼저 검토한다.
- 확장의 단일 목적은 치지직 시청·탐색 경험 개선이다. 다른 사이트 대상 기능이나 무관한 수집·전송 기능을 추가하지 않는다.
- 설정과 기록은 현재 `chrome.storage.sync` 또는 `chrome.storage.local` 범위에 유지한다. 외부 전송·계정 연동·분석 수집은 별도 명시적 요청과 개인정보 문서 갱신 없이는 추가하지 않는다.

## 검증

런타임 JS·HTML·CSS·manifest를 변경했다면 관련 대상 테스트 후 전체 검증을 실행한다.

Windows PowerShell에서는 실행 정책에 막힐 수 있는 `npm.ps1` 대신 `npm.cmd`로 npm 스크립트를 실행한다.

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run format:check
```

- 저장소 전체 `format:check`가 범위 밖의 기존 Prettier drift 때문에 실패하면 변경 파일만 `npx.cmd prettier --check path/to/file...`로 다시 검사한다. 전체 검사 실패와 범위 밖 원인을 별도로 보고하고, 이를 해소하려고 범위 밖 파일을 포맷하지 않는다.
- 구현을 통과시키기 위해 기존 테스트를 삭제하거나 assertion을 느슨하게 만들지 않는다. 의도된 동작 계약이 바뀌어 테스트 수정이 필요하면 변경 이유와 대체 회귀 범위를 함께 보고한다.
- 테스트는 가능하면 함수명·정확한 소스 배치보다 사용자에게 보이는 동작, 상태 전이, 호출 횟수와 부작용을 검증한다. 다만 원격 코드·권한·패키징·금지 경로·성능 hot path처럼 정적 정책 검사가 목적이면 소스 가드를 유지한다.
- `npm.cmd test`는 공용 유틸, 옵션·기록 페이지, 주요 feature와 릴리스 안전 규칙을 포함한다.
- `tests/release-safety.test.js`는 원문 텍스트를 정규식으로 검사하므로 주석도 실패 원인이 될 수 있다.
- 일부 성능 가드는 코드 사이 최대 문자 수를 검사한다. hot path를 수정하기 전에 assertion을 읽고, 테스트를 느슨하게 만들지 말고 의도를 보존한다.
- `features/followingPreviewTooltip.js`에는 새 창·팝업·iframe·원격 실행 계열 대체 경로를 막는 별도 검사가 있다.
- `features/volumeTooltip.js`, `features/chatTimestampPage.js`의 cheese-knife/jebibot 표기와 `THIRD_PARTY_NOTICES.md`는 함께 유지한다.

관련 화면의 수동 스모크에서는 다음을 변경 범위에 맞게 확인한다.

- 실브라우저 접근이 가능하면 완료 보고 전에 확장을 다시 로드하고 대상 치지직 탭을 새로고침한다. 실제 확장 ID, 실행 context, DOM marker와 기능 UI로 주입 성공을 확인한다.
- 실행 플래그, 자동화 명령 성공 또는 테스트 통과만으로 브라우저 동작과 주입 성공을 가정하지 않는다.
- 새로고침 진입과 SPA 이동, 옵션 즉시 반영과 비활성화 정리, 라이트·다크 모드, 좁은 옵션 팝업을 확인한다.
- 라이브·타임머신·VOD·채널 영상 탭·카테고리 목록·시청 기록 중 변경한 기능의 화면을 확인한다.
- 권한 변경은 승인·거부·기존 승인 상태를 확인한다.
- 콘솔 오류, 불필요한 반복 요청, MutationObserver 루프가 없는지 확인한다.
- 실브라우저 검증이 불가능하면 수행한 것처럼 보고하지 않고, 미검증 항목과 사용자가 확인할 수 있는 최소 수동 절차를 적는다.

실브라우저 자동화 방법은 Chrome 빌드와 실행 환경에 따라 달라질 수 있다. 특정 버전·플래그·도구 동작을 영구 규칙으로 보지 말고 실제 확장 ID, isolated execution context, DOM 마커 등으로 로드 성공을 검증한다.

## 치지직 외부 플랫폼 가정

치지직의 DOM, API 응답, 플레이어 구현, HLS/LL-HLS 구성은 예고 없이 바뀔 수 있다.

- 재생·API·셀렉터 문제를 수정하기 전에 현재 응답과 DOM을 다시 측정한다.
- 과거 실측의 정확한 지연 시간, playlist 속성, 오디오 mux/demux 구성, CSS 토큰 개수를 불변 조건으로 하드코딩하지 않는다.
- 실측 메모에는 날짜, endpoint 또는 대상 URL, 확인한 필드·playlist 태그와 재현 조건을 남긴다.
- fixture와 테스트는 확인된 사례를 보존하는 회귀 자료이지 현재 모든 방송 형식의 증명이 아니다.
- 여러 형식을 지원할 때는 실제로 관측된 형식만 명시적 조건으로 처리하고 각각 테스트한다.
- 현재 API·host 권한 범위는 `manifest.json`을 기준으로 확인한다.

## 조사·문서

- 상수값이나 호출부 몇 곳을 확인하는 조사는 Grep과 필요한 범위의 Read로 직접 처리한다.
- 큰 파일은 정의·호출·테스트·인접 상태를 함께 보고, 새 추상화는 실제 중복과 둘 이상의 소비자가 확인될 때 도입한다.
- 전체 DOM 스캔, 무제한 캐시, 짧은 반복 타이머, 중복 네트워크 요청을 추가하지 않는다.
- 구조가 바뀌면 관련 주석·문서·테스트를 갱신하되, 존재하지 않던 대형 헤더를 모든 파일에 일괄 추가하지 않는다.

문서별 기준은 다음과 같다.

- `manifest.json` — 런타임 파일, world, 로드 순서, 권한
- `package.json` — 버전과 검증 명령
- `README.md` — 사용자 기능, 조작법, 설정, 권한
- `docs/update-history.md` — 릴리스별 변경 내역과 Release 본문 원본
- `tests/extension-pages.test.js`와 기능별 테스트 — 현재 동작 계약
- `tests/release-safety.test.js` — 스토어 정책·금지 경로·성능 hot path 가드
- `docs/refactoring-guide.md` — 리팩토링 배경과 스모크 항목 참고용. 과거 규모·진행 상태·“테스트 없음” 설명은 현재 사실로 간주하지 않는다.
- `PRIVACY.md`, `THIRD_PARTY_NOTICES.md` — 개인정보와 서드파티 고지
