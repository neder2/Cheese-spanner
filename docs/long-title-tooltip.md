# 긴 제목 호버 툴팁 (Long-Title Hover Tooltip) 구현 명세

> 대상: Codex (자동 구현 에이전트)
> 작성 기준 코드: Better Chzzk v1.1.4 / 브랜치 `1.1.5`
> 이 문서만 읽고 구현 가능하도록 작성되었다. 추측이 필요한 부분은 "결정" 항목으로 못박아 두었으니 그대로 따른다.

---

## 1. 목표 (무엇을 만드는가)

방송 탐색(카테고리/전체 라이브/채널 영상 등 **카드형 목록**) 화면에서 카드 제목이 `line-clamp`/`ellipsis`로 잘려 끝까지 읽을 수 없는 문제를 해결한다.

동작 정의:

1. **긴 제목 한정** — 실제로 잘린(truncated) 제목에만 반응한다. 한 줄에 다 들어오는 제목은 아무 변화도 없다.
2. 잘린 제목 위에 **커서를 올리면**:
   - (a) 그 **제목 박스가 하이라이트**된다.
   - (b) 그 자리에 맞춰 **툴팁으로 전체 제목**이 표시된다(잘리지 않은 완전한 텍스트).
3. 커서를 치우면 하이라이트와 툴팁이 사라진다.
4. **디자인 통일** — 기존 `videoSearch.js`의 댓글 툴팁(`bcvs-comment-tooltip`)과 동일한 비주얼 토큰(배경/보더/그림자/다크모드/라운드)을 사용한다.

비범위(하지 않을 것): 제목 편집, 클릭 동작 변경, 잘리지 않은 제목에 대한 사전 표식, 모바일 터치 전용 UX.

---

## 2. 적용 범위 (어디서 동작하는가)

- 콘텐츠 스크립트는 이미 `https://chzzk.naver.com/*` 전체에 주입된다(`manifest.json`). **URL 화이트리스트를 두지 않는다.**
- 대신 **"잘린 제목 요소가 존재하면 동작"** 하는 방식으로 범용 구현한다. 카드 제목은 치지직 공통 규약상 `[class*='title']`(앵커면 `a[class*='title']`)로 식별된다 — `features/categoryTools.js`의 `setText(card.querySelector("a[class*='title'], [class*='title']"), meta.title)` 참고.
- 따라서 홈/카테고리/전체 라이브/채널 영상 등 카드 제목이 있는 모든 목록에서 자동으로 동작한다. 별도 라우트 분기 불필요.

---

## 3. 아키텍처 결정

### 3.1 새 독립 feature 파일로 만든다
`features/titleTooltip.js` 를 **신규 생성**한다. 기존 `categoryTools.js`(3,400줄+)에 끼워넣지 않는다.

이유: 제목 잘림은 독립 관심사이며 여러 페이지에 걸친다. 독립 파일이어야 on/off 옵션·테스트·유지보수가 깔끔하다.

### 3.2 MutationObserver가 아니라 "이벤트 위임"을 쓴다
기존 feature들은 `createMutationObserverSync`로 DOM을 폴링하지만, **이 기능은 `document`에 `pointerover` 위임 리스너 1개**만 건다.

이유:
- 카드가 수백 개여도 리스너는 1개 → 가볍다.
- 동적으로 추가되는 카드(무한 스크롤)도 자동 커버된다.
- 잘림 여부는 **호버 시점에 즉석 계산**하면 되므로 사전 스캔/관찰이 불필요하다.

단, 페이지 이동/스크롤/리사이즈 시 열린 툴팁을 닫고 위치를 보정하는 보조 리스너는 둔다(§6.4).

### 3.3 네이밍 prefix = `bctt`
기존 규약을 따른다(categoryTools=`bcgt`, videoSearch=`bcvs`). 이 기능은 **`bctt`** (better-chzzk title tooltip).

| 용도 | 값 |
|------|-----|
| 스타일 `<style>` id | `betterchzzk-title-tooltip-style` |
| 툴팁 엘리먼트 class | `bctt-tooltip` |
| 툴팁 마킹 속성 | `data-bctt-tooltip="1"` |
| 제목 하이라이트 속성 | `data-bctt-active="1"` |
| 옵션 키 | `titleTooltipEnabled` |

---

## 4. 파일별 변경 체크리스트

