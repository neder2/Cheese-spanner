# 네이티브 단축키 복구 + 컨트롤 툴팁 위치·폰트 정밀 일치 (개정판)

> 대상: Codex (자동 구현 에이전트)
> 작성 기준 코드: Better Chzzk / 브랜치 `1.1.5` (워킹 트리 기준)
> 무대: `features/skipControl.js` (+ 테스트). 이 문서의 작업 D는 이전 `docs/volume-wheel-and-tooltip-font.md`의 "작업 B(폰트)"를 대체·확장한다. (볼륨 휠=작업 A는 그대로 유효.)
> **개정 사유**: 추가 증상 분석 결과 단축키 문제가 *두 개의 다른 원인*으로 갈렸다. 이전 판의 "포커스 탈취 단일 원인" 가정을 폐기한다.

---

## 확정된 증상과 진단

| 증상 | 사용자 관찰 | 원인 (확정/유력) |
|------|------------|------------------|
| **스페이스바**(재생/정지) 안 먹음 | 버튼 조작 후 자주 | **우리 `<button>`의 포커스 탈취** — 포커스된 버튼이 스페이스를 "재클릭"으로 흡수 |
| **`t`/넓은 화면** 안 먹음 | `t` 누르면 **툴팁(상태)은 토글되는데 레이아웃은 안 바뀜** | **React DOM 충돌** — 아래 설명 |
| 방향키 스킵 | 정상 | (우리가 `window`에서 직접 처리, 무관) |

### `t` 문제의 메커니즘 (핵심)
`t` keydown은 치지직에 정상 도달한다(그래서 버튼 aria-label/툴팁은 토글됨 = React state는 바뀜). 그런데 치지직이 플레이어 서브트리를 **리렌더하며 레이아웃 클래스를 패치할 때**, 그 컨테이너 children 사이에 **React가 모르는 우리 노드**가 끼어 있어서 `removeChild`/`insertBefore`가 "이 노드는 내 자식이 아니다"로 **예외를 던지고 그 커밋의 나머지(레이아웃 적용)가 중단**된다.

원인 코드(우리가 React 관리 컨트롤 바에 raw DOM을 주입하는 지점):
- [mountLiveFastForwardButton](features/skipControl.js:1325) — `reference.insertAdjacentElement("afterend", button)` → **네이티브 버튼 사이(중간)에 삽입**. 가장 위험.
- [mountLivePillInLeftButtons](features/skipControl.js:1167) — 컨트롤 바에 `appendChild`(맨 끝). 상대적으로 덜 위험.

> 이게 맞으면 `t`를 누를 때 Console에 `Failed to execute 'removeChild' on 'Node'` 또는 `The node to be removed is not a child of this node` 류 에러가 찍힌다. **C-0(진단 확정)에서 1회 확인**하고 들어간다.

---

# 작업 C — 네이티브 단축키 복구

## C-0. 진단 확정 (구현 전 1회)
라이브/VOD 플레이어에서 `t`를 누르고 DevTools Console을 본다.
- **React DOM 에러(removeChild/insertBefore)가 보이면** → React 충돌 확정. C-2 적용.
- 에러가 없고 레이아웃만 안 바뀌면 → 우리 옵저버가 레이아웃 변경을 되돌리는지 의심(드묾). 그래도 C-2의 "중간 삽입 제거"는 안전하니 그대로 적용한다.

## C-1. 스페이스바 — 버튼 포커스 탈취 차단

두 버튼이 클릭 후 포커스를 가져가, 스페이스가 "버튼 재클릭"으로 흡수된다. 마우스로 누를 때 **포커스 이동만 차단**한다(클릭·휠 기능, 키보드 Tab 접근성은 유지).

`createSkipPill()`의 `pill` 생성 후, `createLiveFastForwardButton()`의 `button` 생성 후 각각:
```js
pill.addEventListener("pointerdown", (event) => {
    if (event.button === 0) event.preventDefault(); // 포커스만 막음, click은 정상 발생
});
```
(빨리감기 버튼도 동일.)

> `pointerdown.preventDefault()`는 click을 취소하지 않는다. `tabindex="-1"`로 빼지 말 것(키보드 접근성 훼손).

## C-2. `t`/넓은 화면 — React 충돌 제거 (핵심)

목표: 우리 버튼을 **React가 reconcile하는 children 흐름에서 빼낸다.**

### 접근 2-A (권장 1차) — 중간 삽입 폐지 + 항상 맨 끝 append + CSS order
React는 자기 children을 앞에서부터 다룬다. 우리 노드가 **컨테이너 맨 끝**에 있으면 React의 remove/insert 대상에서 사실상 벗어나 충돌이 급감한다.

