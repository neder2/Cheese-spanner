# 라이브 멀티뷰 조합 저장·채팅 키워드 강조 설계 — 2026-10-17

## 범위와 근거

2026-10-17 사용자가 두 기능의 설계를 요청했고, 구현 전에 범위와 저장 형식을 먼저 정리하기로 했어요. 이 문서는 설계안이며 구현·옵션·저장 형식이 확정된 명세는 아니에요. 아래 `결정이 필요한 항목`에 사용자 결정이 있으면 그 결정이 우선해요.

작업 기준은 `1.4.5` branch, HEAD `acbc587`이에요. 작업 트리에는 같은 날 수정한 미커밋 변경(패널 높이·VOD 정보 열·채팅 멀티뷰·팔로잉)이 있고 이 문서는 그 변경을 건드리지 않아요. 커밋·버전·릴리스는 범위 밖이에요.

## 실제 화면 근거와 한계

- 이번 설계는 저장소의 코드·테스트·문서만 읽어 정리했어요. **실제 Chrome·치지직 화면은 확인하지 않았어요.**
- 멀티뷰 세션 상태의 형식은 `features/liveMultiview/model.js`의 `session`·`validTree`·`normalizeWindows`, 채널별 영구 저장은 `features/liveMultiview/playback.js`의 `betterChzzkMultiviewDelay:`·`betterChzzkMultiviewQuality:` 키, 설정 저장 큐의 허용 키는 `shared/settingsBackup.js`의 `isStoreKey`·`validateStoreEntry`에서 확인했어요.
- 채팅 행 파서가 돌려주는 필드(`author`, `role`, `text`, `badges`, `authorColor`, `timestamp`, `isBlind`)와 모아보기 저장소의 수집 경로는 `features/chatTools/parser.js`·`messageStore.js`에서 확인했어요.
- 로그인 사용자 닉네임을 자동으로 알 수 있는 확인된 경로는 없어요. [2026-09-19 실측](measurements/watch-activity-2026-09-19.md)의 `getUserStatus` 응답에는 `loggedIn`·`userIdHash`만 기록돼 있고, 채팅 행 React props에서 확인한 것도 `user` 해시예요. 치지직 채팅의 네이티브 `@닉네임` 멘션 표시 유무도 실측 전이에요.

---

## 1. 라이브 멀티뷰 조합 저장·불러오기

### 목표

자주 함께 보는 방송 조합(채널 목록과 배치)을 이름을 붙여 저장하고, 멀티뷰 설정 패널이나 방송 추가 패널에서 한 번에 불러와요. 지금은 구성·배치가 탭 `sessionStorage`에만 남아 탭을 닫으면 사라지고, 채널별 딜레이·화질만 확장 local에 남아요.

### 범위

- **포함:** 조합 저장(이름 입력), 목록 표시, 불러오기, 삭제, 같은 이름 덮어쓰기, 설정 파일 백업·복원 포함, 다른 탭의 변경 반영.
- **제외(v1):** 조합 이름 변경(삭제 후 다시 저장), 순서 변경, 조합 자동 저장, 멀티뷰가 꺼진 상태에서의 불러오기, 조합에 딜레이·화질 포함(채널별 local 값이 이미 자동 적용돼요), 조합 간 비교·병합.
- 조합은 영상 멀티뷰 전용이에요. 채팅 멀티뷰 구성(`betterchzzk:chat-multiview:v1`)과 묶지 않아요.

### 저장 위치와 형식

확장 **local** 단일 키 `betterchzzk:multiview-presets:v1`에 전체를 한 번에 교체해요. sync가 아닌 이유는 채널별 딜레이·화질·채팅 멀티뷰 구성과 같은 영역에 두고, sync 항목 8KB 한도를 피하며, 기기 이동은 설정 파일로 하기 위해서예요.