| # | 파일 | 변경 |
|---|------|------|
| 1 | `manifest.json` | 콘텐츠 스크립트 js 배열에 `features/titleTooltip.js` 추가 |
| 2 | `shared/settings.js` | `OPTION_SCHEMA`에 `titleTooltipEnabled` 추가 |
| 3 | `options.html` | "방송 목록 도구" 카드에 토글 추가 |
| 4 | `features/titleTooltip.js` | **신규** — 본 기능 구현 |
| 5 | `tests/extension-pages.test.js` | 잘림 감지/툴팁 생성 테스트 추가 |

아래 각 항목의 구체 지시를 따른다.

---

### 4.1 `manifest.json`

`content_scripts`의 **두 번째 객체**(run_at 없는 일반 스크립트, `world` 미지정)의 `js` 배열 맨 끝, `features/categoryTools.js` **다음 줄**에 추가한다.

```json
"features/skipControl.js",
"features/vodBroadcastClock.js",
"features/timeMachineLagLabel.js",
"features/monthlyBroadcastTime.js",
"features/liveWatchHistory.js",
"features/videoSearch.js",
"features/categoryTools.js",
"features/titleTooltip.js"
```

> 의존성: `shared/settings.js`, `content.js`(= `BetterChzzk.utils`)가 이 파일보다 앞에 있어야 한다. 위 배열은 이미 그 순서를 만족한다.

---

### 4.2 `shared/settings.js`

`OPTION_SCHEMA` 안, `categoryToolsEnabled` 줄 **바로 위 또는 아래**에 한 줄 추가한다. `feature: true`로 두어 기능 토글로 인식되게 한다(다른 feature 토글과 동일).

```js
categoryToolsEnabled: { kind: "bool", default: true, feature: true },
titleTooltipEnabled: { kind: "bool", default: true, feature: true },
```

> `OPTION_KEYS`, `FEATURE_KEYS`, `DEFAULT_OPTIONS`는 `OPTION_SCHEMA`에서 자동 파생되므로 추가 작업 없음. 기본값 `true`(켜짐).

---

### 4.3 `options.html`

"방송 목록 도구"(`categoryToolsEnabled`) 섹션 안, 마지막 토글(`categoryToolsLiveElapsedEnabled`, "진행 시간 호버") **다음**에 같은 `toggle-row` 패턴으로 추가한다. 이 토글은 독립 기능이므로 `data-depends-on`을 **붙이지 않는다**(상위 토글에 종속되지 않음).

```html
<label class="toggle-row">
    <span><strong>긴 제목 툴팁</strong><small>잘린 방송 제목에 마우스를 올리면 전체 제목을 보여줍니다.</small></span>
    <input type="checkbox" data-option="titleTooltipEnabled">
</label>
```

> 배치 위치 주의: 이 `toggle-row`는 `data-depends-on="categoryToolsEnabled"` 블록들 **밖**(아래)에 두어, 방송 목록 도구를 꺼도 제목 툴팁은 독립적으로 켤 수 있게 한다. 같은 `settings-card` 안에 두되 종속 마킹만 빼면 된다.
> `options.js`는 `[data-option]`을 자동 바인딩하므로 JS 변경 불필요(`tests/extension-pages.test.js`의 `queryOption` 동작 참고).

---

### 4.4 `features/titleTooltip.js` (신규)

아래 골격을 그대로 채워 구현한다. IIFE + `BetterChzzk.utils` 구조분해 + `bindFeatureOptions`/`onReady` 생명주기는 다른 feature(`videoSearch.js` 하단부)와 동일 패턴이다.

#### 4.4.1 상단 상수 / 상태 / 유틸 바인딩

