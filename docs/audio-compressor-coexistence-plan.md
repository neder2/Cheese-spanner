# 오디오 컴프레서 완성 — 치즈나이프 공존(감지-양보) + MIT 표기 구현 명세

> 대상: 자동 구현 에이전트
> 작성 기준 코드: Better Chzzk v1.2.0 (`main`)
> 이 문서만 읽고 구현 가능하도록 작성되었다. 추측이 필요한 부분은 **"결정"** 으로 못박아 두었으니 그대로 따른다.

---

## 1. 목표 (무엇을 만드는가)

우리 오디오 컴프레서(`features/volumeTooltip.js`의 두 번째 IIFE)는 cheese-knife(치즈나이프) 확장의 컴프레서에서 파생된 코드다. 두 확장이 동시에 설치된 환경에서 다음 문제를 해결하고, 파생 코드에 대한 MIT 라이선스 표기 의무를 이행한다.

1. **감지-양보**: 치즈나이프 컴프레서가 페이지에 존재하면 우리 컴프레서 버튼을 숨기고 오디오 그래프도 만들지 않는다(완전 양보).
2. **단독 동작**: 치즈나이프가 없으면(또는 치즈나이프 쪽 컴프레서 기능이 꺼져 있으면) 우리 컴프레서가 기존대로 표시·동작한다.
3. **기본값 꺼짐 유지**: `audioCompressorEnabled`의 기본값은 `false`다. **이미 그렇게 되어 있으므로 변경하지 않는다** (`shared/settings.js:48`). 절대 `true`로 바꾸지 말 것.
4. **MIT 표기**: cheese-knife(MIT, Copyright (c) 2023- jebibot) 파생 사실을 저장소와 배포물 양쪽에 표기한다.
5. **실패 피드백**: 컴프레서 그래프 생성이 실패한 경우(예: 다른 프로그램이 이미 오디오를 잡은 경우) 버튼 툴팁으로 사용 불가 사유를 알린다.

비범위(하지 않을 것): 볼륨 툴팁(첫 번째 IIFE) 변경, 치즈나이프의 게인 슬라이더 UI 모방, 컴프레서 파라미터 스키마 변경, `manifest.json` 권한/버전 변경, git 히스토리 수정.

---

## 2. 배경 사실 (구현자가 반드시 알아야 할 것)

### 2.1 왜 "양보"가 필수인가 — Web Audio 소스 충돌

- 우리 컴프레서와 치즈나이프 컴프레서 **둘 다** `AudioContext.createMediaElementSource(video)`로 오디오를 잡는다 (우리: `features/volumeTooltip.js:364`, 치즈나이프: `web/inject.js`의 Vue `watch.enabled`).
- 하나의 `<video>` 요소는 MediaElementAudioSourceNode에 **딱 한 번만** 연결될 수 있다. 늦게 잡는 쪽은 `InvalidStateError`로 실패하고, 한 번 잡힌 video는 **페이지 리로드 전까지 놓아줄 방법이 없다**.
- 치즈나이프는 MAIN world(`web/inject.js` 페이지 주입), 우리는 isolated world지만 `<video>`와 DOM은 공유되므로 충돌은 그대로 발생한다.
- 결론: 버튼 UI 중복은 부차 문제고, **감지-양보는 소리 고장을 막는 방어 로직**이다.

### 2.2 치즈나이프 컴프레서의 DOM 시그니처 (2026-07-04, jebibot/cheese-knife main 기준 실측)

- 원본 볼륨 컨트롤(`.pzp-pc__volume-control`)의 **바로 다음 형제**(`insertAdjacentElement("afterend", ...)`)로 아래 컨테이너를 삽입한다:
    ```html
    <div class="pzp-pc__volume-control knife-comp">
        <pzp-pc-ui-button class="pzp-pc__volume-button" ...>...</pzp-pc-ui-button>
        <ui-slider class="... knife-gain-slider" ...>...</ui-slider>
    </div>
    ```
- 식별 클래스는 **`knife-comp`** (컨테이너)와 `knife-gain-slider`(게인 슬라이더)다.
- 치즈나이프 사용자가 설정에서 컴프레서 기능을 꺼두면 `.knife-comp`가 DOM에 아예 생성되지 않는다 → 존재 = 활성으로 봐도 된다.

### 2.3 주의 — 우리 버튼의 `knife-audio-compressor` 클래스는 가짜다

`features/volumeTooltip.js:469`에서 우리 버튼에 `knife-audio-compressor` 클래스를 붙이고 있는데, **이것은 치즈나이프의 실제 클래스명이 아니다** (치즈나이프 CSS 편승 효과 없음). 감지 시그니처와 혼동되므로 이번 작업에서 제거한다(§4.1-D).

