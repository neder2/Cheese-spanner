# 볼륨 휠 조절 + 컨트롤 툴팁 폰트 통일 구현 계획

> 대상: Codex (자동 구현 에이전트)
> 작성 기준 코드: Better Chzzk / 브랜치 `1.1.5` (워킹 트리 기준)
> 두 가지 독립 작업이다. **작업 A(볼륨 휠)**, **작업 B(툴팁 폰트)**. 서로 의존하지 않으니 따로 커밋해도 된다.

---

## 사전 사실 (코드 확인 결과)

- 플레이어 조작 기능은 `features/skipControl.js`에 있고, **휠 입력 패턴이 이미 존재**한다 — `handleSkipPillWheel` + `window.addEventListener("wheel", handler, { capture: true, passive: false })`. 볼륨도 이 패턴을 그대로 쓴다.
- 빨리감기/스킵 버튼의 툴팁은 **커스텀 `<div id="betterchzzk-control-tooltip">`** 방식이다(`::after`나 `title` 아님). CSS는 `injectSkipStyleOnce()` 안의 `#betterchzzk-control-tooltip` 블록(`features/skipControl.js`).
- 그 CSS에는 `font-size:14px; font-weight:400; line-height:18px;`만 있고 **`font-family`가 없다** → `document.body` 상속 폰트를 쓰게 되어 네이티브 pzp 툴팁과 어긋난다. 이것이 작업 B의 원인이다.
- 옵션/설정 시스템: `shared/settings.js`의 `OPTION_SCHEMA`에 항목을 추가하면 `OPTION_KEYS`/`FEATURE_KEYS`/`DEFAULT_OPTIONS`가 자동 파생된다. 옵션 UI는 `options.html`의 `data-option` 속성으로 자동 바인딩된다.
- 유틸(`content.js` → `BetterChzzk.utils`): `getMainVideoElement`, `isVisible`, `pickLargestVisible`, `bindFeatureOptions`, `onReady`, `startPageChangeDetection`, `injectStyleOnce`, `normalizeCompact` 등.
- 볼륨 관련 기존 코드는 **전혀 없다**(신규).

---

# 작업 A — 볼륨 바 휠 스크롤로 볼륨 조절

## A-1. 목표

치지직 플레이어의 **볼륨 컨트롤이 보일 때**, 그 영역 위에서 마우스 휠을 굴리면 볼륨이 조절된다. 1틱당 변화량(%)은 옵션 페이지에서 설정한다.

- 휠 업 = 볼륨 증가, 휠 다운 = 볼륨 감소.
- 볼륨이 0보다 커지면 음소거 자동 해제, 0이 되면 음소거.
- 볼륨 컨트롤 영역 위에서의 휠은 **페이지 스크롤을 막는다**(`preventDefault`).

## A-2. 아키텍처 결정

**신규 독립 파일 `features/volumeWheel.js`** 로 만든다. `skipControl.js`(1,800줄+)에 넣지 않는다. 이유: 볼륨은 "시간 이동"과 별개 관심사이고, 독립 토글/테스트가 깔끔하다. (직전 `titleTooltip.js` 작업과 동일한 판단.)

네이밍 prefix = **`bcvw`** (better-chzzk volume wheel). 단, 이 기능은 DOM에 영구 요소를 만들지 않으므로(휠 리스너만) 속성/ID는 거의 쓰지 않는다. 스타일 주입도 불필요(선택적 OSD를 넣을 때만).

## A-3. 옵션 추가

### `shared/settings.js` — `OPTION_SCHEMA`

`skipWheelAltStep` 줄 **다음**(스킵 휠 옵션 군 근처)에 추가한다.

```js
skipWheelAltStep: { kind: "int", default: 10, min: 1, max: 600 },
volumeWheelEnabled: { kind: "bool", default: true, feature: true },
volumeWheelStep: { kind: "int", default: 5, min: 1, max: 50 },
```

> `volumeWheelStep` 단위는 **퍼센트(%)**. 기본 5%, 범위 1~50%.
> `feature: true`는 `volumeWheelEnabled`에만 — 이게 기능 토글이다.

### `tests/settings.test.js` — 두 곳 갱신 (필수)

