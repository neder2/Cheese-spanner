# Better Chzzk 다시보기 방제 이력의 타 방송 제목 혼입 수정 지침서

## 1. 작업 목적

라이브 시청 기록과 다시보기 방제 이력 기능에서, 사용자가 직전에 보던 다른 방송의 다시보기 제목이 현재 방송의 제목 이력에 섞여 저장되는 문제가 있어요.

이 문제는 다시보기 화면에서 다른 기록을 잘못 고르는 단순 표시 오류가 아니라, SPA 이동 직후 남아 있는 이전 페이지의 `og:title` 또는 `document.title`을 현재 라이브의 제목으로 확정해 `titleHistory`에 저장하는 데이터 오염으로 봐야 해요.

이 작업의 목적은 다음과 같아요.

- 현재 라이브 정체성이 검증되기 전의 페이지 제목을 영구 제목 이력에 저장하지 않아요.
- `live-detail` API로 확인된 현재 방송 제목을 권위 데이터로 사용해요.
- 이전 VOD나 이전 라이브의 제목이 새 라이브 entry·session·titleHistory에 들어가지 않게 해요.
- 실제 방송 중 방제 변경은 정상적으로 여러 제목으로 보존해요.
- 오래된 비동기 응답과 SPA 전환 경쟁 상태를 모두 방어해요.
- 기존 저장 데이터는 파괴적으로 자동 정리하지 않아요.

## 2. 저장소 기준과 작업 경계

- 저장소: `neder2/Chzzk`
- 기준선: `main`의 Better Chzzk 1.2.5, `5591505` 계열
- 핵심 파일:
    - `features/liveWatchHistory.js`
    - `shared/watchHistoryStore.js`
    - `shared/data.js`
- 표시 경로 확인 파일:
    - `features/vodBroadcastClock.js`
    - `history.js`
- 테스트 파일:
    - `tests/extension-pages.test.js`
    - `tests/watch-history-store.test.js`
    - `tests/playback-media-lifecycle.test.js`
- 문서:
    - `docs/update-history.md`

작업 시작 시 현재 branch, HEAD, `git status`, 기존 diff를 확인해요. 기준선 이후 구조가 바뀌었다면 현재 동등한 코드 경로에 적용해요.

사용자가 따로 요청하지 않는 한 다음 작업은 하지 않아요.

- 버전 증가
- 커밋, push, 병합, 태그
- GitHub Release 생성
- 시청 기록 전체 스키마의 불필요한 대규모 개편
- 기존 기록 자동 삭제
- 관련 없는 VOD UI 리팩터링

## 3. 현재 발생 가능한 오염 경로

### 3.1 대표 재현 흐름

1. 사용자가 `타 방송 다시보기 A`를 보고 있어요.
2. 새로고침 없이 SPA 이동으로 `라이브 B`에 들어가요.
3. URL과 영상은 B로 바뀌었지만 `og:title` 또는 `document.title`은 잠시 A 제목을 유지해요.
4. B의 영상이 먼저 재생되어 `startSession()`이 실행돼요.
5. `inferMetadataFromPage(channelId)`가 채널 ID는 B로 넣고 제목은 아직 남아 있는 A 페이지 제목에서 읽어요.
6. 세션 생성 시 해당 제목이 바로 `session.title`과 `titleHistory`에 들어가요.
7. 이후 B의 `live-detail` API가 올바른 제목을 반환해 대표 제목은 B로 교정돼요.
8. 그러나 A 제목은 이미 `titleHistory`에 들어갔으므로 삭제되지 않아요.
9. 나중에 B의 다시보기를 열면 A 제목이 B의 이전 방제로 표시돼요.

### 3.2 현재 구조의 문제점

현재 메타데이터 병합은 다음 두 책임을 함께 수행해요.

- 현재 표시·저장용 제목 갱신
- 제목 이력 영구 추가

따라서 출처가 검증되지 않은 페이지 제목도 `mergeMetadata()`를 통과하면 영구 이력이 돼요.