```js
(() => {
    const STYLE_ID = "betterchzzk-title-tooltip-style";
    const TOOLTIP_CLASS = "bctt-tooltip";
    const TOOLTIP_ATTR = "data-bctt-tooltip";
    const ACTIVE_ATTR = "data-bctt-active";

    // 치지직 카드 제목 셀렉터(공통 규약). categoryTools.js와 동일 기준.
    const TITLE_SELECTOR = "a[class*='title'], [class*='title']";
    // 카드(방송/영상/클립)임을 확인하는 링크 패턴.
    const ITEM_LINK_SELECTOR = "a[href*='/live/'], a[href*='/video/'], a[href*='/clips/']";

    const HOVER_OPEN_DELAY_MS = 400; // 의도적 호버만 반응
    const TOOLTIP_MAX_WIDTH = 420;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let tooltip = null;
    let activeTitleEl = null;
    let openTimer = 0;
    let listenersInstalled = false;

    const {
        bindFeatureOptions,
        injectStyleOnce,
        normSpace,
        onReady,
        startPageChangeDetection,
    } = BetterChzzk.utils;

    let removePageChangeDetection = null;

    function isFeatureEnabled() {
        return featureOptions.titleTooltipEnabled;
    }
    // ... (이하 §4.4.2~ 함수들)
})();
```

#### 4.4.2 스타일 주입 (디자인 통일 — §5 CSS 전문 사용)

```js
function injectStyle() {
    injectStyleOnce(STYLE_ID, STYLE_TEXT); // STYLE_TEXT = §5의 CSS 문자열
}
```

#### 4.4.3 제목 요소 판정 + 잘림 감지 (핵심)

```js
// 호버 대상 → 카드 제목 요소로 정규화. 아니면 null.
function resolveTitleElement(target) {
    if (!(target instanceof Element)) return null;
    const el = target.closest(TITLE_SELECTOR);
    if (!(el instanceof HTMLElement)) return null;
    if (el.closest(`[${TOOLTIP_ATTR}="1"]`)) return null;      // 우리 툴팁 제외
    // 방송 카드 맥락인지 확인: 같은 카드 안에 item 링크가 있어야 함.
    const card = el.closest("article, li, [class*='card'], [class*='item'], [class*='video']") || el.parentElement;
    if (card && !card.querySelector(ITEM_LINK_SELECTOR) && !el.closest(ITEM_LINK_SELECTOR)) return null;
    return el;
}

// line-clamp(세로) 또는 ellipsis(가로)로 잘렸는가.
function isTruncated(el) {
    return (el.scrollWidth - el.clientWidth > 1) || (el.scrollHeight - el.clientHeight > 1);
}

// 전체 제목 텍스트. clamp/ellipsis는 텍스트를 자르지 않고 시각적으로만 가리므로
// textContent가 곧 전체 제목이다. 비어 있으면 앵커의 aria-label/title로 폴백.
function getFullTitle(el) {
    const text = normSpace(el.textContent);
    if (text) return text;
    const anchor = el.closest("a[aria-label], a[title]") || el.querySelector("a[aria-label], a[title]");
    return normSpace(anchor?.getAttribute("aria-label") || anchor?.getAttribute("title") || "");
}
```

#### 4.4.4 툴팁 엘리먼트 + 표시/숨김

```js
function getTooltip() {
    if (tooltip?.isConnected) return tooltip;
    const el = document.createElement("div");
    el.className = TOOLTIP_CLASS;
    el.setAttribute(TOOLTIP_ATTR, "1");
    document.body.appendChild(el);
    tooltip = el;
    return el;
}

function showTooltip(titleEl) {
    const text = getFullTitle(titleEl);
    if (!text) return;
    const tip = getTooltip();
    tip.textContent = text;
    activeTitleEl = titleEl;
    titleEl.setAttribute(ACTIVE_ATTR, "1");
    positionTooltip(titleEl);
    tip.setAttribute("data-show", "1");
}

function hideTooltip() {
    clearOpenTimer();
    if (activeTitleEl) activeTitleEl.removeAttribute(ACTIVE_ATTR);
    activeTitleEl = null;
    if (tooltip) tooltip.removeAttribute("data-show");
}

function clearOpenTimer() {
    if (!openTimer) return;
    window.clearTimeout(openTimer);
    openTimer = 0;
}
```

#### 4.4.5 위치 계산 (제목 박스에 정렬 — `videoSearch.js`의 `positionCommentTooltip` 차용)

"제목이 그 자리에서 펼쳐지는" 느낌을 위해 **제목 박스 왼쪽 모서리에 좌측 정렬**하고, **제목 위(공간 없으면 아래)** 에 띄운다. 뷰포트를 벗어나면 보정한다.