1. `expectedDefaults` 객체에 추가:
    ```js
    volumeWheelEnabled: true,
    volumeWheelStep: 5,
    ```
2. `"feature count keys are derived from feature toggles only"` 테스트의 기대 배열에 `"volumeWheelEnabled"` 추가(배열 순서는 `OPTION_SCHEMA` 등장 순서를 따른다 → `skipControlEnabled` 등과 같은 그룹, 위치는 스키마 순서대로).

### `options.html` — "라이브/다시보기 조작" 섹션

`vodBroadcastClockEnabled`(다시보기 방송시각) 토글 **앞**, 즉 같은 `settings-card` 안에 추가한다. 볼륨 휠은 스킵 기능과 독립이므로 **`data-depends-on`을 붙이지 않는다**. 수치 입력은 `volumeWheelEnabled`에 종속.

```html
<label class="toggle-row">
    <span
        ><strong>볼륨 휠 조절</strong
        ><small>볼륨 조절 영역에 마우스를 올리고 휠을 굴리면 볼륨이 조절됩니다.</small></span
    >
    <input type="checkbox" data-option="volumeWheelEnabled" />
</label>
```

그리고 "스킵 수치 설정" `<details>`와 **별도로**, 같은 섹션에 작은 수치 입력을 추가한다(스킵과 무관하므로 스킵 details 안에 넣지 않는다):

```html
<details class="advanced-settings">
    <summary>볼륨 휠 설정</summary>
    <div class="number-grid" data-depends-on="volumeWheelEnabled">
        <label
            ><span>1틱 볼륨</span><input type="number" min="1" max="50" step="1" data-option="volumeWheelStep" /><em
                >%</em
            ></label
        >
    </div>
    <p class="setting-note">볼륨 조절 영역(스피커 아이콘/슬라이더) 위에서 휠을 굴릴 때 적용됩니다.</p>
</details>
```

> 주의: `tests/settings.test.js`에 `"options.html data-option keys match the settings keys"` 단언이 있다. 스키마 2개 추가 ↔ HTML `data-option` 2개 추가가 **정확히 일치**해야 통과한다.

## A-4. `features/volumeWheel.js` (신규) — 구현 골격

```js
(() => {
    // 치지직(프리즘) 볼륨 컨트롤 영역. 정확한 클래스는 런타임 확인(§A-6) 후 보강.
    const VOLUME_CONTROL_SELECTOR = [
        "[class*='pzp'][class*='volume']",
        ".pzp-pc__volume",
        ".pzp-pc__volume-control",
        ".pzp-pc__volume-button",
        "[class*='volume-control']",
        "[class*='volume-slider']",
    ].join(", ");
    const PLAYBACK_ROUTE_RE = /^\/(?:live|video)(?:\/|$)/;

    let featureOptions = BetterChzzkSettings.normalizeOptions();
    let listenersInstalled = false;

    const { bindFeatureOptions, getMainVideoElement, isVisible, onReady } = BetterChzzk.utils;

    function isFeatureEnabled() {
        return featureOptions.volumeWheelEnabled;
    }

    function isPlaybackRoute() {
        return PLAYBACK_ROUTE_RE.test(location.pathname);
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getStepRatio() {
        const step = Number(featureOptions.volumeWheelStep);
        return clamp(Number.isFinite(step) ? step : 5, 1, 50) / 100;
    }

    // 휠 지점이 "보이는" 볼륨 컨트롤 영역인지 판정.
    function getVolumeControlAt(target) {
        if (!(target instanceof Element)) return null;
        const el = target.closest(VOLUME_CONTROL_SELECTOR);
        if (!(el instanceof HTMLElement) || !isVisible(el)) return null;
        return el;
    }

    function applyVolumeDelta(video, directionSteps) {
        if (!(video instanceof HTMLVideoElement)) return false;

        const current = video.muted ? 0 : Number.isFinite(video.volume) ? video.volume : 0;
        const next = clamp(current + directionSteps * getStepRatio(), 0, 1);

        // 0 초과면 음소거 해제. 0이면 음소거.
        if (next > 0 && video.muted) video.muted = false;
        video.volume = next;
        if (next <= 0) video.muted = true;

        // pzp가 video.volume 변화를 반영하지 않을 경우의 폴백(§A-6에서 검증 후 사용):
        // syncNativeVolumeSlider(next);
        return true;
    }

    function handleWheel(event) {
        if (!isFeatureEnabled() || !isPlaybackRoute()) return;
        const control = getVolumeControlAt(event.target);
        if (!control) return;

        const video = getMainVideoElement();
        if (!video) return;

        event.preventDefault();
        event.stopPropagation();

        const direction = event.deltaY < 0 ? 1 : -1; // 위로 굴리면 증가
        applyVolumeDelta(video, direction);
    }

    function installListeners() {
        if (listenersInstalled) return;
        listenersInstalled = true;
        window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    }

    function uninstallListeners() {
        if (!listenersInstalled) return;
        listenersInstalled = false;
        window.removeEventListener("wheel", handleWheel, true);
    }

    function applyOptions(options) {
        featureOptions = options;
        if (isFeatureEnabled()) installListeners();
        else uninstallListeners();
    }

    bindFeatureOptions(applyOptions);
    onReady(() => {
        if (isFeatureEnabled()) installListeners();
    });
})();
```