1. **빨리감기 버튼의 중간 삽입 제거** — [mountLiveFastForwardButton](features/skipControl.js:1325)에서 `reference.insertAdjacentElement("afterend", button)` 경로를 없애고, **항상 `container.appendChild(button)`**(맨 끝)으로 통일한다.
2. **시각 위치는 CSS `order`로 복원** — 빨리감기를 재생 버튼 옆에 두고 싶다면 flex `order`로 조정한다. 다른 네이티브 버튼이 `order:0`이면, 재생 버튼 직후 느낌을 주되 충돌을 피하려 우리 버튼엔 작은 양수 `order`를 준다. **정확한 "재생 버튼 바로 뒤"가 order로 자연스럽지 않으면, 왼쪽 컨트롤 그룹의 끝(맨 오른쪽)에 두는 배치를 허용**한다(아래 UX 메모 참조).
3. **스킵 pill**은 이미 `appendChild`+`order:9999`(맨 끝)이다 — 유지. 단 `syncLivePillButtonBoxClass`/`mountLivePillInLeftButtons`가 어떤 경로로도 컨트롤 바 **중간**에 넣지 않는지 점검한다.
4. **className 복사 주의** — `syncLiveFastForwardButtonClass`/`syncLivePillButtonBoxClass`가 `button.className = reference.className`으로 네이티브 클래스를 통째 복사한다. 이 클래스에 레이아웃/transition 관련 규칙이 섞여 있으면 리렌더와 더 얽힌다. **꼭 필요한 시각 클래스만 추가**하는 방식으로 좁히는 것을 검토한다(전체 복사 → 화이트리스트). 과하면 1차에선 보류 가능.
5. **재주입 가드 유지** — 컨테이너가 통째로 리렌더되어 우리 노드가 사라지면 기존 `ensureLiveFastForwardButtonInjected`/`ensureSkipPillInjected`/`scheduleDomSync`가 복구한다. 복구 시에도 (1)의 "맨 끝 append" 규칙을 지키게 한다.

### 접근 2-B (근본 해결, 2-A로도 충돌이 남을 때) — 오버레이 격리
우리 버튼을 컨트롤 바의 React children에서 완전히 빼서, **컨트롤 바 위에 우리 소유 오버레이 레이어**(`position:absolute`)로 띄우고 네이티브 버튼 위치를 측정해 정렬한다. React 트리 밖이라 충돌이 **원천 차단**된다.
- 가시성/위치 동기화는 기존 인프라 재사용 — [getEffectiveControlState](features/skipControl.js:206), [syncStandalonePillVisibility](features/skipControl.js:238), 컨트롤 영역 판정 로직.
- 비용이 크므로, **2-A로 Console 에러가 사라지면 2-B는 하지 않는다.** 2-A 적용 후에도 `t` 레이아웃이 깨지면 2-B로 전환.

### UX 메모 (확인 필요)
2-A에서 빨리감기 버튼이 "재생 버튼 바로 뒤"가 아니라 "왼쪽 그룹 끝"으로 가도 되는지는 시각 취향 문제다. **위치 정확도보다 단축키 복구가 우선**이므로, 끝 배치를 기본으로 하고 order 미세조정은 베스트 에포트로 둔다. (정확한 위치가 꼭 필요하면 2-B.)

## C-3. 하지 말 것
- `onKeyDownSeek`에서 스페이스/`t`를 가로채 직접 구현하지 말 것 — 네이티브 동작을 그대로 흘려보내는 게 목표. (현재 ArrowLeft/Right만 처리 → 수정 불필요.)
- 컨트롤 바 **중간**에 노드를 끼우는 모든 경로 금지(이번 버그의 근원).

## C-4. 테스트 (`tests/extension-pages.test.js`)
React 자체는 jsdom에 없어 충돌을 직접 재현할 수 없다 → **구조 불변식 + 포커스**를 단언하고, 레이아웃 회귀는 수동 QA로 막는다.

1. **포커스 차단**: 버튼에 `pointerdown`(button 0) 디스패치 후 `event.defaultPrevented === true`.
   ```js
   const pill = document.getElementById("betterchzzk-skip-pill");
   const down = new dom.window.Event("pointerdown", { bubbles: true, cancelable: true });
   Object.defineProperty(down, "button", { value: 0 });
   pill.dispatchEvent(down);
   assert.equal(down.defaultPrevented, true);
   ```