또한 API 성공 경로에서 페이지 메타데이터를 먼저 병합하고 API 메타데이터를 나중에 병합하므로, 최종 대표 제목은 정상이어도 잘못된 페이지 제목이 이력에 남아요.

## 4. 필수 설계 원칙

### 4.1 페이지 제목은 provisional metadata로 취급해요

`document.title`, `og:title`, `twitter:title`은 SPA 전환 직후 이전 화면 값을 유지할 수 있어요. 이 값은 현재 라이브 정체성을 증명하지 못해요.

따라서 페이지에서 읽은 제목은 다음 용도로만 사용할 수 있어요.

- API 응답 전 임시 표시
- 디버그 정보
- 현재 경로·채널·canonical identity를 별도로 검증한 제한적 fallback

기본적으로 다음에는 사용하지 않아요.

- `titleHistory` 추가
- background snapshot의 검증된 `title`
- session의 영구 제목
- 다시보기 매칭용 제목 이력

### 4.2 API 제목을 권위 데이터로 사용해요

`live-detail` API에서 현재 channelId와 liveId가 확인된 제목만 영구 제목 이력에 추가하는 것을 기본 계약으로 해요.

API 메타데이터를 적용하기 직전에 다음을 모두 확인해요.

- 요청 시작 당시 session 객체와 현재 `session`이 동일해요.
- request sequence 또는 generation token이 최신이에요.
- 요청 대상 channelId가 현재 URL의 channelId와 같아요.
- 현재 session의 channelId와 응답의 channelId가 충돌하지 않아요.
- 기존에 liveId가 고정돼 있다면 응답 liveId가 동일해요.
- 다른 liveId라면 기존 로직처럼 현재 세션을 종료하고 새 세션으로 시작해요.

### 4.3 제목 적용과 제목 이력 기록을 분리해요

현재 `mergeMetadata()`가 제목 갱신과 `addTitleHistory()`를 동시에 수행한다면 두 책임을 분리해요.

권장 형태는 다음과 같아요.

```js
function mergeMetadata(target, metadata, { persistTitle = false } = {}) {
    // channelId, liveId, channelName, thumbnailUrl 등 병합
    // title은 출처와 검증 여부에 따라 별도 처리
}
```

또는 더 명시적으로 다음처럼 분리해요.

```js
function mergeNonTitleMetadata(target, metadata) {}
function applyVerifiedTitle(target, title, seenAt) {}
function setProvisionalTitle(target, title) {}
```

핵심 계약은 다음과 같아요.

- page metadata: `persistTitle: false`
- verified API metadata: `persistTitle: true`

### 4.4 세션 시작 시 검증되지 않은 제목을 이력에 넣지 않아요

`startSession()`에서 세션 생성 직후 실행되는 `addTitleHistory(session, session.title, now)`는 제목이 검증됐을 때만 호출해야 해요.

권장 세션 상태 예시는 다음과 같아요.

```js
{
    title: "",
    provisionalTitle: pageMetadata.title,
    verifiedTitle: "",
    titleVerified: false,
    titleHistory: [],
}
```

API 제목이 확인되면 다음과 같이 갱신해요.

```js
session.title = verifiedTitle;
session.titleVerified = true;
addTitleHistory(session, verifiedTitle, seenAt);
```

페이지 제목은 API 성공 시 폐기하거나 임시 표시에서만 사용해요.

### 4.5 API 실패 시 잘못된 제목 저장보다 빈 제목을 우선해요

API 요청이 실패했을 때 이전 VOD 제목을 저장하는 것보다 제목이 비어 있는 편이 안전해요. 메타데이터 갱신은 이미 주기적으로 재시도하므로 다음 refresh에서 정상 제목을 받을 수 있어요.

페이지 제목을 fallback으로 영구 저장하려면 최소한 다음 정체성 검증을 모두 통과해야 해요.

- 현재 URL이 `/live/{channelId}`예요.
- capture 당시 URL과 적용 당시 URL이 같아요.
- DOM의 채널 링크 또는 channel identity가 동일 channelId예요.
- `og:url` 또는 canonical URL이 현재 라이브 경로와 일치해요.
- 짧은 안정화 구간 동안 제목과 identity가 변하지 않아요.
- 이전 `/video/{videoNo}` 페이지 제목이 아님을 확인해요.

