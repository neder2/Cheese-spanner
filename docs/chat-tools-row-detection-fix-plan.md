# 채팅 도구 수리 — 고정 공지 행 인식 붕괴 + 클린봇 블라인드 미감지 수정 명세

> 대상: 자동 구현 에이전트
> 작성 기준 코드: Better Chzzk 1.2.2 작업 트리 (`features/chatTools.js`, 1.2.1 커밋과 로직 동일)
> 근거: 2026-07-07 실기 검증 (headless Chrome + CDP `Extensions.loadUnpacked`, 실제 치지직 라이브 2개 방송에서 재현). 이 문서만 읽고 구현 가능하도록 작성되었다. 추측이 필요한 부분은 **"결정"** 으로 못박아 두었으니 그대로 따른다.

---

## 1. 목표 (무엇을 고치는가)

사용자 증상: "매니저(채팅 운영자) 모아보기가 작동하지 않고, 블라인드 원문 보기도 안 보인다."
실측으로 확정한 원인은 뱃지 감지가 아니라 **그 앞 단계**다. 우선순위 순서로:

1. **P0-A 고정 공지 행 인식 붕괴**: 고정 공지가 걸린 방송에서 새 채팅이 전부 무시된다 — 모아보기·블라인드가 동시에 죽는 주범.
2. **P0-B 클린봇 블라인드 미감지**: 실제 블라인드의 대부분인 클린봇 문구가 감지 정규식에 없다.
3. **P1-C 풀스캔 래퍼 삼킴**: 초기 로드 시 기존 채팅이 개별 파싱되지 않는다.
4. **P1-D 원문 캐시 오염**: 블라인드 복원이 **다른 사람 채팅의 원문**을 보여줄 수 있다 (실측 재현됨).
5. **P2-E 이모티콘 전용 채팅**: 본문 자리에 닉네임이 들어간다.
6. **P2-F 역할 단어 닉네임**: 닉네임에 "매니저" 등이 포함되면 모아보기에서 닉네임이 유실된다.

비범위(하지 않을 것): 옵션 스키마(`shared/settings.js`) 변경, `manifest.json` 변경, 다른 feature 파일 수정, 모아보기 UI 리디자인, 이모티콘 이미지 렌더링(§4.5의 2단계), git 히스토리 수정.

---

## 2. 배경 사실 (2026-07-07 실측 — 구현자가 반드시 알아야 할 것)

### 2.1 실제 채팅 DOM 계층 (라이브 시청 페이지)

```text
ASIDE._container_1qgfi_2                     ← 채팅 패널 (panelHost)
└─ DIV._container_sg7hy_1 [role='log']       ← chatRoot 로 잡히는 요소 (§2.2 주의)
   └─ DIV._wrapper_sg7hy_25                  ← 전체 채팅을 감싸는 스크롤 래퍼
      └─ DIV._item_sg7hy_7                   ← 채팅 1건 (새 채팅의 addedNode 단위)
         └─ DIV._container_1vemp_1
            └─ DIV._chatting_message_1vemp_21
               ├─ BUTTON._nickname_1vemp_37 (aria-haspopup="true" aria-expanded="false")
               │  └─ SPAN._container_o04z9_2 _is_message_o04z9_5 …
               │     ├─ (뱃지) SPAN._wrapper_o04z9_23 > SPAN._icon_o04z9_15 > SPAN._container_1jo9t_2 > IMG
               │     └─ SPAN._nickname_o04z9_57 (인라인 color)
               └─ SPAN._text_1vemp_1          ← 본문 (이모티콘 채팅이면 텍스트 없이 button>img 만)
```