### `manifest.json`

두 번째 콘텐츠 스크립트의 `js` 배열에 등록한다(순서 무관하지만 `skipControl.js` 근처가 자연스럽다). `titleTooltip.js`와 나란히 둔다:

```json
"features/categoryTools.js",
"features/titleTooltip.js",
"features/volumeWheel.js"
```

## A-5. 볼륨 반영 검증 & 폴백 (중요)

`video.volume`을 직접 설정하면 `volumechange` 이벤트가 자동 발생한다. 프리즘(pzp) 플레이어가 이 이벤트를 듣고 **볼륨 슬라이더 UI와 음소거 아이콘을 갱신하는지 실제로 확인**한다.

- **갱신되면**: §A-4 그대로 완료.
- **갱신 안 되면**(슬라이더가 안 따라옴): 네이티브 볼륨 슬라이더(`input[type=range]` 또는 `[role='slider']`)를 찾아 값/`aria-valuenow`를 설정하고 `input`·`change` 이벤트를 디스패치하는 `syncNativeVolumeSlider(ratio)`를 추가해 `applyVolumeDelta` 끝에서 호출한다. 슬라이더 셀렉터는 §A-6에서 확정.

## A-6. 런타임에서 확정할 셀렉터 (구현 전 1회 확인)

치지직 라이브(`/live/...`)와 다시보기(`/video/...`) 플레이어에서 DevTools로 다음을 확인하고 `VOLUME_CONTROL_SELECTOR`(및 필요 시 슬라이더 셀렉터)를 실제 클래스로 보강한다:

1. 스피커(음소거) 버튼과 그 옆 볼륨 슬라이더를 감싸는 **컨트롤 컨테이너**의 클래스명.
2. 슬라이더가 호버 시 확장되는지, 항상 보이는지(→ `isVisible` 기준 동작 확인).
3. (폴백용) 볼륨 슬라이더가 `input[type=range]`인지 커스텀 `div[role=slider]`인지.

> 추정 클래스(`pzp-pc__volume*`)는 출발점일 뿐이다. 실제 값으로 교체하라.

## A-7. 엣지 케이스

- 라이브/VOD 재생 라우트에서만 동작(`isPlaybackRoute`). 그 외에는 휠을 무시(페이지 스크롤 정상 동작).
- 볼륨 컨트롤이 숨겨져 있으면(`isVisible` false) 무시 → "나타났을 때만"이라는 요구 충족.
- `skipControl.js`도 `window`에 capture wheel을 걸지만 **영역이 겹치지 않는다**(볼륨 컨트롤 vs 스킵 pill). 각자 자기 영역에서만 `preventDefault`하므로 공존 OK.
- 옵션 off → `uninstallListeners()`로 즉시 중지.

## A-8. 테스트 (`tests/extension-pages.test.js`)

기존 하니스(`createPageDom`, `createFakeChrome`, `evalRepoScript`, `waitForAsyncCallbacks`) 사용. jsdom에는 레이아웃이 없으므로 볼륨 컨트롤 요소의 `getBoundingClientRect`를 보이도록 stub하고, `WheelEvent` 대신 `Event`에 `deltaY`를 얹어 디스패치한다.

