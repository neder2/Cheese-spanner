# Better Chzzk 방송자·채팅 운영자 모아보기 후속 안정화 작업 지침서

## 1. 작업 목적

Better Chzzk 1.2.5의 `방송자·채팅 운영자 채팅 모아보기`는 가상 채팅 행 재사용, DOM 재마운트, 원본 ID가 없는 메시지 중복 수집을 상당 부분 보강했어요. 그러나 재사용 중간 상태가 현재 안정화 대기 시간보다 오래 유지되면, 일반 시청자의 새 행이 이전 운영자 배지·본문과 섞인 상태로 한 번 확정된 뒤 모아보기 목록에 남을 수 있어요.

이 작업의 목적은 다음과 같아요.

- 가상 행의 단계적 갱신 중 발생한 혼합 상태를 운영자 메시지로 영구 확정하지 않아요.
- 이미 정상적으로 수집된 과거 운영자 메시지는 행이 재사용되어도 보존해요.
- 잘못 확정된 재사용 후보는 같은 행 세대 안에서 최종 상태가 일반 시청자로 드러나면 철회해요.
- 같은 작성자가 같은 내용을 실제로 여러 번 보낸 경우는 각각 유지해요.
- 재마운트, 블라인드 전환, 패널 열기·닫기, 스크롤 성능을 회귀시키지 않아요.

## 2. 저장소 기준과 작업 경계

- 저장소: `neder2/Chzzk`
- 기준선: `main`의 Better Chzzk 1.2.5, `5591505` 계열
- 핵심 파일:
    - `features/chatTools.js`
    - `tests/chat-tools.test.js`
- 함께 확인할 파일:
    - `AGENTS.md`
    - `shared/settings.js`
    - `docs/update-history.md`
    - `package.json`

작업 시작 시 현재 branch, HEAD, `git status`, 기존 diff를 먼저 확인해요. 기준선 이후 코드가 변경됐다면 현재 구현의 동등한 함수와 상태를 찾아 적용하고, 다른 기능의 수정은 섞지 않아요.

사용자가 따로 요청하지 않는 한 다음 작업은 하지 않아요.

- 버전 증가
- 커밋, push, 병합, 태그
- GitHub Release 생성
- 무관한 리팩터링이나 전면 포맷
- 기존 테스트 삭제 또는 assertion 완화

## 3. 현재 구현에서 이미 해결된 부분

현재 코드는 대체로 다음 보호 장치를 가지고 있어요.

- `moderatorRowBindings`로 DOM 행과 수집 메시지의 현재 소유 관계를 관리해요.
- `moderatorRowTransitions`와 mutation revision으로 재사용 후보를 일정 시간 안정화해요.
- `pendingModeratorRemounts`로 같은 child-list 교체에서 ID 없는 행의 재마운트 정체성을 넘겨줘요.
- 모아보기 항목 클릭 시 현재 행 바인딩이 동일 메시지인지 다시 확인해요.
- 잘못 남은 `data-bcct-moderator-collected` 속성은 바인딩이 없으면 제거해요.
- 증분 mutation 처리와 append 렌더링으로 전체 목록 재탐색을 줄여요.

이 구조를 폐기하지 말고, 남은 결함만 보강해요.

## 4. 남은 핵심 결함

### 4.1 재현 흐름

1. 운영자 메시지 A가 ID 없는 가상 행 R에 수집돼요.
2. 치지직이 R을 다음 일반 시청자 메시지에 재사용해요.
3. `data-virtual-index`와 닉네임만 먼저 바뀌고, 이전 운영자 배지와 본문은 잠시 남아요.
4. 이 혼합 상태가 현재 안정화 기준보다 오래 유지돼요.
5. 코드가 이를 새 운영자 메시지 B로 확정해 `moderatorMessages`에 넣어요.
6. 이후 운영자 배지가 사라지고 일반 시청자의 실제 본문이 들어와요.
7. 행 바인딩은 끊겨도 이미 추가된 B는 `moderatorMessages`와 `collectedMessageIds`에서 제거되지 않아 모아보기에 남아요.

### 4.2 본질적인 원인

현재 안정화는 “일정 시간 동안 스냅샷이 변하지 않았다”만 확인해요. 그러나 React가 단계적으로 DOM을 갱신하는 중간 상태는 일정 시간 이상 유지될 수 있어요. 고정 지연 시간을 늘리는 방식만으로는 결함을 제거할 수 없어요.

필요한 것은 시간 기반 확인만이 아니라 다음 두 가지예요.

- 재사용 전환에서 만들어진 메시지의 소유권을 별도로 추적해요.
- 같은 행 세대 안에서 이후 상태가 모순되면 그 메시지만 철회해요.