```js
function positionTooltip(anchor) {
    if (!tooltip || !anchor?.isConnected) return;
    const margin = 8;
    const gap = 4;
    const maxWidth = Math.max(160, Math.min(TOOLTIP_MAX_WIDTH, window.innerWidth - margin * 2));

    tooltip.style.maxWidth = `${maxWidth}px`;
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    tooltip.style.visibility = "hidden";
    tooltip.setAttribute("data-show", "1");

    const a = anchor.getBoundingClientRect();
    const t = tooltip.getBoundingClientRect();

    // 좌측 정렬(제목 left에 맞춤) + 우측 뷰포트 보정
    const maxLeft = Math.max(margin, window.innerWidth - t.width - margin);
    const left = Math.min(Math.max(margin, a.left), maxLeft);

    // 제목 위 우선, 공간 없으면 아래
    let top = a.top - t.height - gap;
    if (top < margin) top = a.bottom + gap;
    if (top + t.height > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - t.height - margin);
    }

    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
    tooltip.style.visibility = "";
}
```

#### 4.4.6 이벤트 핸들러 (위임)

```js
function handlePointerOver(e) {
    const titleEl = resolveTitleElement(e.target);
    if (!titleEl) return;
    if (titleEl === activeTitleEl) return;          // 이미 표시중
    if (!isTruncated(titleEl)) return;              // 긴 제목 한정
    clearOpenTimer();
    openTimer = window.setTimeout(() => {
        openTimer = 0;
        if (titleEl.isConnected && isTruncated(titleEl)) showTooltip(titleEl);
    }, HOVER_OPEN_DELAY_MS);
}

function handlePointerOut(e) {
    // 제목 박스 밖으로 나가면 닫는다(자식 간 이동은 무시).
    if (!activeTitleEl && !openTimer) return;
    const related = e.relatedTarget;
    if (related instanceof Node && activeTitleEl?.contains(related)) return;
    const movedToSameTitle = related instanceof Element && resolveTitleElement(related) === activeTitleEl;
    if (movedToSameTitle) return;
    hideTooltip();
}

function handleScroll() {
    if (activeTitleEl?.isConnected) positionTooltip(activeTitleEl);
    else hideTooltip();
}

function handleResize() {
    if (activeTitleEl?.isConnected) positionTooltip(activeTitleEl);
    else hideTooltip();
}
```

#### 4.4.7 설치 / 해제 / 생명주기

```js
function installListeners() {
    if (listenersInstalled) return;
    listenersInstalled = true;
    injectStyle();
    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    removePageChangeDetection = startPageChangeDetection(hideTooltip); // SPA 이동 시 닫기
}

function uninstallListeners() {
    if (!listenersInstalled) return;
    listenersInstalled = false;
    document.removeEventListener("pointerover", handlePointerOver, true);
    document.removeEventListener("pointerout", handlePointerOut, true);
    window.removeEventListener("scroll", handleScroll, true);
    window.removeEventListener("resize", handleResize);
    if (removePageChangeDetection) { removePageChangeDetection(); removePageChangeDetection = null; }
    hideTooltip();
    if (tooltip) { tooltip.remove(); tooltip = null; }
}

function applyOptions(options) {
    featureOptions = options;
    if (isFeatureEnabled()) installListeners();
    else uninstallListeners();
}

bindFeatureOptions(applyOptions);
onReady(() => { if (isFeatureEnabled()) installListeners(); });
```

> `bindFeatureOptions`는 최초 옵션 로드 + 변경 리스너를 모두 등록한다(`content.js` 참고). 따라서 옵션 토글 즉시 install/uninstall이 반영된다.

---

## 5. CSS 명세 (디자인 통일)

`STYLE_TEXT`로 주입할 문자열. 색/그림자/라운드/다크모드는 `videoSearch.js`의 `.bcvs-comment-tooltip`와 **동일 토큰**을 사용한다. 하이라이트는 프로젝트 액센트(`#00FFA3` 계열)를 쓰되 **텍스트 색은 건드리지 않는다**(다크/라이트 카드 양쪽에서 가독성 유지).