```js
test("volume wheel raises and lowers media volume over the volume control", async () => {
    const chrome = createFakeChrome();
    const dom = createPageDom(
        [
            "<!doctype html>",
            "<body>",
            '<video id="video"></video>',
            '<div class="pzp-pc__volume-control" id="vol"><button class="pzp-pc__volume-button"></button></div>',
            "</body>",
        ].join(""),
        "https://chzzk.naver.com/live/test-channel",
        chrome
    );
    const { document } = dom.window;
    const video = document.getElementById("video");
    const vol = document.getElementById("vol");

    video.volume = 0.5;
    video.getBoundingClientRect = () => ({ width: 640, height: 360, left: 0, top: 0, right: 640, bottom: 360 });
    vol.getBoundingClientRect = () => ({ width: 40, height: 40, left: 20, top: 320, right: 60, bottom: 360 });

    evalRepoScript(dom, "shared", "settings.js");
    evalRepoScript(dom, "content.js");
    evalRepoScript(dom, "features", "volumeWheel.js");
    document.dispatchEvent(new dom.window.Event("DOMContentLoaded", { bubbles: true }));
    await waitForAsyncCallbacks();

    const up = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(up, "deltaY", { value: -100 });
    Object.defineProperty(up, "target", { value: vol }); // 위임 판정용
    vol.dispatchEvent(up);
    assert.ok(Math.abs(video.volume - 0.55) < 1e-6, "휠 업이면 +5%");

    const down = new dom.window.Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperty(down, "deltaY", { value: 100 });
    Object.defineProperty(down, "target", { value: vol });
    vol.dispatchEvent(down);
    assert.ok(Math.abs(video.volume - 0.5) < 1e-6, "휠 다운이면 -5%");
});
```

> `event.target`을 직접 정의하는 이유: jsdom의 capture 위임에서 `closest` 판정에 쓰인다. 실제 브라우저에선 자동.
> 추가 권장 테스트: 볼륨 컨트롤 **밖**에서 휠 → `video.volume` 불변 / 옵션 off 시 불변.

---

# 작업 B — 컨트롤 툴팁 폰트를 네이티브 툴팁과 통일

## B-1. 문제

빨리감기(`#betterchzzk-live-fast-forward`)·스킵(`#betterchzzk-skip-pill`) 버튼의 커스텀 툴팁 `#betterchzzk-control-tooltip`의 CSS에 **`font-family`가 없어** `document.body` 상속 폰트로 렌더된다. 치지직 네이티브(pzp) 버튼 툴팁과 글꼴/크기/굵기가 어긋나 보인다.

현재 CSS(`features/skipControl.js`, `injectSkipStyleOnce` 내부):

```css
#betterchzzk-control-tooltip {
    position: fixed;
    z-index: 2147483647;
    display: none;
    padding: 9px 15px;
    border-radius: 9999px;
    background: rgba(18, 18, 20, 0.92);
    color: #fff;
    font-size: 14px;
    font-weight: 400;
    line-height: 18px;
    letter-spacing: 0;
    white-space: nowrap;
    pointer-events: none;
    box-sizing: border-box;
}
```

## B-2. 확인 단계 (구현 전 1회)

치지직 플레이어에서 네이티브 버튼(설정/전체화면 등)에 호버 → 나타나는 **pzp 툴팁**을 DevTools로 inspect하여 다음 computed 값을 기록한다:

- `font-family`, `font-size`, `font-weight`, `letter-spacing`, `line-height`
- (참고) `padding`, `border-radius`, `background`, `color`

> 사용자 보고가 "폰트가 다르다"이므로 **font-family / font-size / font-weight** 세 가지가 핵심이다. 나머지(모양)는 의도적으로 다르게 둬도 무방하지만, 확인해서 같이 맞추면 더 자연스럽다.

## B-3. 수정 (두 단계, 권장순)

### (1) CSS에 폰트 명시 — 1차 해법

`#betterchzzk-control-tooltip` 블록에 B-2에서 확인한 값을 반영한다. 최소한 `font-family`를 추가하고, 확인된 `font-size`/`font-weight`로 교체한다. 예시(확인값으로 교체할 것):