- 클래스 해시는 빌드에 따라 다르다 (실측 `sg7hy`, 사용자 스크린샷 `sg9hy`). **해시에 의존하지 말 것.**
- 매니저 뱃지: `https://ssl.pstatic.net/static/nng/glive/icon/manager.png`, `alt="채팅 운영자"`. 일반 뱃지(팬/구독)는 `glive/badge/…`·`subscription/…` 경로에 alt 빈 값. 역할 아이콘만 `glive/icon/` 경로다.
- 뱃지 감지(`detectRole`)와 파서(`parseChatMessage`)는 이 마크업에서 **정상 동작함을 실측 확인했다.** 고치지 말 것.

### 2.2 P0-A의 메커니즘 — 고정 공지 클래스가 행 탐색을 하이재킹한다

- 고정 공지(핀 메시지)가 걸린 방송은 chatRoot 인 `[role='log']` 요소의 클래스가
  `_container_sg7hy_1 _exist_fixed_message_sg7hy_12` 가 된다. **`_exist_fixed_message_` 에 "message" 가 들어 있다.**
- 새 채팅의 addedNode(`_item_…`)는 자체로는 `CHAT_ROW_SELECTORS`(`features/chatTools.js:65`)의 어느 항목에도 매치되지 않는다
  (`normalizeCandidateRow` 의 `\b(row|item|message|chat)\b` 도 밑줄이 워드 문자라 `_item_sg7hy_7` 에 매치 실패 — 단위 확인됨).
- 따라서 `getChatRowForNode`(`features/chatTools.js:1693`)의 `el.closest(CHAT_ROW_SELECTORS)` 가 조상으로 올라가
  `[class*='message']` 로 **chatRoot 자신에 매치**되고, `row === rootEl` 검사에서 null → **새 채팅이 전부 버려진다.**
- 실측 교차 검증: 고정 공지 없는 방송에서는 같은 주입 마크업이 정상 수집, 고정 공지 있는 방송에서는 5.5초가 지나도 무반응.
  내부 노드의 attribute/characterData mutation 은 target 에서 가까운 `_chatting_message_` 가 먼저 매치되어 살아남는다 (부분적으로만 동작하는 것처럼 보이는 이유).

### 2.3 P0-B의 메커니즘 — 실제 클린봇 블라인드 마크업 (4건 실측)

```html
<div class="_item_sg7hy_7">
    <div class="_container_1vemp_1 _is_hidden_1vemp_1">
        <!-- 블라인드 시 _is_hidden_ 클래스 -->
        <div class="_chatting_message_1vemp_21">
            <button …닉네임 버튼…>즐거운 주술사 8187490</button>
            <span class="_text_1vemp_1">클린봇이 부적절한 표현을 감지했습니다.</span>
        </div>
    </div>
</div>
```

- 문구는 정확히 **"클린봇이 부적절한 표현을 감지했습니다."** 다. `BLIND_SIGNAL_RE`(`features/chatTools.js:110`)의
  `블라인드|숨김|삭제|차단|가림|…` 어디에도 안 걸려 **감지 자체가 안 된다.**
- 원문은 DOM 에 없다 (숨김 요소·data 속성 없음). 원문 복원은 "블라인드 전에 원문이 정상 파싱되어 캐시된 경우"에만 가능하다. 이는 기존 설계(원문 모르면 문구 유지)와 일치하는 한계다.
- **오탐 함정**: 관측 중 일반 시청자가 `"클린봇 검열  어케봄?"` 이라고 채팅했다. 단어 "클린봇"만으로 매치하면 일반 채팅이 블라인드로 오판된다. **정확한 문구 패턴으로만 추가할 것** (§4.2).

### 2.4 P1-C·D의 메커니즘 — 래퍼 삼킴과 캐시 오염

- `findChatRows`(`features/chatTools.js:1802`)는 chatRoot 의 **직계 자식을 무조건 행 후보에 넣는다** (1806-1808행).
  실제 구조에서 직계 자식은 채팅 1건이 아니라 **전체 채팅을 감싸는 `_wrapper_sg7hy_25`** 다.
  이어지는 `hasCandidateAncestor` 필터가 래퍼의 자손인 개별 `_chatting_message_` 를 전부 걸러내므로,
  풀스캔 결과가 "래퍼 1건" 이 되어 초기 로드 시 기존 채팅이 개별 파싱되지 않는다.