2. **중간 삽입 금지(불변식)**: 라이브 빨리감기 버튼 주입 후, **컨트롤 바의 마지막 자식이 우리 버튼**인지(또는 우리 버튼 뒤에 네이티브 버튼이 없는지) 단언. 기존 "live fast-forward button seeks the buffered live edge" 테스트의 fixture(`pzp-pc__bottom-buttons--left` + playback-switch)를 재사용한다.
   ```js
   const controls = document.getElementById("controls"); // pzp-pc__bottom-buttons--left
   const ff = document.getElementById("betterchzzk-live-fast-forward");
   assert.equal(controls.lastElementChild, ff); // 항상 맨 끝
   ```
   > 기존에 "재생 버튼 바로 뒤"를 단언하는 부분이 있으면 이 불변식에 맞게 갱신한다.

---

# 작업 D — 컨트롤 툴팁 위치·폰트 정밀 일치

(이전 판과 동일. 단축키 작업과 독립적으로 진행 가능.)

## D-1. 현재 상태
커스텀 `<div id="betterchzzk-control-tooltip">`로 그린다.
- 위치: [positionControlTooltip](features/skipControl.js:965) — 버튼 중앙 정렬, 위쪽(공간 없으면 아래), `gap = 12`.
- 폰트(CSS, [injectSkipStyleOnce](features/skipControl.js:861)): `font-size:14px; font-weight:400; line-height:18px;` — **`font-family` 없음**(body 상속).

## D-2. 접근 (택1, 1을 먼저 검토)
- **접근 1 (권장 시도)**: 네이티브 pzp 툴팁 메커니즘 재사용 — 우리 버튼에 네이티브 버튼과 동일한 클래스/속성을 부여해 pzp가 툴팁을 그리게 한다. 성공 시 위치·폰트 100% 자동 일치 + 커스텀 툴팁 제거. 안 되면 접근 2.
  > 단, 작업 C-2-B(오버레이)로 갈 경우 이 접근과 잘 맞는다.
- **접근 2 (폴백)**: 커스텀 툴팁을 네이티브 값으로 정밀 복제.
  1. **측정**(1회): 네이티브 버튼 호버 → pzp 툴팁의 `font-family/size/weight/letter-spacing`, 버튼-툴팁 `gap`, 수평 정렬 기준, 기본 방향.
  2. **위치**: `positionControlTooltip`의 `gap`(현 12)·정렬·방향을 측정값으로 교정.
  3. **폰트**: ① CSS에 `font-family`(+size/weight/letter-spacing) 명시. ② 견고화 — `showControlTooltip()`에서 `tooltip.textContent = text;` 직후 플레이어 루트 폰트 동적 복사:
     ```js
     const player = target.closest("[class*='pzp']") || document.querySelector("[class*='pzp']");
     if (player) tooltip.style.fontFamily = getComputedStyle(player).fontFamily;
     ```

## D-3. 테스트
- 기존 `#betterchzzk-control-tooltip` 단언(스타일 존재, `data-show`, `data-bc-control-tooltip-active`) 유지.
- 접근 2 시 `styleText.includes("font-family") === true` 추가.
- 좌표/폰트 정밀 일치는 수동 QA.

---

## 통합 체크리스트 (Codex 실행 순서)

1. **C-0** — `t` 누를 때 Console React 에러 확인(진단 확정).
2. **C-1** — 두 버튼에 `pointerdown` 포커스 차단(스페이스바).
3. **C-2-A** — 빨리감기 버튼 중간 삽입 제거 → 맨 끝 append + CSS order, 재주입 가드 유지(`t`/레이아웃).
4. (2-A로도 `t` 레이아웃이 깨지면) **C-2-B** — 오버레이 격리로 전환.
5. **C-4** — 포커스 차단 + "버튼이 컨트롤 바 맨 끝" 불변식 테스트.
6. **작업 D** — 접근 1 검토 → 안 되면 접근 2(측정→위치·폰트).
7. `npm test` 통과.
8. **수동 QA(가장 중요)**:
   - 빨리감기/스킵 버튼을 마우스로 누른 **직후** 스페이스바·`f`가 정상 동작(C-1 검증).
   - `t`(넓은 화면)가 **실제로 레이아웃까지 전환**되고 Console 에러가 없음(C-2 검증). 라이브·VOD 양쪽.
   - 방향키 스킵 회귀 없음.
   - 툴팁 위치·글꼴이 네이티브와 일치.

---

## 우선순위
**C-1·C-2가 최우선**이다 — 스페이스바·`t`는 매 재생마다 쓰는 기본 단축키이고, 원인이 우리 코드(버튼 주입 방식)로 특정됐다. 변경 범위도 `skipControl.js`의 mount 경로 + 포커스 가드로 작고 명확하다. 작업 D(툴팁 다듬기)는 그 뒤.