### 2.4 선례 — 빨리감기의 외부 버튼 양보 패턴

`features/skipControl.js`가 이미 같은 패턴을 쓴다. 참고 지점:

- 시그니처 상수: `skipControl.js:23` (`EXTERNAL_FAST_FORWARD_SIGNATURE_TERMS`)
- 감지 함수: `skipControl.js:362` (`looksLikeExternalLiveFastForwardButton`), `skipControl.js:1235` (`findExternalLiveFastForwardButton`)
- 양보 지점: `skipControl.js:1579` — 외부 버튼이 있으면 자기 버튼을 제거하고 return
- 테스트 선례: `tests/extension-pages.test.js:4738` (`"live fast-forward button does not duplicate an external knife button"`)

---

## 3. 아키텍처 결정

### 3.1 감지 기준 — **결정: `.knife-comp` 존재(isConnected)만으로 감지하고, 가시성(visibleArea)은 확인하지 않는다**

이유: 플레이어 컨트롤바는 자동 숨김(페이드아웃)된다. 가시성까지 조건에 넣으면 컨트롤바가 숨겨질 때마다 "외부 컴프레서 없음"으로 오판 → 우리 버튼이 생겼다 사라지는 플립플롭이 발생한다. 치즈나이프는 기능이 꺼져 있으면 `.knife-comp`를 아예 만들지 않으므로, DOM에 연결되어 있다는 사실만으로 활성이라 판단해도 안전하다.

```js
const EXTERNAL_COMPRESSOR_SELECTOR = ".knife-comp";

function findExternalCompressor() {
    for (const el of document.querySelectorAll(EXTERNAL_COMPRESSOR_SELECTOR)) {
        if (el instanceof HTMLElement && el.id !== BUTTON_ID && !el.contains(currentButton())) return el;
    }
    return null;
}
```

(우리 버튼은 `.knife-comp` 클래스를 쓰지 않으므로 `el.id !== BUTTON_ID` 체크는 방어용이다.)

### 3.2 양보 동작 — **결정: 버튼 제거 + `compressorActive = false` + 기존 그래프는 bypass 유지. `releaseActiveGraph()`/`context.close()`는 절대 호출하지 않는다**

이유: 우리가 이미 `createMediaElementSource`로 video를 잡은 뒤라면, 컨텍스트를 close해도 video는 close된 그래프에 묶여 **무음이 될 수 있다**. 기존 코드의 `releaseActiveGraph()`는 페이지 이동(`pagehide`)·video 교체처럼 video 자체가 사라지는 시점에만 호출된다 — 그 용도를 유지한다. 양보 시에는 `syncState()`의 기존 `!compressorEnabled()` 분기(`volumeTooltip.js:583-591`)가 그래프를 bypass로 돌려 소리를 보존한다. 이 분기를 그대로 재활용하면 신규 그래프 생성(`graphFor`)에도 도달하지 않는다.

### 3.3 알려진 한계 (문서화만, 코드로 해결 불가)

우리 컴프레서를 켠 뒤(소스를 잡은 뒤) 치즈나이프가 나중에 나타나는 경우, 리로드 전에는 치즈나이프 쪽 컴프레서가 동작할 수 없다(2.1의 소스 선점). 이 경우에도 우리 그래프는 bypass로 전환되어 **소리 자체는 정상**이다. 두 확장 모두 문서 로드 시점에 주입되므로 실사용에서 이 순서는 드물다. `docs/update-history.md`에 한 줄로 남긴다(§4.6).

### 3.4 감시 — MutationObserver 셀렉터에 `.knife-comp` 추가

치즈나이프 주입이 우리보다 늦어도 반응하도록 `volumeTooltip.js:609-623`의 observer 조건에 `mutationMatchesSelector(mutation, EXTERNAL_COMPRESSOR_SELECTOR)`를 추가한다. 이때 우리 버튼이 잠깐 보였다 사라지는 플리커가 있을 수 있는데, 빨리감기도 동일한 특성이므로 허용한다.

### 3.5 MIT 표기 전략 — 이중 표기

MIT의 조건은 "소프트웨어의 사본 또는 상당 부분에 저작권 고지와 허가 고지를 포함"이다.