- 그때 래퍼가 하나의 행으로 파싱되면서 `cacheOriginalMessageText` 가 **래퍼 노드를 key 로 아무 채팅의 텍스트를 캐시**한다.
- 이후 블라인드 복원 시 `lookupCachedOriginalText`(`features/chatTools.js:1076`)의 **조상 4단계 폴백**(1083-1087행)이
  래퍼 key 캐시를 히트 → **남의 채팅 원문이 취소선 원문으로 표시된다.** 실측에서 실제로 다른 시청자의 채팅이 복원되어 나왔다.

### 2.5 P2-E·F의 메커니즘

- E: 이모티콘 전용 채팅은 `_text_1vemp_1` 에 텍스트가 없어 `pickMessageTextTarget` 이 빈 결과를 내고,
  `parseChatMessage`(`features/chatTools.js:1042`)의 `text = textTarget.text || getVisibleText(row, context)` 폴백이
  **row 전체 가시 텍스트 = 닉네임**을 본문으로 넣는다. jsdom 재현: author 와 text 가 똑같이 닉네임이 된다.
- F: `pickAuthorTarget` → `isRoleDecoration`(`features/chatTools.js:664`)이 닉네임 요소(marker 에 "nickname" 매치)에 대해
  `ROLE_ATTR_RE.test(marker + visibleText)` 를 하므로, 닉네임 텍스트에 "매니저/운영자/방송자" 등이 포함되면
  닉네임 요소를 역할 장식으로 오판 → author 가 빈 값이 되고 모아보기에는 "채팅 운영자" 라벨이 대신 표시된다.
  jsdom 재현: 닉네임 "총괄매니저" → author 유실.

### 2.6 실기 검증 방법 (재검증 시 그대로 사용)

- Chrome 137+ 는 `--load-extension` 을 무시한다. headless Chrome 을 `--enable-unsafe-extension-debugging` 으로 띄우고
  브라우저 레벨 CDP 로 `Extensions.loadUnpacked { path }` 를 호출한다 (Node 24 내장 WebSocket 으로 raw CDP 가능, 의존성 불필요).
- 라이브 URL 은 Node fetch 로 API 를 부르면 차단되므로, 브라우저 탭에서 `https://chzzk.naver.com/lives` 를 열어
  `a[href^='/live/']` 첫 링크를 얻는다.
- 격리 월드("Better Chzzk" 이름의 isolated context)에서 `chrome.storage.sync.set({ chatToolsEnabled: true, chatToolsShowBlindEnabled: true, chatToolsModeratorBoxEnabled: true })` 로 기능을 켠다 (`chatToolsEnabled` 기본값은 false).
- 파서 단독 검증은 격리 월드에서 `window.BetterChzzk.chatTools.parseChatMessage(rowEl)` 직접 호출로 가능하다.
- 고정 공지 유무는 chatRoot 클래스에 `_exist_fixed_message_` 가 있는지로 판별한다. 없는 방송이면
  `document.querySelector("[role='log']").classList.add("_exist_fixed_message_test_1")` 로 재현할 수 있다
  (chatRoot 는 이미 잡혀 있으므로 클래스 추가만으로 §2.2 경로가 활성화된다).

---

## 3. 아키텍처 결정

- 행 인식은 "addedNode 에서 위로 올라가되 **chatRoot 는 절대 행이 될 수 없다**"는 불변식을 코드에 박는다. 셀렉터 목록을 늘리거나 해시 클래스를 하드코딩하는 방식은 금지 (치지직 빌드마다 해시가 바뀐다).
- 클린봇 감지는 **전체 문구 앵커 패턴**으로만 추가한다. 단어 단위 추가 금지 (§2.3 오탐 함정).
- 캐시 오염은 "저장 시 컨테이너 금지(C)" + "조회 시 chatRoot 이상 금지(D)" 두 겹으로 막는다.
- 모든 수정은 `features/chatTools.js` 와 `tests/chat-tools.test.js` 안에서 끝낸다.