```text
{
  version: 1,
  presets: [
    {
      id: "p" + 16자리 소문자 16진수,               // 생성 시 1회, 목록 조작·테스트의 정체성
      name: 앞뒤 공백 없는 1~20 code point 문자열,   // 같은 이름 중복 없음(대소문자 구분)
      savedAt: 안전한 정수 epoch ms,               // 2020-01-01 이후
      channels: [                                  // 2~6개, channelId 중복 없음, 첫 항목이 저장 당시 메인
        { channelId: 소문자 32자리 16진수,
          channelName: 앞뒤 공백 없는 0~100 code point 문자열,  // 표시용, 식별은 channelId
          volume: 0~1 숫자(소수 셋째 자리까지),
          muted: boolean,
          position: [0~1, 0~1] }                   // 분할 박스 안 영상 위치
      ],
      layout: {
        freeLayoutEnabled: boolean,
        freeWindowSpace: "player" | "viewport",
        customLayout: boolean,
        dockTree: 분할 트리,                        // 아래 검증 규칙
        freeWindows: [ { id: channels 안의 channelId, rect: [x, y, w, h] } ]  // 중복 없음, 0~1, x+w·y+h ≤ 1
      }
    }
  ]
}
```

- `dockTree`는 세션과 같은 모양이에요. 리프는 `channelId` 문자열 또는 `null`(빈 자리, 최대 5개), 가지는 `{axis:"columns"|"rows", ratio: 0.05~0.95, a, b}`예요. 노드 31개·깊이 10 이하이고 리프 ID 집합이 `channels`와 정확히 같아야 해요(`model.validTree`와 같은 규칙을 공용 모델이 자체 구현해요).
- **상한:** 조합 10개, 이름 20자, 조합당 채널 2~6개(메인 포함), 직렬화 64KB 이하. 상한을 넘는 저장은 거절하고 잘라서 성공으로 만들지 않아요.
- 파싱은 엄격 검증(`parseState`)이며 형식이 다르면 기본 상태(빈 목록)로 읽고 읽기만으로 저장하지 않아요. `version`이 다르면 무시해요(이후 형식 변경 시 이 문서와 `docs/contracts.md`를 함께 갱신).

### 저장 동작

- 조건: 멀티뷰가 켜져 있고(`state.active`) 보조 방송이 1개 이상이에요. 메인만 있을 때는 저장 버튼을 비활성화하고 이유를 보여줘요.
- 멀티뷰 설정 패널(채팅 상단 멀티뷰 설정 버튼)에 **조합** 영역을 추가해요. 영역에는 저장한 조합 목록(이름·채널 수·`불러오기`·`삭제`)과 `현재 구성 저장` 버튼이 있어요. 버튼을 누르면 같은 영역 안에 이름 입력과 `저장`이 열려요(별도 모달 없음, Escape로 닫기).
- 채널 이름은 `players.get(id)?.name`(live-detail의 `channelName`)을 그대로 넣고 없으면 빈 문자열이에요. 메인 채널 이름은 메인 플레이어 상태에서 같은 방식으로 읽고, 없으면 빈 문자열이에요.
- 같은 이름이 있으면 **두 번 눌러 확정**해요(팔로잉 폴더 삭제와 같은 패턴). 첫 누름은 `같은 이름을 덮어써요 — 다시 누르면 저장`으로 바뀌고 3초 안에 다시 누르면 교체, 아니면 원래로 돌아가요.
- 저장 경로는 `BetterChzzk.utils.settingsStoreSet("local", { [KEY]: next }, { [KEY]: expectedCurrent })`예요. `chrome.storage.local.set`을 직접 호출하지 않아요. `conflict`면 `error.current`로 목록을 다시 읽어 안내하고 자동 재시도하지 않아요(채팅 멀티뷰 구성 저장과 같은 규칙). 그 밖의 실패는 현재 문서의 메모리 목록을 유지하고 저장 실패를 안내해요.
- 목록 읽기는 `storageGet`, 다른 탭의 변경은 `storage.onChanged`로 반영해요. 열림 상태·이름 입력 중 내용은 저장하지 않아요.

### 불러오기 동작