이 검증을 구현하지 않을 경우 API 실패 시 페이지 제목을 영구 저장하지 않아요.

### 4.6 background로 보내는 snapshot에는 검증된 제목만 넣어요

`buildSessionSnapshot()`은 검증되지 않은 title을 entry와 session에 넣지 않아야 해요.

권장 방식 중 하나를 선택해요.

#### 방식 A: content script 내부에서 완전히 차단

```js
const storedTitle = current.titleVerified ? current.title : "";
```

- `entry.title`
- `entry.titleHistory`
- `session.title`

에 검증된 값만 전달해요.

#### 방식 B: 저장소 방어 필드 추가

operation에 `titleVerified` 또는 `titleSource`를 추가하고 `shared/watchHistoryStore.js`가 검증되지 않은 제목 필드를 무시해요.

예시:

```js
entry: {
    title,
    titleHistory,
    titleVerified: true,
}
```

스키마 변경 범위를 최소화하려면 방식 A를 필수로 하고, 방식 B는 방어 심층화로 적용해도 돼요. 다만 저장소 방어를 추가한다면 기존 데이터 정규화와 테스트를 함께 수정해요.

### 4.7 이미 검증된 제목만 이력으로 누적해요

실제 방송 중 방제가 바뀌면 API에서 새로운 제목이 확인될 수 있어요. 이 경우 기존 검증 제목과 새 검증 제목을 모두 보존해야 해요.

다음 계약을 유지해요.

- 같은 제목은 firstSeenAt·lastSeenAt만 확장해요.
- 다른 검증 제목은 새 이력으로 추가해요.
- 페이지 provisional title은 titleHistory에 포함하지 않아요.
- liveId가 바뀌면 새 세션으로 분리해요.

### 4.8 VOD 표시 로직은 오염된 저장값을 확대하지 않게 해요

주 수정 위치는 `liveWatchHistory.js`이지만, `vodBroadcastClock.js`도 다음을 확인해요.

- channelId가 detail과 명시적으로 다르면 반드시 탈락해요.
- liveId 충돌 항목은 반드시 탈락해요.
- 채널 identity가 unknown인 항목이 제목 유사도만으로 임계값을 넘지 않게 해요.
- `titleRows`는 선택된 entry의 값만 사용해요.

현재 채널·liveId·시간대 점수화 보호를 약하게 만들지 않아요.

## 5. 권장 구현 순서

### 5.1 메타데이터 출처를 명시해요

`inferMetadataFromPage()`와 `extractMetadataFromLiveDetail()`이 반환하는 값에 출처 정보를 넣는 것을 권장해요.

```js
{
    ...metadata,
    titleSource: "page" | "live-detail",
    capturedChannelId,
    capturedPath,
}
```

내부 전용 필드여도 돼요. 목적은 `mergeMetadata()`가 출처를 모른 채 모든 제목을 이력에 넣지 않게 하는 것이에요.

### 5.2 성공 경로의 병합 순서를 바꿔요

API가 성공한 경우 현재처럼 page title을 먼저 영구 병합하지 않아요.

권장 흐름:

```text
refresh 시작
→ current session과 route identity 캡처
→ page metadata는 provisional로 캡처
→ live-detail 요청
→ 최신 요청·동일 session·동일 channel 확인
→ API non-title metadata 병합
→ API verified title 적용 및 titleHistory 기록
→ 필요 시 provisional title 폐기
→ record ID promotion
```

### 5.3 실패 경로를 안전하게 바꿔요

API 실패 시 다음만 수행해요.

- 현재 route identity가 그대로인지 확인해요.
- 검증 가능한 channelName·thumbnail 등 비제목 필드는 제한적으로 병합해요.
- page title은 영구 titleHistory에 추가하지 않아요.
- 다음 metadata refresh를 예약해요.

### 5.4 초기 flush 경쟁 상태를 확인해요