1. **배포물 내 고지(필수)**: `features/volumeTooltip.js` 컴프레서 IIFE 바로 위 헤더 주석. 이 파일 자체가 배포 zip에 포함되므로, 배포되는 모든 사본에 고지가 실린다. **이것만으로 라이선스 조건은 충족된다.**
2. **저장소 정본(필수)**: 루트에 `THIRD_PARTY_NOTICES.md` 신규 — MIT 전문 + 파생 범위 명시.
3. **배포 zip 포함(시도)**: `web-ext-config.mjs`의 `ignoreFiles`에 `"*.md"`가 있어 THIRD_PARTY_NOTICES.md가 zip에서 제외된다. §4.8의 방법으로 포함을 시도하고, 실패하면 1번으로 충족되므로 블로커가 아니다.

파생 범위(고지에 명시할 것): 컴프레서 버튼 UI 구성, 아이콘 SVG(path 데이터가 cheese-knife `web/inject.js`와 동일함을 확인), Web Audio 그래프(source → DynamicsCompressor → Gain → destination) 구성.

---

## 4. 파일별 변경 지시

| #   | 파일                            | 변경                                                           |
| --- | ------------------------------- | -------------------------------------------------------------- |
| 1   | `features/volumeTooltip.js`     | 감지-양보 로직 + 헤더 고지 주석 + 가짜 클래스 제거 + 실패 툴팁 |
| 2   | `THIRD_PARTY_NOTICES.md`        | **신규** — cheese-knife MIT 고지 정본                          |
| 3   | `README.md`                     | 서드파티 고지 섹션 + 컴프레서 기능 설명에 양보 동작 한 줄      |
| 4   | `options.html`                  | 컴프레서 토글 설명(`small`)에 자동 숨김 안내 추가              |
| 5   | `docs/update-history.md`        | 변경 항목 추가                                                 |
| 6   | `tests/extension-pages.test.js` | 감지-양보 DOM 테스트 3종 추가                                  |
| 7   | `tests/release-safety.test.js`  | 고지 파일·주석 존재 assert 추가                                |
| 8   | `web-ext-config.mjs`            | THIRD_PARTY_NOTICES.md zip 포함 시도                           |

`shared/settings.js`는 **변경하지 않는다** (`audioCompressorEnabled` 기본 `false` 이미 충족, `tests/settings.test.js:27`이 이미 고정하고 있음). 작업 트리에 이 파일의 다른 기능(rewardAutoCollect / followingPreviewSound) 관련 uncommitted 변경이 있어도 **건드리지 말 것** — 별개 작업이다.

### 4.1 `features/volumeTooltip.js`

컴프레서 IIFE(175행 `(() => {` ~ 636행)만 수정한다. 첫 번째 IIFE(볼륨 툴팁)는 건드리지 않는다.

**A. 헤더 고지 주석** — 175행 IIFE 바로 위에 삽입:

```js
/*
 * The audio compressor below is derived from cheese-knife
 * (https://github.com/jebibot/cheese-knife) — Copyright (c) 2023- jebibot,
 * MIT License — and was modified for Better Chzzk.
 * Full license text: THIRD_PARTY_NOTICES.md
 */
```

**B. 감지 상수·함수 추가** — `BUTTON_LABEL` 선언부(189행 근처)에 상수를, `visibleArea` 근처에 함수를 추가:

```js
const EXTERNAL_COMPRESSOR_SELECTOR = ".knife-comp";
```

§3.1의 `findExternalCompressor()`를 추가한다. `currentButton()`은 함수 선언 호이스팅으로 접근 가능하지만, 정의 순서가 신경 쓰이면 `findExternalCompressor`를 `currentButton`(453행) 아래에 둔다.

**C. `ensureButton()` 수정** (531행) — 라우트 체크 다음에 양보 분기 추가:

```js
function ensureButton() {
    if (!featureEnabled() || !isPlaybackRoute()) {
        removeButton();
        return;
    }
    if (findExternalCompressor()) {
        removeButton();
        return;
    }
    // ...이하 기존 코드 그대로
```

**D. 가짜 클래스 제거** — `syncButtonClass()`(466행)에서 아래 줄을 **삭제**:

```js
button.classList.add("knife-audio-compressor");
```

버튼 식별은 id(`betterchzzk-audio-compressor`)로 이미 충분하다. 대체 클래스를 추가하지 않는다.

**E. `syncState()` 수정** (566행) — `ensureButton()` 호출 직전에 양보 판정 추가:

```js
function syncState() {
    if (!featureEnabled()) {
        syncDisabledState();
        return;
    }
    if (findExternalCompressor()) compressorActive = false;
    ensureButton();
    // ...이하 기존 코드 그대로
```