- 진입: (1) 멀티뷰 설정 패널의 조합 목록 `불러오기`, (2) 방송 추가 패널 하단의 `저장한 조합` 목록(멀티뷰를 켰는데 보조가 없으면 자동으로 열리는 패널이라 가장 자연스러운 진입이에요). 두 곳 모두 멀티뷰가 켜진 상태에서만 동작해요.
- 조합은 **구성 전체**예요. 현재 보조 방송을 모두 교체하며, 교체 전 현재 보조가 1개 이상이면 두 번 눌러 확정해요. 메인은 치지직 라우터가 소유하므로 페이지를 이동하지 않아요.
- **메인 매핑(순수 함수 `model.applyPreset(state, preset, routeId)`):** 현재 메인을 R, 조합의 첫 채널을 M이라고 할 때
    1. R가 M과 같으면 조합을 그대로 적용해요.
    2. R가 조합의 보조 중 하나면 트리·자유 창·채널 순서에서 M과 R를 서로 바꿔요(`alignRoute`가 라우트 이동 때 쓰는 `mapTree` 교환과 같아요). 배치는 보존돼요.
    3. R가 조합에 없으면 트리·자유 창의 M 자리를 R로 바꾸고, M은 보조로 `addTree`해요. 6개 상한을 넘으면 M을 넣지 않고 안내해요.
- 결과 채널은 최대 6개예요. 상한 때문에 뺀 채널이 있으면 `6개 상한으로 n개를 넣지 않았어요`로 안내해요.
- 보조의 볼륨·음소거·박스 안 위치는 조합값을 적용해요. **메인의 볼륨·음소거는 적용하지 않아요.** 네이티브 플레이어의 현재 상태를 유지해요(메인 재생 조작은 네이티브 소유).
- 딜레이·화질은 조합과 무관하게 채널별 local 값이 기존 경로로 복원돼요.
- 종료·재생 실패 방송은 기존 셀의 오류·재시도 표시를 그대로 사용해요. 불러오기 안내는 `n개 방송을 불러왔어요`처럼 중립적으로 쓰고 재생 성공을 뜻하지 않아요.
- 적용 뒤 `persistSession` → `players.reconcile` → `render` 순서로 기존 추가 경로와 같아요. 자유 배치가 켜진 조합은 `layout.setFreeMode`를 거쳐 창을 복원해요.

### 삭제

- 목록의 `삭제`는 두 번 눌러 확정해요. 삭제는 조합만 지우고 현재 멀티뷰 구성·채널별 딜레이·화질은 바꾸지 않아요.

### 옵션·설정 파일·문서

- 새 옵션은 없어요. `liveMultiviewEnabled`에 종속되며 멀티뷰를 끄면 조합 UI도 사라져요. 저장값은 기능을 꺼도 유지하고 확장 데이터 삭제·확장 제거로 지워져요.
- 설정 파일: `LOCAL_SECTIONS`에 `multiviewPresets`를 추가해요(라벨 `멀티뷰 조합`). 미리보기는 `n개 조합 · 변경/동일`로 보여 주고 적용은 전체 교체예요. 파일에 구역이 없으면 현재 값을 유지해요(채팅 멀티뷰 구성과 같은 규칙). 워커는 공용 모델의 `parseState`로 다시 검증해요.
- 설정 저장 큐: `isStoreKey`·`validateStoreEntry`·`sectionOf`에 새 키를 추가해요. 발신자 검증은 기존 그대로예요. 요청은 단일 키라 `MAX_STORE_KEYS`(8) 안이에요.
- 문서: `docs/contracts.md`(저장 형식·허용 키·백업 구역), `docs/security.md`(local 보관 목록), `docs/business-rules.md`(멀티뷰 절), `features/liveMultiview/AGENTS.md`, README(17절·설정 파일 절), 릴리스 때 `docs/update-history.md`.

### 수용 기준

- 조합이 없을 때 패널·세션 상태·DOM에 변화가 없어요.
- 저장 → 새로고침 → 불러오기에서 채널·순서·트리·자유 창·보조 볼륨이 같아요. 메인 볼륨은 바뀌지 않아요.
- 메인 매핑 세 경로(같음·보조 중 하나·없음)와 6개 상한, 두 번 확정의 시간 초과, 같은 이름 덮어쓰기, 10개 상한 거절을 회귀로 확인해요.
- 저장 `conflict`·쓰기 실패에서 메모리 목록이 유지되고 안내가 보이며 자동 재시도가 없어요. 다른 탭의 변경이 `onChanged`로 목록에 반영돼요.
- 멀티뷰 OFF·라우트 이탈에서 조합 UI·리스너가 정리돼요.
- 설정 파일 내보내기·미리보기·적용에서 `multiviewPresets` 구역이 다른 구역과 독립적으로 동작하고, 잘못된 파일은 `invalid-multiviewPresets`로 거절돼요.