```css
.bctt-tooltip{
  display:none;
  position:fixed;
  left:0; top:0;
  width:max-content;
  max-width:min(420px, calc(100vw - 32px));
  padding:8px 10px;
  border:1px solid rgba(17,17,20,0.14);
  border-radius:6px;
  background:#fff;
  color:#111114;
  box-shadow:0 8px 24px rgba(0,0,0,0.18);
  font-family:inherit;
  font-size:13px;
  font-weight:600;
  line-height:18px;
  white-space:normal;
  word-break:break-word;
  z-index:2147483647;
  pointer-events:none;           /* 전체 제목만 보여주므로 상호작용 불필요 → 호버 로직 단순화 */
}
.bctt-tooltip[data-show="1"]{ display:block; }

/* 제목 박스 하이라이트 */
[data-bctt-active="1"]{
  background:rgba(0,255,163,0.12) !important;
  border-radius:4px;
  box-shadow:0 0 0 1px rgba(0,168,107,0.32);
}

/* 다크 모드 — comment tooltip과 동일 분기 셀렉터 */
html[dark] .bctt-tooltip,
body[theme="dark"] .bctt-tooltip,
[class*="dark"] .bctt-tooltip{
  border-color:rgba(157,165,182,0.22);
  background:#1B1D20;
  color:#F2F4F7;
  box-shadow:0 10px 30px rgba(0,0,0,0.34);
}
html[dark] [data-bctt-active="1"],
body[theme="dark"] [data-bctt-active="1"],
[class*="dark"] [data-bctt-active="1"]{
  background:rgba(0,255,163,0.16) !important;
  box-shadow:0 0 0 1px rgba(0,255,163,0.4);
}

@media (max-width: 520px){
  .bctt-tooltip{ max-width:calc(100vw - 16px); }
}
```

> `pointer-events:none` 결정 근거: 툴팁은 읽기 전용(전체 제목 표시)이라 마우스를 그 위로 올릴 일이 없다. 이걸로 "마우스가 툴팁에 들어가서 pointerout 발생" 같은 깜빡임을 원천 차단한다. (`videoSearch`의 댓글 툴팁은 스크롤/클릭이 필요해 `pointer-events:auto`였지만, 여기선 불필요.)

---

## 6. 동작/엣지 케이스 규칙

1. **긴 제목 한정**: `isTruncated()`가 false면 하이라이트/툴팁 모두 없음.
2. **호버 지연**: `HOVER_OPEN_DELAY_MS`(400ms) 후 표시. 빠르게 지나가는 마우스에는 안 뜬다.
3. **자식 간 이동**: 제목 요소 내부 자식 사이를 오갈 때(`relatedTarget`가 같은 제목 안)는 닫지 않는다(§4.4.6 `handlePointerOut`).
4. **스크롤/리사이즈**: 열려 있으면 위치 재계산, 앵커가 사라졌으면 닫는다.
5. **SPA 라우팅**: `startPageChangeDetection(hideTooltip)`로 페이지 전환 시 닫는다.
6. **중복 방지**: 같은 제목에 다시 호버해도 재생성하지 않는다(`titleEl === activeTitleEl` 가드).
7. **자기 자신 제외**: 툴팁 엘리먼트 내부(`[data-bctt-tooltip]`)는 제목 판정에서 제외.
8. **옵션 off**: `uninstallListeners()`로 리스너/스타일 외 잔여물(열린 툴팁) 정리. (주입된 `<style>`은 남아도 무해하나, 깔끔히 하려면 `document.getElementById(STYLE_ID)?.remove()`를 `uninstallListeners`에 추가해도 됨 — 선택.)
9. **다른 feature 충돌 없음**: 읽기 전용 오버레이라 `categoryTools`/`videoSearch`의 주입 카드와 독립. `videoSearch`가 만든 주입 카드 제목(`a[class*='title']`)도 자동으로 혜택을 본다.

---

## 7. 테스트 (`tests/extension-pages.test.js` 추가)

기존 테스트 하니스(`jsdom`, `createPageDom`, `createFakeChrome`, `evalRepoScript`, `waitForAsyncCallbacks`)를 그대로 쓴다.

**중요 — jsdom 한계**: jsdom은 레이아웃을 계산하지 않아 `scrollWidth/clientWidth/scrollHeight/clientHeight`가 모두 0이고 `getBoundingClientRect()`가 0을 돌려준다. 따라서 테스트에서는 대상 제목 요소에 이 값들을 **직접 정의(stub)** 해야 한다(기존 테스트들이 `getBoundingClientRect`를 직접 정의하는 것과 동일한 방식).

추가할 테스트 2개:

### 7.1 잘린 제목에 호버하면 전체 제목 툴팁이 뜬다