`compressorActive = false`가 되면 이후 기존 `!compressorEnabled()` 분기(583-591행)가 기존 그래프를 bypass로 돌리고, `graphFor()`(신규 소스 잡기)에는 도달하지 않는다. **`releaseActiveGraph()`를 여기서 호출하지 말 것**(§3.2).

**F. MutationObserver 감시 대상 추가** — `installRuntime()`(604행)의 `onMutations` 조건에 한 줄 추가:

```js
mutationMatchesSelector(mutation, "video") ||
    mutationMatchesSelector(mutation, VOLUME_CONTROL_SELECTOR) ||
    mutationMatchesSelector(mutation, VOLUME_BUTTON_SELECTOR) ||
    mutationMatchesSelector(mutation, EXTERNAL_COMPRESSOR_SELECTOR);
```

**G. 실패 상태 툴팁** — `syncButtonState()`(480행)는 이미 `failed`를 계산한다. 라벨 동기화를 실패 상태에 연동한다:

```js
function syncButtonLabels(button, failed = false) {
    const label = failed ? `${BUTTON_LABEL}(사용할 수 없음)` : BUTTON_LABEL;
    button.setAttribute("label", label);
    button.setAttribute("aria-label", label);
    button.setAttribute("tooltip", label);
    button.removeAttribute("title");
}
```

`syncButtonState()` 끝의 호출을 `syncButtonLabels(button, failed);`로 바꾼다. `createButton()`(497행)의 호출은 인자 없이 그대로 둔다(기본값 false).

### 4.2 `THIRD_PARTY_NOTICES.md` (신규, 저장소 루트)

아래 내용 그대로 생성한다 (MIT 전문 포함 — 원문 유지, 요약·번역 금지):