---

## 4. 구현 명세

### 4.1 P0-A — `getChatRowForNode` 가 chatRoot 를 행으로 반환하지 않게

`features/chatTools.js:1693-1694` 현재:

```js
const closestRow = el.closest(CHAT_ROW_SELECTORS);
const candidate = closestRow && rootEl.contains(closestRow) ? closestRow : el;
```

**결정**: `closestRow !== rootEl` 조건을 추가한다.

```js
const closestRow = el.closest(CHAT_ROW_SELECTORS);
const candidate = closestRow && closestRow !== rootEl && rootEl.contains(closestRow) ? closestRow : el;
```

- 효과: 고정 공지 방송에서 candidate 가 addedNode(`_item_…`) 자신이 되고, `normalizeCandidateRow` 는 매치 실패 시 el 을 그대로 반환하므로 row = `_item_` div 로 처리된다. **이 row 기준 파싱이 정상 동작함은 실측 확인됨** (parseChatMessage 직접 호출로 role/author/text/hiddenText 모두 정상).
- `normalizeCandidateRow` 의 `\b` 정규식은 **바꾸지 않는다** (해시 클래스 대응을 넓히려다 다른 오매치를 만들 수 있고, el 폴백으로 충분하다).

### 4.2 P0-B — 클린봇 문구 감지 추가

`features/chatTools.js:110-112` 의 두 정규식을 수정한다.

**결정 1**: `BLIND_SIGNAL_RE` 에 앵커 없는 **연속 문구** alternation 을 추가한다 (단어 단위 금지):

```js
const BLIND_SIGNAL_RE =
    /블라인드|숨김|삭제|차단|가림|클린봇이\s*부적절한\s*표현을\s*감지|blind|hidden|deleted|blocked|moderated/i;
```

**결정 2**: `GENERIC_BLIND_TEXT_RE` 는 기존 패턴을 유지한 채, 클린봇 전체 문구 alternation 을 앞에 추가한다:

```js
const GENERIC_BLIND_TEXT_RE =
    /^클린봇이\s*부적절한\s*표현을\s*감지했습니다[\s.]*$|^(?:\[?\s*)?(?:(?:메시지가|채팅이)\s*)?(블라인드|…기존 그대로…)[\]\s.:：-]*$/i;
```

- `GENERIC_BLIND_TEXT_RE` 는 (a) 숨김 원문 후보에서 안내 문구를 걸러내는 필터, (b) `syncBlindReveal` 의 마스킹 게이트 양쪽에 쓰인다. 클린봇 문구가 여기에 들어가야 문구 요소가 원문으로 오인되지 않고, 캐시 복원 시 마스킹이 걸린다.
- `_is_hidden_1vemp_1` 클래스는 **감지 신호로 추가하지 않는다** (해시 클래스 의존 금지, 문구 매치로 충분).
- 한계 명시: 처음부터 클린봇 문구로 도착한 채팅은 원문이 DOM 에 없으므로 복원 불가 — 문구를 그대로 두는 것이 올바른 동작이다 (기존 "원문 없으면 유지" 설계 그대로).

### 4.3 P1-C — `findChatRows` 가 스크롤 래퍼를 행으로 삼키지 않게

`features/chatTools.js:1806-1808` 현재:

```js
for (const child of Array.from(rootEl.children)) {
    if (!isOwnUi(child) && getVisibleText(child)) rows.add(child);
}
```

**결정**: 직계 자식이 행 셀렉터 매치 자손을 **2개 이상** 포함하면 개별 행이 아니라 래퍼로 보고 후보에서 제외한다.