---

## 2. 채팅 키워드·언급 강조

### 목표

라이브 채팅에서 사용자가 정한 키워드(내 닉네임 포함)가 들어간 메시지를 원본 채팅창에서 강조하고, 기존 모아보기 상자에서 `언급` 필터로 모아 미확인 개수를 알려요. 지금 모아보기는 방송자·채팅 운영자만 모아요.

### 범위

- **포함:** 키워드 목록 옵션, 원본 행 강조, 모아보기 상자의 `언급` 필터와 미확인 개수, 기존 읽음·복사·원본 이동 규칙 재사용, 라이브 채팅과 별도 채팅 팝업.
- **제외(v1):** 내 닉네임 자동 감지(아래 한계), 소리·데스크톱 알림·탭 제목 변경, 정규식·단어 경계 옵션, 다시보기 채팅, 사용자별 숨김(별도 제안), 키워드별 색상.
- 내 닉네임은 사용자가 키워드 목록에 직접 넣어요. `getUserStatus`의 닉네임 필드와 치지직 네이티브 멘션 표시가 실측되면 자동 감지를 2단계로 검토해요(`docs/tracking/findings.md`에 후속으로 남겨요).

### 옵션(sync, 채팅 탭 → 채팅 관리 묶음)

| 키                                 | 종류               | 기본값 | 설명                                                                                                                          |
| ---------------------------------- | ------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `chatToolsKeywordHighlightEnabled` | `bool`, 기능 토글  | 꺼짐   | **키워드·언급 채팅 강조.** 키워드가 들어간 채팅을 원본에서 강조하고 모아보기 상자의 `언급`에 모아요.                          |
| `chatToolsHighlightKeywords`       | 새 종류 `textList` | `[]`   | 한 줄에 하나씩 입력해요. 각 항목은 앞뒤 공백을 뺀 1~30 code point, 대소문자·연속 공백을 무시해 중복을 제거하고 최대 20개예요. |

- `textList`는 문자열 배열이에요. `normalizeOptions`는 배열이 아니거나 항목이 문자열이 아니면 기본값, 항목은 `normSpace`·trim 뒤 빈 항목·길이 초과·중복을 제거하고 20개에서 잘라요. 옵션 페이지는 `textarea`(줄바꿈 구분)와 배열을 서로 변환하며, 잘린 항목이 있으면 저장 전에 `최대 20개까지 저장해요`를 보여 줘요.
- 배열 값은 `Object.is` 비교가 참조를 보므로, 옵션 페이지의 변경 판정(`isUserOwnedOption`·기준값 비교)과 `shared/settingsBackup.js`의 `validateOptionValue`는 이 종류에 `sameValue`(깊은 비교)를 써요. 설정 파일에는 다른 옵션처럼 `sync.options` 안에 들어가요.
- 모아보기 보관 개수(`chatToolsMaxModeratorMessages`)와 상자 높이(`chatToolsModeratorBoxHeight`)는 `언급` 집합에도 같은 값을 적용해요. 별도 옵션을 두지 않아요.

### 매칭 규칙

- 대상은 파서가 읽은 표시 본문(`parsed.text`)이에요. `normSpace` 뒤 대소문자를 무시한 **부분 일치**예요(한국어는 단어 경계가 없어요). 키워드 정규화는 옵션 변경 때 한 번만 해요.
- 블라인드 메시지는 수집하지 않아요(원문 표시 옵션이 켜져 있어도 원문 캐시를 매칭에 쓰지 않아요).
- 작성자 닉네임이 키워드와 정확히 같은 메시지는 그 키워드로는 수집하지 않아요. 사용자가 내 닉네임을 키워드로 넣었을 때 내가 쓴 채팅이 `언급`에 쌓이지 않게 하기 위한 규칙이에요. 닉네임만으로 본인 여부를 증명하는 것은 아니며 같은 닉네임의 다른 사용자가 있을 수 있다는 한계를 문서에 남겨요.
- 방송자·운영자 메시지가 키워드에도 맞으면 한 메시지가 두 집합에 모두 들어가요. 미확인은 메시지 단위로 하나예요.

### 수집 구조