```markdown
# Third-Party Notices

Better Chzzk에는 아래 오픈소스 프로젝트에서 파생된 코드가 포함되어 있습니다.

## cheese-knife

- 출처: https://github.com/jebibot/cheese-knife
- 라이선스: MIT License (Copyright (c) 2023- jebibot)
- 사용 범위: `features/volumeTooltip.js`의 오디오 컴프레서 — 버튼 UI 구성,
  아이콘 SVG, Web Audio 그래프(DynamicsCompressor + Gain) 구성이
  cheese-knife의 구현에서 파생되었으며 Better Chzzk에 맞게 수정되었습니다.

### MIT License

MIT License

Copyright (c) 2023- jebibot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### 4.3 `README.md`

1. 오디오 컴프레서 기능 설명 문장(README 내 "컴프레서" 검색으로 위치 확인)에 다음 취지의 한 줄을 덧붙인다:
    > 치즈나이프(cheese-knife) 확장의 컴프레서가 감지되면 기능 충돌을 피하기 위해 Better Chzzk의 컴프레서 버튼은 자동으로 숨겨집니다.
2. 문서 하단(라이선스/고지 성격의 섹션이 있으면 그 근처, 없으면 맨 끝)에 섹션 추가:

    ```markdown
    ## 서드파티 고지

    오디오 컴프레서는 [cheese-knife](https://github.com/jebibot/cheese-knife)
    (MIT License, Copyright (c) 2023- jebibot)에서 파생된 코드를 포함합니다.
    자세한 내용은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 참고하세요.
    ```

### 4.4 `options.html`

375행의 컴프레서 토글 설명을 수정한다 (옵션 페이지는 좁은 팝업이므로 문구는 짧게, 특수문자 나열 없이):

```html
<span
    ><strong>오디오 컴프레서</strong
    ><small
        >플레이어에 컴프레서 버튼을 답니다. 치즈나이프 확장의 컴프레서가 있으면 버튼을 자동으로 숨깁니다.</small
    ></span
>
```

`tests/extension-pages.test.js`에 options 문구를 검사하는 테스트가 있다면(1351행 근처 라벨 목록) 바뀐 문구와 어긋나지 않는지 확인하고 필요 시 함께 갱신한다.

### 4.5 `docs/update-history.md`

기존 항목 형식(최근 항목 참고)에 맞춰 추가한다. 포함할 내용:

- 치즈나이프 컴프레서 감지 시 Better Chzzk 컴프레서 버튼 자동 숨김(오디오 소스 충돌 방지). 치즈나이프가 없으면 기존대로 동작.
- Better Chzzk 컴프레서를 먼저 켠 세션에서는 새로고침 전까지 치즈나이프 컴프레서가 동작하지 않을 수 있음(브라우저 Web Audio 제약).
- 컴프레서 사용 불가 상태에서 버튼 툴팁에 사용할 수 없음 표시.
- cheese-knife(MIT) 파생 고지 추가 — THIRD_PARTY_NOTICES.md.

### 4.6 `tests/extension-pages.test.js` — 감지-양보 테스트 3종

`tests/extension-pages.test.js:4738`의 빨리감기 외부 버튼 테스트를 본뜬다(같은 `createFakeChrome`/`createPageDom` 유틸, 같은 `getBoundingClientRect` 목킹 방식). 컴프레서 버튼 주입에는 다음이 필요하다는 점에 주의:

- fake chrome sync에 `audioCompressorEnabled: true`
- URL은 재생 라우트(예: `https://chzzk.naver.com/live/test-channel`)
- `.pzp-pc__volume-control` 컨테이너 + 내부에 가시적인 `.pzp-pc__volume-button`
- `findVolumeControl()`이 `isControlNearVideo()` 기하 체크를 하므로 video와 볼륨 컨트롤의 `getBoundingClientRect`를 빨리감기 테스트처럼 목킹(볼륨 컨트롤 중심이 video 하단 근처에 오도록)

테스트 케이스:

1. **양보**: DOM에 `<div class="pzp-pc__volume-control knife-comp">`가 이미 있으면 → `#betterchzzk-audio-compressor`가 주입되지 **않는다**.
2. **단독 동작**: `.knife-comp`가 없으면 → `#betterchzzk-audio-compressor`가 볼륨 버튼 다음 형제로 주입된다.
3. **늦은 주입 대응**: 2번 상태에서 `.knife-comp` 요소를 삽입하고 sync를 다시 태우면(기존 테스트들이 쓰는 mutation/타이머 플러시 패턴 재사용) → 버튼이 제거된다.

### 4.7 `tests/release-safety.test.js` — 고지 존재 고정

다음 assert를 추가한다 (기존 `readRepoFile` 패턴 사용):

1. `THIRD_PARTY_NOTICES.md`가 존재하고 `jebibot`과 `MIT License` 문자열을 포함한다.
2. `features/volumeTooltip.js`가 `cheese-knife`와 `jebibot` 문자열(헤더 고지 주석)을 포함한다.

### 4.8 `web-ext-config.mjs` — zip 포함 시도

`ignoreFiles` 배열에서 `"*.md"` **다음 위치**에 negation 패턴을 추가한다:

```js
"*.md",
"!THIRD_PARTY_NOTICES.md",
```

검증(§6-4)에서 zip에 THIRD_PARTY_NOTICES.md가 실제로 들어갔는지 확인한다. **web-ext가 negation을 지원하지 않아 실패하는 경우**: 이 negation 줄만 되돌리고 끝낸다(파일명 변경 등 추가 우회를 하지 않는다). 배포물 내 고지는 §4.1-A 헤더 주석으로 이미 충족된다. 실패 시 그 사실을 작업 보고에 명시할 것.

---

## 5. 구현 순서 (권장)

1. §4.1 (volumeTooltip.js — 핵심 기능)
2. §4.6 (감지-양보 테스트) → `npm test`로 신규 테스트 통과 확인
3. §4.2 → §4.3 → §4.4 (고지·문구)
4. §4.7 (release-safety 테스트) → `npm test`
5. §4.8 (zip 포함) → 빌드 검증
6. §4.5 (update-history)

---

## 6. 검증 절차 (완료 조건)

1. `npm test` 전체 통과 (신규 테스트 포함).
2. `npx eslint .` 통과.
3. `npx prettier --check .` 통과 (신규 md 파일 포함).
4. `npx web-ext build --overwrite-dest` 후 생성된 zip 내용 확인:
    - `features/volumeTooltip.js` 안에 `cheese-knife` 헤더 주석 포함.
    - `THIRD_PARTY_NOTICES.md` 포함 여부 확인(§4.8 — 미포함이면 negation 줄 되돌리고 보고).
5. 코드 리뷰 관점 재확인:
    - `shared/settings.js` diff 없음(이 작업으로 인한 변경 0).
    - `releaseActiveGraph()`/`context.close()`가 양보 경로에서 호출되지 않음.
    - `knife-audio-compressor` 문자열이 저장소에서 사라짐(`docs/` 제외).

수동 확인(가능한 환경에서만, 불가하면 생략하고 보고):

- 치즈나이프 미설치: 재생 페이지에서 볼륨 버튼 옆에 컴프레서 버튼 표시, 토글 시 소리 압축 동작.
- 치즈나이프 설치 + 치즈나이프 컴프레서 활성: 우리 버튼 미표시, 치즈나이프 컴프레서 정상 동작.