최소 저장 시간 이후 첫 flush가 API 응답보다 먼저 일어날 수 있어요. 이때 snapshot에 provisional title이 들어가면 수정이 불완전해요.

따라서 API 응답 전에도 다음이 보장돼야 해요.

- 저장되는 title은 빈 값 또는 이전에 검증된 현재 세션 제목이에요.
- provisional page title은 snapshot에 포함되지 않아요.
- 나중에 API 제목이 확인되면 같은 session snapshot 갱신으로 제목이 추가돼요.

### 5.5 기존 오염 데이터는 자동 삭제하지 않아요

기존 `titleHistory`에는 출처 정보가 없으므로, 어떤 제목이 실제 방제였고 어떤 제목이 타 방송에서 섞였는지 완벽하게 판별하기 어려워요.

이번 수정에서 다음 자동 정리는 하지 않아요.

- 제목 유사도가 낮다는 이유로 기존 titleHistory 삭제
- 세션 시작 직후 기록된 제목 일괄 삭제
- 현재 대표 제목과 다른 제목 전부 삭제

이 작업이 필요하면 별도 기능으로 다음 중 하나를 설계해요.

- 항목별 방제 이력 초기화
- 개별 제목 이력 삭제
- API와 세션 기록을 이용한 보수적 재구성

이번 작업에서는 새 오염 발생 방지에 집중해요.

## 6. 필수 회귀 테스트

### 6.1 VOD에서 라이브로 SPA 이동하며 이전 제목이 남는 경우

가장 중요한 재현 테스트예요.

```text
초기 상태
- URL: /video/old-video
- document.title: 타 방송 다시보기 제목
- og:title: 타 방송 다시보기 제목

SPA 이동
- URL: /live/new-channel
- document.title과 og:title은 이전 값을 잠시 유지
- 라이브 video가 재생되어 session 시작

API 응답
- channelId: new-channel
- liveId: new-live
- title: 새 방송의 올바른 제목

기대 결과
- recordId는 live:new-live
- entry.title은 새 방송 제목
- session.title은 새 방송 제목
- titleHistory에는 새 방송 제목만 존재
- 타 방송 다시보기 제목은 entry, session, titleHistory 어디에도 없음
```

### 6.2 API보다 첫 flush가 먼저 발생하는 경우

- session을 시작해 최소 저장 시간을 충족시켜요.
- API 응답을 보류한 채 flush를 실행해요.
- 저장 snapshot의 title과 titleHistory에 이전 VOD 제목이 없어야 해요.
- 이후 API 응답을 완료해 같은 session에 올바른 제목이 추가되는지 확인해요.

### 6.3 API 실패

- 이전 VOD 제목이 page metadata에 남아 있어요.
- live-detail 요청은 실패해요.
- 시청 시간은 저장돼요.
- 저장된 entry/session/titleHistory에 이전 VOD 제목이 없어야 해요.
- 다음 metadata refresh 예약이 유지돼야 해요.

### 6.4 실제 방제 변경

- 같은 channelId와 liveId의 첫 API 제목 A를 저장해요.
- 다음 refresh에서 제목 B를 반환해요.
- titleHistory에 A와 B가 각각 한 번씩 존재해야 해요.
- 동일 제목 A가 반복되면 중복 행이 아니라 seen range만 확장돼야 해요.

### 6.5 빠른 라이브 A → 라이브 B 이동

- A의 API 응답을 지연시켜요.
- B로 이동해 새 session을 시작해요.
- B API 응답을 먼저 완료해요.
- 이후 A 응답을 완료해요.
- A 제목·liveId·thumbnail이 B 세션에 적용되지 않아야 해요.

기존 request sequence와 `session !== current` 보호가 유지되는지도 확인해요.

### 6.6 VOD 표시 매칭

- B 기록에 B 제목 이력만 있을 때 B 다시보기 패널에 올바른 이력만 보여요.
- channelId가 다른 기록은 제목이 같아도 선택되지 않아요.
- liveId가 충돌하는 기록은 선택되지 않아요.
- 저장소 변경 중 오래된 snapshot이 최신 패널을 덮지 않는 기존 테스트를 유지해요.