```js
for (const child of Array.from(rootEl.children)) {
    if (isOwnUi(child) || !getVisibleText(child)) continue;
    // 다수의 채팅을 감싸는 스크롤 래퍼는 행이 아니다 (§2.4).
    if (child.querySelectorAll(CHAT_ROW_SELECTORS).length >= 2) continue;
    rows.add(child);
}
```

- 채팅 1건 구조에서는 `_chatting_message_` 1개만 매치되므로 기존 동작(단순 마크업 테스트 포함)이 유지된다.
- 이 수정으로 래퍼가 제외되면 `querySelectorAll(CHAT_ROW_SELECTORS)` 경로(1810행)가 개별 `_chatting_message_` 들을 살리고, `hasCandidateAncestor` 필터도 정상화된다. 부수 효과로 `findChatRoot` 의 최빈 부모 폴백(`findChatRows(document.body)` 사용)도 개선된다.

### 4.4 P1-D — 원문 캐시의 남의 원문 오염 차단

`features/chatTools.js:1083-1087` (`lookupCachedOriginalText` 의 조상 폴백):

**결정**: 조상 순회 중 chatRoot(또는 그 조상)에 도달하면 중단한다.

```js
let current = row.parentElement;
for (let depth = 0; current instanceof Element && depth < 4; depth += 1, current = current.parentElement) {
    if (current === chatRoot) break; // 다수 채팅을 포함하는 노드의 캐시는 남의 원문일 수 있다 (§2.4).
    const byAncestor = rowOriginalTexts.get(current);
    if (byAncestor) return byAncestor;
}
```

- 4.3 이 저장 쪽 원천을 막고, 이 수정이 조회 쪽 방어선이다. 둘 다 넣는다.
- 조상 폴백 자체는 유지한다 (수집 표시가 바깥 wrapper, mutation row 가 안쪽 컨테이너로 갈리는 정상 케이스를 위해 존재 — `getCollectedModeratorRow` 주석 참고).

### 4.5 P2-E — 이모티콘 전용 채팅의 본문 오염 방지

`features/chatTools.js:1042` 현재:

```js
const text = textTarget.text || getVisibleText(row, context);
```

**결정 (1단계, 이번 범위)**: 폴백 값이 author 와 동일하면 빈 문자열로 만든다.

```js
let text = textTarget.text || getVisibleText(row, context);
if (!textTarget.text && author && text === author) text = "";
```

- 결과: 이모티콘 전용 매니저 채팅은 `collectModeratorMessage` 의 `!parsed.text` 게이트에서 수집이 조용히 스킵된다. "닉네임이 본문으로 둔갑" 오염이 사라지는 것이 이번 목표다.
- **2단계(비범위)**: 이모티콘 아이콘을 모아보기에 표시하는 것은 이번 작업에서 하지 않는다.

### 4.6 P2-F — 역할 단어 닉네임의 author 유실 방지

`features/chatTools.js:664-671` (`isRoleDecoration`) 현재는 marker 에 닉네임 계열이 매치되면 `marker + visibleText` 전체로 역할 여부를 판정한다.

**결정**: visibleText 는 **정확히 역할 라벨 전체일 때만** 장식으로 인정한다. 판정식을 다음으로 교체:

```js
const ROLE_LABEL_EXACT_RE =
    /^(방장|방송자|스트리머|매니저|운영자|채팅 운영자|streamer|owner|broadcaster|manager|moderator|mod)$/i;

function isRoleDecoration(el, context = null) {
    if (!(el instanceof Element)) return false;
    const marker = getElementAttrText(el);
    if (!/badge|role|manager|moderator|owner|streamer|broadcaster|닉네임|nickname|author|name/i.test(marker))
        return false;
    if (ROLE_ATTR_RE.test(marker)) return true;
    return ROLE_LABEL_EXACT_RE.test(getVisibleText(el, context));
}
```

