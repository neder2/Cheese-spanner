# Better Chzzk 1.1.3 리팩토링 보고서

- 작성일: 2026-05-31
- 작업 브랜치: `codex/1.1.3-refactor`
- 브랜치 생성 기준: 로컬 `1.1.2`
- 기준 문서: `docs/refactoring-guide.md`

## 완료 범위

### Phase 0 - 개발 도구 도입

- 개발 전용 `package.json`, `package-lock.json`을 추가했습니다.
- 확장 릴리스 버전을 `manifest.json`과 `package.json` 기준 `1.1.3`으로 맞췄습니다.
- ESLint flat config, Prettier 설정, `.editorconfig`, `.prettierignore`를 추가했습니다.
- `.gitignore`에 `node_modules/`를 추가했습니다.
- 테스트 보강을 위해 `node:test`와 `jsdom` 기반 DOM 회귀 테스트를 추가했습니다.
- 가이드 제약대로 번들러, ESM 전환, TypeScript, 빌드 스크립트는 도입하지 않았습니다.

### Phase 1 - 공용 `fetchJson` 추출

- `content.js`에 `BetterChzzk.utils.fetchJson`을 추가했습니다.
- 다음 기능의 중복 JSON fetch 흐름을 공용 헬퍼로 이동했습니다.
    - `features/liveWatchHistory.js`
    - `features/categoryTools.js`
    - `features/vodBroadcastClock.js`
    - `features/monthlyBroadcastTime.js`
    - `features/videoSearch.js`
- 기능별 기존 timeout 값은 `timeoutMs`로 보존했습니다.
- `videoSearch`의 외부 `AbortController.signal` 기반 취소 동작을 유지했습니다.
- `features/autoQualityPage.js`는 `MAIN` world에서 실행되므로 공용 유틸 공유 대상에서 제외했습니다.

### Phase 2 - 옵저버, 라우팅, 기능 옵션 공용화

- `BetterChzzk.utils.createMutationObserverSync`를 추가했습니다.
- SPA 라우팅 영향을 받는 다음 기능에 옵저버 헬퍼를 적용했습니다.
    - `features/liveWatchHistory.js`
    - `features/categoryTools.js`
    - `features/monthlyBroadcastTime.js`
    - `features/videoSearch.js`
- 해당 기능의 직접 `popstate`/`hashchange` 리스너를 `startPageChangeDetection` 사용으로 교체했습니다.
- `BetterChzzk.utils.bindFeatureOptions`를 추가했습니다.
- isolated world 기능들의 반복 `getOptions` + `addOptionsChangeListener` 배선을 공용 헬퍼로 정리했습니다.

### Phase 3 - 옵션 스키마화

- `shared/settings.js`를 `OPTION_SCHEMA` 중심 구조로 리팩토링했습니다.
- `DEFAULT_OPTIONS`, `OPTION_KEYS`, `FEATURE_KEYS`, `normalizeOptions`가 스키마에서 파생되도록 변경했습니다.
- 기존 `BetterChzzkSettings` 공개 export는 유지하고 `FEATURE_KEYS`만 추가했습니다.
- `options.js`의 기능 개수 하드코딩을 `FEATURE_KEYS` 기반으로 교체했습니다.
- `tests/settings.test.js`와 `tests/extension-pages.test.js`를 추가해 옵션 기본값, 키 순서, 정규화, `options.html` 연결, 옵션 페이지 저장 흐름, 히스토리 페이지 초기 로딩을 검증했습니다.

## 보존한 제약

- `manifest.json`의 permissions, host_permissions, content script world 분리는 변경하지 않았습니다.
- 버전 필드는 커밋 요청에 따라 `1.1.3`으로 갱신했습니다.
- ESM, 번들러, TypeScript는 도입하지 않았습니다.
- 기존 `BetterChzzkSettings` 공개 API는 유지했습니다.
- 기존 `BetterChzzk.utils` 공개 유틸은 유지하고 새 헬퍼만 추가했습니다.
- 작업 시작 전부터 staged 상태였던 `features/autoQualityPage.js` 변경은 보존했으며 이번 리팩토링 범위로 다루지 않았습니다.