```js
test("title tooltip shows full text when a card title is truncated", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">아주 길어서 잘리는 방송 제목 전체 내용</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    // 잘림 상태 stub: scrollWidth > clientWidth
    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });
    title.getBoundingClientRect = () => ({ left: 40, top: 120, right: 240, bottom: 140, width: 200, height: 20 });

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    // 호버 + 지연 타이머 경과
    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 450));

    const tip = document.querySelector(".bctt-tooltip[data-show='1']");
    assert.ok(tip, "툴팁이 표시되어야 한다");
    assert.equal(tip.textContent, "아주 길어서 잘리는 방송 제목 전체 내용");
    assert.equal(title.getAttribute("data-bctt-active"), "1");
});
```

> `pointerover` 디스패치 시 `event.target`이 `title`이 되도록 `title`에서 직접 dispatch한다. 위임 리스너는 `capture:true`이므로 document에서 잡힌다.
> 타이머 대기는 `HOVER_OPEN_DELAY_MS`(400ms)보다 길게(450ms) 준다.

### 7.2 잘리지 않은 제목에는 반응하지 않는다

```js
test("title tooltip ignores titles that fit", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<main><article class="card">',
            '<a class="card_title" href="/live/abc">짧은 제목</a>',
            "</article></main>",
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/lives",
        chrome
    );
    const { document } = dom.window;
    const title = document.querySelector(".card_title");

    // 잘리지 않음: scroll == client
    Object.defineProperty(title, "scrollWidth", { configurable: true, get: () => 100 });
    Object.defineProperty(title, "clientWidth", { configurable: true, get: () => 200 });
    Object.defineProperty(title, "scrollHeight", { configurable: true, get: () => 20 });
    Object.defineProperty(title, "clientHeight", { configurable: true, get: () => 20 });

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "titleTooltip.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    title.dispatchEvent(new dom.window.Event("pointerover", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 450));

    assert.equal(document.querySelector(".bctt-tooltip[data-show='1']"), null);
    assert.equal(title.hasAttribute("data-bctt-active"), false);
});
```

> 옵션 기본값이 `titleTooltipEnabled: true`이므로 별도 sync 설정 없이 동작한다.
> jsdom에 `PointerEvent`가 없을 수 있으니 위처럼 `Event`로 디스패치한다(핸들러는 `e.target`/`e.relatedTarget`만 사용하므로 문제없음). `relatedTarget`이 필요한 7.2의 out 케이스는 테스트하지 않는다.

추가로 기존 **옵션 페이지 테스트가 깨지지 않는지** 확인: `tests/extension-pages.test.js`의 첫 테스트는 `optionInputs.length === OPTION_KEYS.length`를 단언한다. §4.3에서 `data-option="titleTooltipEnabled"` input을 추가하면 `OPTION_KEYS`도 +1 되어 자동으로 일치한다 — **반드시 둘 다(스키마+HTML) 추가**해야 이 단언이 통과한다.

---

## 8. 구현 후 검증

```bash
npm test
```

수동 QA 체크리스트(확장 로드 후 `chzzk.naver.com`):

- [ ] 전체 라이브(`/lives`)에서 긴 제목 카드에 호버 → 박스 하이라이트 + 전체 제목 툴팁.
- [ ] 짧은(안 잘린) 제목 호버 → 아무 변화 없음.
- [ ] 카테고리 라이브/동영상/클립 목록에서 동일 동작.
- [ ] 다크/라이트 테마 양쪽에서 툴팁 가독성·하이라이트 정상.
- [ ] 호버 중 스크롤 → 툴팁이 따라오거나(앵커 보이면) 사라짐(앵커 사라지면).
- [ ] 페이지 이동(SPA) 시 잔여 툴팁 없음.
- [ ] 옵션에서 "긴 제목 툴팁" 끄면 즉시 동작 중지, 다시 켜면 재동작.

---

## 9. 요약 (Codex 실행 순서)

1. `shared/settings.js` — `titleTooltipEnabled` 스키마 추가.
2. `options.html` — 토글 추가(종속 마킹 없이).
3. `features/titleTooltip.js` — §4.4 골격 + §5 CSS로 신규 작성.
4. `manifest.json` — js 배열에 파일 등록.
5. `tests/extension-pages.test.js` — §7 테스트 2개 추가.
6. `npm test` 통과 확인.