`features/chatTools/messageStore.js`의 `createMessageStore`에 수집 조건과 DOM 표식을 주입해요: `createMessageStore({ onChange, matches = (parsed) => Boolean(parsed.role), attrs = 기본 운영자 표식 })`. 기존 12곳의 `parsed.role` 검사를 `matches(parsed)`로 바꾸되 기본값이 역할 검사라 운영자 인스턴스의 동작·기존 테스트는 그대로예요. `features/chatTools.js`는 두 번째 인스턴스를 `matches = 키워드 매칭`, `attrs = 언급 표식(data-bcct-mention-collected, data-bcct-mention-highlight)`으로 만들고, 한 번 파싱한 결과를 두 `collect`에 넘겨요. 원문 캐시는 운영자 인스턴스만 써요.

- 정체성·행 재사용·철회·재마운트·읽음·상한 정리는 두 인스턴스가 같은 코드를 써요. 새 로직은 매칭 함수뿐이에요.
- 두 인스턴스의 `recordId`가 겹치지 않도록 `namespace` 수준의 순번을 쓰고, 패널 병합 순서는 그 순번이에요.
- 대안으로 한 인스턴스에 두 집합을 두는 방법을 검토했지만 `moderatorMessages` 단일 배열과 상한 정리·필터 로직을 모두 고쳐야 해서 회귀 위험이 커요. 두 인스턴스 방식을 추천해요.

### 패널·강조

- 모아보기 상자는 두 옵션 중 하나라도 켜져 있으면 표시해요. `ensureModeratorBox`와 `isFeatureEnabled` 조건에 새 옵션을 더해요. 방송자·운영자 모아보기 옵션은 운영자 수집만 담당하고, 상자 UI는 두 집합이 공유해요.
- 필터 줄 앞에 종류 선택 `전체 · 방송자·운영자 · 언급`을 두고, 기존 작성자 버튼은 `전체`·`방송자·운영자`에서만 보여요. `언급`에는 하위 필터가 없어요(키워드별 필터는 범위 밖).
- 상단 아이콘의 숫자는 두 집합의 미확인 합계예요. 읽음 처리·`맨 아래로`·복사·원본 이동은 기존 규칙 그대로예요.
- 원본 채팅 강조는 운영자 강조와 같은 방식(행 속성 + 확장 스타일)이지만 모양을 구분해요: 왼쪽 3px 민트 띠와 옅은 민트 배경, 라이트·다크 농도 분리. 운영자와 동시에 맞으면 운영자 배경 위에 띠만 더해요. 본문 글자색·줄 크기는 바꾸지 않아요.
- 옵션 OFF 때 언급 표식·강조·집합을 모두 정리해요. 운영자 옵션만 켜져 있으면 지금과 같은 화면이에요.

### 수용 기준

- 두 옵션이 모두 꺼져 있으면 DOM·스타일·수집에 변화가 없어요.
- 키워드만 켜도 상자·아이콘이 뜨고 `언급`만 모여요. 운영자만 켜면 기존과 같아요.
- 부분 일치·대소문자 무시·블라인드 제외·작성자 닉네임 제외·두 집합 동시 수집을 회귀로 확인해요.
- 같은 행 재마운트·재사용에서 중복 수집이 없고 혼합 상태 철회가 운영자 집합과 같은 규칙으로 동작해요.
- 옵션 변경(키워드 추가·삭제)이 전체 재스캔으로 기존 행에 반영되고, 이전 키워드로 모인 메시지는 유지돼요(수집 시점 기준).
- `textList` 정규화·상한·중복 제거, 옵션 페이지 변환·변경 판정, 설정 파일 검증을 회귀로 확인해요.

---

## 파일 소유권