### 6.7 watch history store 방어 테스트

저장소에 `titleVerified` 또는 출처 필드를 추가했다면 다음을 검사해요.

- 검증되지 않은 title patch는 entry.title을 덮지 않아요.
- 검증되지 않은 titleHistory는 병합하지 않아요.
- 검증된 제목은 기존처럼 병합돼요.
- record migration 시 검증 제목만 유지돼요.
- 기존 저장 데이터 normalize가 깨지지 않아요.

## 7. 수동 검증 시나리오

실브라우저 접근이 가능하면 다음을 확인해요.

1. 다른 방송의 다시보기를 열어요.
2. 치지직 내부 링크로 새 라이브에 SPA 이동해요.
3. 개발자 도구에서 이동 직후 `document.title`과 `og:title`이 이전 값을 잠시 유지하는지 관찰해요.
4. 새 라이브를 최소 저장 시간 이상 재생해요.
5. 시청 기록 페이지에서 새 방송의 제목과 세션 제목을 확인해요.
6. 방송 종료 후 생성된 다시보기에서 이전 방제 패널을 확인해요.
7. 이전에 본 타 방송 제목이 나타나지 않는지 확인해요.
8. 같은 라이브에서 실제 방제가 바뀐 경우 두 제목은 정상 표시되는지 확인해요.
9. 콘솔 오류와 반복 metadata 요청이 없는지 확인해요.

실브라우저 검증이 불가능하면 수행한 것처럼 보고하지 않아요.

## 8. 완료 기준

아래 조건을 모두 만족해야 완료예요.

- SPA 전환 직후 이전 VOD 제목이 새 라이브 titleHistory에 저장되지 않아요.
- API 응답 전 flush가 발생해도 provisional title이 저장되지 않아요.
- API 실패 시 이전 페이지 제목보다 빈 제목을 선택해요.
- API로 확인된 실제 방제 변경은 정상 보존돼요.
- 이전 라이브의 늦은 응답이 새 라이브 세션을 오염시키지 않아요.
- VOD 매칭의 channelId·liveId 보호를 유지해요.
- 기존 오염 데이터를 파괴적으로 자동 삭제하지 않아요.
- 기존 테스트를 삭제하거나 assertion을 느슨하게 만들지 않아요.
- lint, test, format 검증 결과를 보고해요.

## 9. 검증 명령

현재 `package.json`과 `AGENTS.md`를 먼저 확인한 뒤 일반적으로 다음을 실행해요.

```text
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run format:check
```

변경 파일만 별도 확인할 경우 예시는 다음과 같아요.

```text
npx.cmd prettier --check features/liveWatchHistory.js shared/watchHistoryStore.js shared/data.js features/vodBroadcastClock.js tests/extension-pages.test.js tests/watch-history-store.test.js tests/playback-media-lifecycle.test.js docs/update-history.md
```

전체 검사 실패와 변경 범위 검사 결과를 구분해 보고해요.

## 10. 업데이트 내역 권장 문구

수정 완료 시 사용자용 변경 내역은 다음 의미를 포함해요.

> 다시보기에서 라이브로 이동한 직후 이전 페이지 제목이 새 방송의 방제 이력에 섞여 저장되던 문제를 수정했습니다. 현재 방송 정보가 확인된 제목만 방제 이력에 보존합니다.

내부 구현 세부사항이나 자동 정리를 했다는 오해가 생기는 표현은 피하고, 기존 오염 데이터가 자동 삭제되지 않는다면 별도로 명시해요.

## 11. 완료 보고 형식

최종 보고에는 다음을 포함해요.

1. 실제 확인한 오염 경로
2. 제목 출처와 검증 경계를 어떻게 분리했는지
3. 변경한 파일
4. API 성공·실패·지연 응답 처리 방식
5. 추가한 회귀 테스트 목록
6. 실행한 검증 명령과 결과
7. 실브라우저 검증 여부
8. 기존 오염 데이터 처리 여부와 남은 제한

구현하지 않은 정리 기능이나 테스트를 완료한 것처럼 표현하지 않아요.