```css
#betterchzzk-control-tooltip {
    /* ...기존 위치/배경 유지... */
    font-family: <네이티브 툴팁 font-family>;
    font-size: <네이티브 값>; /* 예: 12px */
    font-weight: <네이티브 값>; /* 예: 700 */
    letter-spacing: <네이티브 값>;
    line-height: 18px;
}
```

### (2) 폰트 패밀리 동적 복사 — 견고화(권장)

치지직 폰트 스택이 페이지/리뉴얼에 따라 바뀔 수 있으므로, `showControlTooltip()`에서 **플레이어 컨테이너의 computed font-family를 읽어 인라인으로 적용**한다. 이러면 하드코딩 없이 항상 일치한다.

`showControlTooltip(target)` 내부, `tooltip.textContent = text;` 직후에 추가:

```js
const playerRoot = target.closest("[class*='pzp']") || document.querySelector("[class*='pzp']");
if (playerRoot) {
    const cs = getComputedStyle(playerRoot);
    tooltip.style.fontFamily = cs.fontFamily;
}
```

> `target`(우리 버튼)은 플레이어 컨트롤 바 안에 있으므로 `closest("[class*='pzp']")`로 플레이어 루트를 얻는다. 거기서 UI 텍스트 폰트가 결정된다.
> font-size/weight는 네이티브 툴팁 고유값일 수 있으니 (1)의 CSS로 두고, **family만 동적**으로 맞추는 조합이 가장 안전하다.

## B-4. 테스트 (`tests/extension-pages.test.js`)

기존 control-tooltip 테스트(현재 `#betterchzzk-control-tooltip` 관련 단언이 있는 "live fast-forward..." 테스트)는 **깨뜨리지 말 것**. 거기에 폰트 단언을 추가한다.

- (1)만 적용한 경우:
    ```js
    const styleText = document.getElementById("betterchzzk-skip-style").textContent;
    assert.equal(styleText.includes("font-family"), true); // 컨트롤 툴팁에 폰트 패밀리가 명시됐는지
    ```
- (2)도 적용한 경우(동적 복사): 버튼 호버로 툴팁을 띄운 뒤
    ```js
    const tip = document.querySelector("#betterchzzk-control-tooltip[data-show='1']");
    assert.notEqual(tip.style.fontFamily, "");
    ```
    단, jsdom의 `getComputedStyle(...).fontFamily`는 빈 값일 수 있으므로, 플레이어 루트 요소에 인라인 `style="font-family:..."`를 준 fixture로 테스트하거나 이 단언은 생략하고 (1)의 CSS 단언만 둔다.

---

## 통합 체크리스트 (Codex 실행 순서)

작업 A:

1. `shared/settings.js` — `volumeWheelEnabled`, `volumeWheelStep` 스키마 추가.
2. `tests/settings.test.js` — `expectedDefaults` + feature-keys 배열 갱신.
3. `options.html` — "볼륨 휠 조절" 토글 + "볼륨 휠 설정" 수치 추가.
4. `features/volumeWheel.js` — 신규 작성(§A-4).
5. `manifest.json` — 파일 등록.
6. (런타임) §A-6 셀렉터 확인 → `VOLUME_CONTROL_SELECTOR` 보강, §A-5 볼륨 반영 검증.
7. `tests/extension-pages.test.js` — 볼륨 휠 테스트 추가.

작업 B: 8. (런타임) §B-2 네이티브 툴팁 폰트 값 확인. 9. `features/skipControl.js` — `#betterchzzk-control-tooltip` CSS에 `font-family` 등 추가(B-3-1), 권장 시 `showControlTooltip` 동적 복사(B-3-2). 10. `tests/extension-pages.test.js` — 기존 control-tooltip 단언 유지 + 폰트 단언 추가.

마지막: 11. `npm test` 전부 통과 확인. 12. 수동 QA: 라이브/VOD에서 볼륨 영역 휠 동작·1틱 값·음소거 토글, 빨리감기/스킵 툴팁이 네이티브 버튼 툴팁과 글꼴이 같은지 육안 확인.