## 5. 필수 설계 원칙

### 5.1 기존 정상 메시지와 재사용 전환 메시지를 구분해요

재사용 전환에서 새로 만들어진 메시지는 일반 수집 메시지와 구분할 수 있어야 해요. 내부 구현 방식은 자유지만, 다음 정보와 동등한 상태가 필요해요.

- 전환 식별자 또는 generation token
- 전환이 시작된 원본 행
- 전환 당시의 reuse signal
- 전환 당시의 `id`, `author`, `role`, `text` 스냅샷
- 해당 메시지가 이번 전환에서 새로 생성됐는지 여부
- 같은 세대 안에서 철회 가능한 상태인지 여부

권장 예시는 다음과 같아요.

```js
{
    transitionId,
    sourceRow,
    sourceReuseSignal,
    sourceIdentityKey,
    message,
    retractable: true,
}
```

메시지 객체에 직접 필드를 넣거나 별도 `Map`으로 관리해도 돼요. 다만 일반 메시지와 전환 소유 메시지를 확실히 구분해야 해요.

### 5.2 철회는 이번 전환에서 새로 만든 메시지에만 적용해요

행 R이 운영자 메시지 A에서 다른 상태로 재사용될 때, A는 과거의 정상 메시지이므로 목록에 남아야 해요.

철회 대상은 다음 조건을 모두 만족하는 항목뿐이에요.

- 현재 재사용 전환에서 새로 생성됐어요.
- 아직 같은 행 세대 또는 같은 reuse signal에 속해요.
- 최종 파싱 결과가 해당 메시지의 운영자 정체성과 모순돼요.

다음 상황에서는 전환 소유 메시지를 철회해야 해요.

- 같은 reuse signal에서 역할이 사라져 일반 시청자가 됐어요.
- 같은 reuse signal에서 작성자·본문·역할 조합이 다른 최종 상태로 바뀌었어요.
- 명시적 메시지 ID가 전환 당시 값과 충돌해요.
- 현재 행이 더 이상 해당 전환 메시지의 소유 행이 아니에요.

철회 시 다음 상태를 모두 정리해요.

- `moderatorMessages`
- `collectedMessageIds`
- `moderatorRowBindings`
- 행의 `data-bcct-moderator-collected`
- 관련 transition timer와 pending state
- 렌더 키와 카운트

목록 렌더는 한 mutation batch에서 한 번만 수행하도록 기존 `deferRender` 패턴을 유지해요.

### 5.3 고정 대기 시간만 늘리는 수정은 금지해요

다음과 같은 수정만으로 완료 처리하지 않아요.

```js
MODERATOR_REUSE_STABILITY_CHECK_MS = 500;
MODERATOR_REUSE_REQUIRED_STABLE_PASSES = 5;
```

대기 시간을 조정할 수는 있지만, 반드시 소유권 추적과 철회 경로가 함께 있어야 해요.

### 5.4 행 세대 경계를 명시해요

가능한 경우 다음 순서로 행 세대를 판별해요.

1. `data-chat-id`, `data-message-id`, `data-id` 등 명시적 메시지 ID
2. `data-virtual-index`, `data-row-key`, `aria-posinset` 등 reuse signal
3. 위 정보가 없는 경우 전환 시작 시 생성한 synthetic generation token

reuse signal이 다시 바뀌면 이전 세대의 메시지는 정상 메시지로 남기고 다음 세대를 새로 시작할 수 있어요. 반대로 reuse signal이 그대로인 상태에서 역할·작성자·본문이 최종적으로 일반 시청자 상태로 변하면 같은 전환의 중간 혼합 상태로 보고 철회해요.

명시적 signal이 없는 행은 다음 경계를 활용해요.

- DOM 행 제거·교체
- 일반 시청자 상태를 거친 뒤 새 운영자 상태가 시작됨
- 명시적 메시지 ID가 뒤늦게 등장함
- 별도 mutation batch에서 완전히 다른 운영자 fingerprint가 확정됨

기존의 “ID 없는 같은 작성자·새 본문 수집” 동작은 유지해야 해요.

### 5.5 클릭 소유권 검사는 유지하고 더 약하게 만들지 않아요

`scrollToOriginalMessage()`는 현재 행의 바인딩이 클릭한 메시지와 동일할 때만 스크롤해야 해요. 전환 메시지를 철회한 뒤에는 해당 항목 자체가 없어야 하며, 혹시 오래된 버튼 참조가 남더라도 다른 시청자 행으로 이동하면 안 돼요.