| 영역                     | 파일                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 멀티뷰 조합 형식·검증    | 새 `shared/multiviewPresets.js`(DOM·chrome 비의존 IIFE, `globalThis.BetterChzzkMultiviewPresets`: `STORAGE_KEY`, 상한, `parseState`, `isSameState`, `upsertPreset`, `removePreset`). manifest isolated 목록에서 `features/liveMultiview/model.js` 앞, `background.js`의 `shared/followingFolders.js`·`shared/chatMultiview.js` `importScripts` 줄에 함께 로드해요. 옵션 페이지에는 로드하지 않아요. |
| 멀티뷰 조합 적용·UI      | `features/liveMultiview/model.js`(`snapshotPreset`, `applyPreset` 순수 매핑), `runtime.js`(목록 읽기·`onChanged`·`settingsStoreSet` 어댑터·액션 `save-preset`/`load-preset`/`delete-preset`·적용 뒤 reconcile), `settingsPanel.js`(조합 영역·방송 추가 패널의 조합 목록·두 번 확정·focus 복원)                                                                                                      |
| 설정 저장 경계·설정 파일 | `shared/settingsBackup.js`(새 local 구역·허용 키·`textList` 깊은 비교), `optionsSettingsBackup.js`(구역 라벨·요약), `shared/settingsStore.js`는 변경 없음을 확인                                                                                                                                                                                                                                    |
| 채팅 옵션                | `shared/settings.js`(`textList` 종류·옵션 2개), `options.html`(채팅 관리 묶음의 토글·textarea·도움말), `options.js`(textarea↔배열 변환·깊은 비교 변경 판정·상한 안내)                                                                                                                                                                                                                               |
| 채팅 수집·표시           | `features/chatTools/parser.js`(언급 표식 상수·키워드 정규화·매칭 함수), `messageStore.js`(조건·표식 주입, 공용 순번), `panel.js`(종류 필터·병합 렌더·언급 스타일), `features/chatTools.js`(두 번째 인스턴스·옵션 적용·상자 표시 조건·강조 스타일)                                                                                                                                                   |
| 공용                     | `manifest.json` 로드 순서, `background.js` importScripts                                                                                                                                                                                                                                                                                                                                            |
| 문서                     | `docs/contracts.md`, `docs/security.md`, `docs/business-rules.md`, `features/liveMultiview/AGENTS.md`, `features/chatTools/AGENTS.md`, README, `docs/tracking/status.md`·`findings.md`, 릴리스 때 `docs/update-history.md`와 새 기능 안내                                                                                                                                                           |

## 검증 계획

1. 관련 테스트를 `node --test --test-concurrency=2 <파일들>`로 먼저 실행해요. 멀티뷰: 새 `tests/multiview-presets-model.test.js`, `tests/live-multiview.test.js`, `tests/settings-store.test.js`, `tests/options-settings-backup.test.js`, `tests/release-safety.test.js`. 채팅: `tests/chat-tools-modules.test.js`, `tests/chat-tools.test.js`, `tests/settings.test.js`, `tests/options-page.test.js`, `tests/options-save-race.test.js`, `tests/settings-store.test.js`.
2. 설정 스키마·저장 형식·manifest·워커 로드를 바꾸므로 마지막에 `npm run test:all -- --test-concurrency=2`, `npm run lint`, `npm run format:check`를 순서대로 한 번 실행해요. `format:check`의 `.claude/settings.local.json` 기존 차이는 범위 밖이에요.
3. 실제 Chrome 확인은 자동 검사와 구분해 기록해요. 멀티뷰: 저장→새로고침→불러오기, 메인이 다른 채널에서 불러오기, 자유 배치 조합, 설정 파일 왕복. 채팅: 키워드 강조의 라이트·다크 모양, 채팅 팝업, 운영자+언급 동시 강조, 긴 목록의 미확인 처리.

## 결정이 필요한 항목

1. **멀티뷰 조합에 배치 포함(추천) vs 채널 목록만.** 배치를 빼면 형식·매핑이 단순해지지만 매번 다시 배치해야 해요.
2. **불러오기로 현재 보조를 교체할 때 두 번 눌러 확정(추천) vs 바로 교체.**
3. **채팅 키워드 v1은 내 닉네임 직접 입력(추천).** 자동 감지는 `getUserStatus` 닉네임 필드와 네이티브 멘션 표시를 실측한 뒤 2단계로 둘지.
4. **`언급` 집합의 보관 개수·상자 높이를 기존 옵션과 공유(추천) vs 별도 옵션.**
5. **운영자 모아보기 옵션이 꺼져 있어도 키워드만으로 상자를 표시(추천) vs 운영자 옵션이 켜져 있을 때만.**
6. **구현 순서.** 두 기능은 파일이 겹치지 않아 병행할 수 있어요(`shared/settingsBackup.js`·`optionsSettingsBackup.js`만 둘 다 건드리므로 한쪽이 먼저 끝난 뒤 다른 쪽이 그 위에 작업해요).