- 의도 보존: `<span class="badge" aria-label="매니저">` 나 `<span class="nickname">매니저</span>`(라벨 마크업)는 계속 장식으로 걸러진다. "총괄매니저" 같은 실제 닉네임은 정확 매치가 아니므로 살아남는다.
- 상수는 다른 역할 정규식들 옆(`features/chatTools.js:105-109`)에 선언한다.

---

## 5. 테스트 명세 (`tests/chat-tools.test.js` 에 추가)

기존 `realChzzkChatRow` 헬퍼를 확장하거나 형제 헬퍼를 만들어 **§2.1 계층 전체**(`[role='log']` 루트 > wrapper > item)를 재현하는 픽스처를 추가한다. 기존 테스트 24개는 전부 그대로 통과해야 한다.

1. **고정 공지 + mutation**: 루트 클래스에 `_exist_fixed_message_test_1` 추가된 픽스처에서, wrapper 에 매니저 채팅(`icon/manager.png`, alt="채팅 운영자")을 동적으로 append → 모아보기에 수집된다. (4.1 검증 — 수정 전에는 실패해야 함)
2. **고정 공지 + 블라인드 mutation**: 같은 픽스처에서 숨김 원문을 가진 블라인드 행 append → `.bcct-blind-reveal` 생성.
3. **풀스캔 래퍼**: wrapper 안에 매니저 채팅이 **이미 있는** 상태로 로드 → 수집된다. (4.3 검증)
4. **클린봇 사후 블라인드**: 일반 채팅으로 파싱·캐시된 뒤 본문을 "클린봇이 부적절한 표현을 감지했습니다." 로 교체 → 원문이 취소선으로 복원된다. (4.2 검증)
5. **클린봇 사전 블라인드**: 처음부터 클린봇 문구로 도착(원문 없음) → reveal 없음, 문구 그대로 유지.
6. **클린봇 오탐 방지**: 일반 채팅 본문 "클린봇 검열 어케봄?" → 블라인드 처리되지 않고 원문 그대로.
7. **캐시 오염 방지**: 채팅 A 가 파싱·캐시된 상태에서, 원문이 캐시된 적 없는 채팅 B 를 블라인드 문구로 교체 → B 에 A 의 원문이 나오지 않는다 (reveal 없음). (4.4 검증)
8. **이모티콘 전용**: 매니저 뱃지 + `_text_` 안에 이모티콘 img 버튼만 있는 채팅 → 모아보기 본문에 닉네임이 들어가지 않는다.
9. **역할 단어 닉네임**: 닉네임 "총괄매니저" 인 매니저 채팅 → 모아보기 author 가 "총괄매니저" 로 표시된다.

실행: `node --test tests/chat-tools.test.js` (전체 회귀는 `node --test tests/`).

---

## 6. 실기 검증 (구현 후 필수)

§2.6 방법으로 다음을 확인한다:

1. **고정 공지 있는 방송** (없으면 `[role='log']` 에 `_exist_fixed_message_test_1` 클래스를 추가해 재현): 매니저 마크업(§2.1) 주입 → 2.5초 내 `data-bcct-moderator-collected` 부착 + 모아보기 행 생성.
2. **고정 공지 없는 방송**: 같은 주입 → 동일 결과 (회귀 없음).
3. 대형 방송에서 3~4분 관측: 자연 발생 클린봇 채팅이 (a) 원문이 앞서 흘렀던 경우 취소선 복원되거나 (b) 원문 미확보 시 문구 유지되는지, 그리고 **다른 채팅의 원문이 복원되어 나오는 일이 없는지** 확인.

---

## 7. 작업 순서

1. 4.1 (P0-A) → 테스트 1·2 작성, 수정 전 실패 확인 후 수정.
2. 4.2 (P0-B) → 테스트 4·5·6.
3. 4.3 + 4.4 (P1-C·D) → 테스트 3·7.
4. 4.5 + 4.6 (P2-E·F) → 테스트 8·9.
5. 전체 회귀(`node --test tests/`) → §6 실기 검증.