### 5.6 재마운트 처리와 철회 처리를 충돌시키지 않아요

같은 mutation record 안에서 ID 없는 행이 제거되고 동일 메시지 행이 새로 추가되는 경우는 재마운트예요. 이때는 기존 메시지를 중복 추가하거나 철회하지 말고 새 행으로 바인딩을 넘겨야 해요.

반면 제거와 추가가 별도 mutation record 또는 별도 batch에서 일어나고, 실제로 같은 내용이 다시 전송된 경우는 새 메시지로 유지해야 해요.

기존 `pendingModeratorRemounts`의 다음 계약을 보존해요.

- 같은 child-list 교체의 added subtree 안에서만 후보를 소비해요.
- 동일한 내용의 행 여러 개가 함께 재마운트돼도 순서대로 한 번씩 대응해요.
- 서로 다른 실제 같은 내용 메시지를 전역 fingerprint 중복 제거로 합치지 않아요.

## 6. 권장 구현 순서

### 6.1 관련 상태와 호출 흐름을 먼저 도식화해요

다음 함수와 상태의 호출 관계를 확인해요.

- `parseChatMessage`
- `getMessageId`
- `buildModeratorSnapshot`
- `collectModeratorMessage`
- `stageReusedModeratorCandidate`
- `confirmReusedModeratorCandidate`
- `commitModeratorMessage`
- `bindModeratorRow`
- `detachModeratorRowBinding`
- `clearOriginalTextCachesInRemovedSubtree`
- `queueModeratorRemounts`
- `syncChatTools`
- `clearModeratorState`
- `restartRuntime`
- `uninstallRuntime`

### 6.2 메시지 제거 헬퍼를 단일화해요

특정 메시지를 안전하게 제거하는 헬퍼를 추가하는 것을 권장해요.

예시 역할:

```js
function removeModeratorMessage(message, { deferRender = false } = {}) {
    // 배열 제거
    // collectedMessageIds 제거
    // 현재 행 바인딩 해제
    // transition/pending 참조 제거
    // 필요 시 렌더
}
```

같은 제거 로직을 여러 위치에서 부분적으로 구현하지 않아요.

### 6.3 전환 메시지의 수명주기를 구현해요

권장 상태 전이는 다음과 같아요.

```text
staged
  → 안정화 통과
  → retractable collected message
  → 같은 세대에서 일관성 유지
  → 세대 종료 또는 안전한 재마운트
  → finalized
```

모순 상태가 감지되면 다음과 같아요.

```text
staged/retractable
  → 역할 소실 또는 identity 충돌
  → retract
  → 목록·카운트·바인딩 정리
```

재사용 전환이 아닌 최초 수집 메시지는 기존처럼 바로 정상 메시지로 취급해도 돼요.

### 6.4 cleanup 경로를 모두 연결해요

다음 경로에서 timer, transition, retractable message가 남지 않게 해요.

- 옵션 비활성화
- 라이브 라우트 이탈
- 다른 방송으로 이동
- 채팅 root 교체
- 모아보기 상태 초기화
- content script teardown
- DOM subtree 제거

## 7. 필수 회귀 테스트

기존 테스트를 유지하면서 아래 테스트를 추가해요.

### 7.1 장시간 혼합 상태 후 일반 시청자로 확정

가장 중요한 재현 테스트예요.

```text
1. 운영자 메시지 A 수집
2. 같은 행의 virtual index와 닉네임만 일반 시청자로 변경
3. 운영자 배지와 A 본문을 500ms 이상 유지
4. 필요하면 2초 이상 유지하는 별도 테스트도 추가
5. 같은 virtual index에서 배지를 제거하고 일반 시청자 본문으로 변경
6. 최종 모아보기에는 A 하나만 존재
7. 일반 시청자 닉네임 또는 본문이 모아보기에 없어야 함
8. A 클릭 시 현재 일반 시청자 행으로 스크롤하지 않아야 함
```

이 테스트는 기존 160ms 경계 테스트를 대체하지 말고 추가해요.

### 7.2 잘못 생성된 전환 메시지 철회

테스트 내부에서 안정화 기준을 넘겨 전환 메시지가 생성될 수 있는 시점을 만든 뒤, 최종 일반 시청자 상태로 바꿔 카운트와 DOM 행이 다시 줄어드는지 확인해요.

- `.bcct-moderator-trigger__count`
- `.bcct-moderator-row` 개수
- 목록 본문
- source row marker

을 함께 검사해요.

### 7.3 실제 새 운영자 메시지는 유지

다음을 각각 검증해요.