## Phase 4 판단

Phase 4는 실행하지 않았습니다. 가이드에서 CSS 단일화와 거대 파일 분할은 선택, 저우선순위, 별도 요청이 없으면 보류 가능하다고 명시되어 있습니다. 이번 작업에서는 셀렉터 우선순위, CSS 주입 순서, manifest 로드 순서 변경 위험을 피하기 위해 보류했습니다.

## 검증 결과

통과한 항목:

- `npm install`
- `node --check` 전체 JavaScript 파일 검사, `node_modules` 제외
- `npm run lint`
- `npm test`
    - 총 7개 테스트 통과
    - 설정 스키마 기본값, 기능 키, 정규화 검증
    - `options.html`의 `data-option`과 `OPTION_KEYS` 일치 검증
    - `options.html + shared/settings.js + options.js` DOM 로딩, 의존 옵션 비활성화, 저장 흐름 검증
    - `history.html + history.js` DOM 로딩, 로컬 히스토리 초기 상태 검증
- `git diff --check`
    - 실패 없음
    - Git의 LF to CRLF 경고만 출력됨
- Codex Chrome 프로필에서 실제 Chzzk 공개 페이지 스모크 확인
    - live: `https://chzzk.naver.com/live/45e71a76e949e16a34764deb962f9d9f`
        - `data-betterchzzk-auto-quality-state` 확인
        - `data-betterchzzk-adblock-popup-ready` 확인
        - `#betterchzzk-skip-pill` 확인
        - 확장 관련 error/warning log 0건
    - VOD: `https://chzzk.naver.com/video/13468756`
        - `#betterchzzk-skip-pill` 확인
        - `#betterchzzk-vod-broadcast-clock` 확인
        - 확장 관련 error/warning log 0건
    - 채널 홈: `https://chzzk.naver.com/45e71a76e949e16a34764deb962f9d9f`
        - `#betterchzzk-monthly-broadcast-time` 확인
        - 확장 관련 error/warning log 0건
    - 채널 videos: `https://chzzk.naver.com/45e71a76e949e16a34764deb962f9d9f/videos`
        - `#betterchzzk-video-search-bar` 확인
        - 확장 관련 error/warning log 0건
    - 전체 라이브 목록: `https://chzzk.naver.com/lives`
        - `#betterchzzk-category-tools` 확인
        - 확장 관련 error/warning log 0건
    - 카테고리 목록: `https://chzzk.naver.com/category/ETC/talk/lives`
        - `#betterchzzk-category-tools` 확인
        - 확장 관련 error/warning log 0건

제한 또는 실패 항목:

- `npx web-ext lint --source-dir . ...`는 Firefox 기준 Manifest V3 요구사항 때문에 실패했습니다.
    - `background.service_worker` 미지원
    - Firefox extension ID 누락
    - 향후 `data_collection_permissions` notice
    - `storage.sync`, 동적 `innerHTML` 관련 기존 경고
- 이 저장소는 Chrome 확장 대상이므로 위 결과는 Chrome 품질 게이트로 보지 않았습니다.
- Codex Chrome 브라우저 보안 정책이 `chrome://extensions`와 `chrome-extension://.../options.html`, `chrome-extension://.../history.html` 직접 탐색을 차단했습니다.
- 차단된 옵션/히스토리 확장 페이지 브라우저 스모크는 `jsdom` 기반 HTML + 스크립트 회귀 테스트로 대체 검증했습니다.

## 참고

- 작업은 `codex/1.1.3-refactor` 브랜치에서 진행했습니다.
- 브랜치 생성 기준은 사용자가 확인 요청한 뒤 안내한 대로 `1.1.2`입니다.
- `npm audit`은 개발 의존성 경로에서 6건의 취약점을 보고합니다. 주로 `web-ext` 의존성 경로이며 런타임 확장 코드에는 포함되지 않습니다.