- 같은 행, 다른 virtual index, 다른 운영자, 다른 본문
- 같은 행, 다른 virtual index, 같은 운영자, 다른 본문
- 같은 행, 다른 virtual index, 다른 운영자, 같은 본문
- explicit message ID가 있는 새 운영자 메시지

오탐 방지를 위해 실제 새 메시지까지 철회되면 안 돼요.

### 7.4 동일 내용의 실제 메시지는 분리

- 서로 다른 두 DOM 행의 같은 작성자·같은 본문
- 동일 행이 제거된 뒤 별도 mutation batch에서 같은 내용이 다시 추가됨
- 동일한 두 행이 한 번에 재마운트됨

각 계약을 현재 테스트와 동일하게 유지해요.

### 7.5 블라인드 전환

운영자 메시지가 사후 블라인드 문구로 바뀌어도 기존 수집 identity를 유지하고 중복을 만들지 않아야 해요. 원문을 알 수 없는 경우에도 다른 작성자 메시지로 바꾸면 안 돼요.

### 7.6 cleanup

- 옵션을 끄면 pending transition과 timer가 정리돼요.
- 라우트 변경 후 이전 전환 callback이 새 방송 상태를 건드리지 않아요.
- 채팅 root 교체 후 이전 행 바인딩과 transition이 남지 않아요.

### 7.7 성능 회귀

기존 성능 테스트를 유지하고 다음을 확인해요.

- 한 행 제거가 살아 있는 형제 행 전체 파싱으로 이어지지 않아요.
- 패널 열기·닫기가 broad chat root observer 되먹임을 만들지 않아요.
- 여러 메시지 batch 추가 시 최종 목록 렌더가 한 번의 batch 수준으로 유지돼요.
- 전환 철회가 매번 전체 `moderatorMessages.find()` 순회와 전체 DOM 재탐색을 반복하지 않도록 해요.

## 8. 수동 검증 시나리오

실브라우저 접근이 가능하면 다음 순서로 확인해요.

1. 확장 프로그램을 다시 로드해요.
2. 모아보기 옵션을 켜요.
3. 운영자 메시지가 있는 라이브에서 채팅을 빠르게 위아래로 스크롤해 가상 행 재사용을 유도해요.
4. 패널을 여러 번 열고 닫아요.
5. 일반 시청자 닉네임으로 운영자 메시지가 복제되지 않는지 확인해요.
6. 같은 운영자가 같은 문구를 실제로 두 번 보낸 경우 두 행이 유지되는지 확인해요.
7. 과거 항목을 클릭했을 때 현재 다른 시청자의 행으로 이동하지 않는지 확인해요.
8. 콘솔 오류, observer loop, 눈에 띄는 스크롤 끊김이 없는지 확인해요.

실브라우저 검증이 불가능하면 수행한 것처럼 보고하지 말고 미검증으로 명시해요.

## 9. 완료 기준

아래 조건을 모두 만족해야 완료예요.

- 500ms 이상 유지된 혼합 상태가 최종 일반 시청자 상태로 바뀌면 잘못된 항목이 남지 않아요.
- 고정 지연 시간 증가만으로 해결하지 않았어요.
- 이전 정상 운영자 메시지는 보존돼요.
- 실제 새 운영자 메시지는 수집돼요.
- 같은 내용의 실제 메시지를 합치지 않아요.
- 재마운트 중복 방지와 클릭 소유권 검사가 유지돼요.
- 옵션 해제·라우트 변경·root 교체 시 timer와 transition이 정리돼요.
- 기존 테스트를 삭제하거나 느슨하게 만들지 않았어요.
- lint, test, format 검증 결과를 보고했어요.

## 10. 검증 명령

Windows 저장소 기준 명령은 현재 `package.json`과 `AGENTS.md`를 우선 확인해요. 일반적으로 다음을 실행해요.

```text
npm.cmd ci
npm.cmd run lint
npm.cmd test
npm.cmd run format:check
```

전체 `format:check`가 범위 밖 기존 drift로 실패하면 변경 파일만 별도로 검사하고, 전체 실패 원인과 변경 파일 결과를 구분해 보고해요.

예시:

```text
npx.cmd prettier --check features/chatTools.js tests/chat-tools.test.js docs/update-history.md
```

## 11. 완료 보고 형식

최종 보고에는 다음을 포함해요.

1. 수정한 핵심 원인
2. 변경한 파일
3. 재사용 전환 메시지의 새 수명주기
4. 추가한 회귀 테스트 목록
5. 실행한 검증 명령과 결과
6. 실브라우저 검증 여부
7. 남아 있는 불확실성

구현하지 않은 내용을 완료한 것처럼 표현하지 않아요.
