# 치지직 디자인 토큰·테마 표식 실측 — 2026-10-17

## 목적과 방법

1.4.5 화면 디자인 통일의 기준값과 공통 테마 모듈 `shared/uiTheme.js`의 대체값 근거를 남겨요. 같은 날 처음 받은 값을 공통 테마 모듈 착수 시점(2026-10-17 21:02 KST)에 같은 방법으로 다시 받아 비교했어요.

인증정보·쿠키 없이 `curl -sS -L`(일반 Chrome User-Agent)로 공개 HTML·CSS·JS를 받아 정적으로 읽었어요. 받은 파일은 저장소 밖 임시 디렉터리에 두고 실행하지 않았어요. 내장 브라우저는 `chzzk.naver.com`을 막으므로 실제 페이지의 DOM·computed style은 측정하지 않았어요. **실제 Chrome 화면은 미확인**이에요.

## 받은 파일

| 대상                                                                                 | 상태  | 크기(byte) | SHA-256 앞 12자리 |
| ------------------------------------------------------------------------------------ | ----- | ---------- | ----------------- |
| `https://chzzk.naver.com/`                                                           | `200` | 5,781      | `6955fc121927`    |
| `https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/vendor-DVDNLy6N.css` | `200` | 430,477    | `f1e791243751`    |
| `https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/index-nP-g7x0q.css`  | `200` | 1,563,953  | `4fea4188a2ed`    |
| `https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-uNhAs37B.js`    | `200` | 5,526,594  | `79eff47113da`    |
| `https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/vendor-CwePr91W.js`   | `200` | 6,463,234  | `567ff0e53e98`    |

HTML은 처음 받았을 때와 같은 두 CSS 파일 이름을 연결했어요. 아래 토큰 값도 처음 받은 값과 모두 같았어요.

## 루트 테마 표식

### HTML 인라인 초기화 스크립트

- `<head>`의 인라인 스크립트는 **테마가 있는 팝업 경로에서만** 테마를 정해요. 대상은 스튜디오 iframe(`/iframe/live/{id}/chat`·`/emoticon`)과 시청자 채팅 팝업(`/live/{id}/chat`)이에요. 홈·라이브 본문 같은 그 밖의 경로에서는 OBS 오버레이 클래스만 처리하고 테마를 건드리지 않은 채 끝나요.
- 테마는 주소의 `theme=light|dark` 강제값 → localStorage `theme` 저장값 → 기본값 순서로 정해요. 기본값은 스튜디오 iframe만 라이트이고 나머지는 다크예요.
- `<html>`에서 `light`·`theme_dark` 클래스를 지운 뒤 다크면 `theme_dark`, 라이트면 `light`를 붙여요. `data-theme`에는 테마 이름(`dark`/`light`)을 쓰고 `style.colorScheme`도 같은 이름으로 지정해요.

처음 확인한 표식 종류(클래스 `theme_dark`/`light`, `data-theme`, `colorScheme`), 기본 다크, 스튜디오 iframe 라이트와 같아요. 이번 재확인에서 이 스크립트가 팝업 경로 전용이라는 점을 추가로 확인했어요. 토큰 이름 체계와 표식 방식 자체는 바뀌지 않았어요.

### 본 화면의 React 테마 공급자(정적 코드 읽기)

- index JS에서 본 앱 루트를 감싸는 테마 공급자는 `defaultTheme: "dark"`, `attribute: ["class", "data-theme"]`, `value: { dark: "theme_dark", light: "light" }`, `themes: ["dark", "light"]`로 설정돼 있어요. 스튜디오 팝업 채팅과 후원 게시판은 `defaultTheme: "light"`인 공급자를 따로 써요. 상단 메뉴의 테마 버튼은 `dark`/`light`를 번갈아 저장해요.
- vendor JS의 테마 라이브러리(next-themes 계열) 적용 함수는 클래스와 `data-*` 속성 모두에 매핑값(`value[theme]`)을 써요. 같은 라이브러리의 첫 렌더 전 스크립트 경로만 `data-*`에 매핑 전 이름을 써요. `style.colorScheme`은 테마 이름이에요.
- 따라서 React가 테마를 적용한 본 화면은 다크에서 `class="theme_dark"`·`data-theme="theme_dark"`, 라이트에서 `class="light"`·`data-theme="light"`가 될 것으로 읽혀요. 실제 DOM 값은 미확인이에요.

정리하면 라이트 표식(`light` 클래스, `data-theme="light"`)은 두 경로가 같아요. 다크는 클래스 `theme_dark`가 공통이고, `data-theme`은 경로·시점에 따라 `dark` 또는 `theme_dark`일 수 있어요. 공통 테마 모듈은 다크 규칙에 `[data-theme="theme_dark"]`도 넣었어요. 표식이 없을 때도 다크이므로 결과는 같아요.

처음에는 `features/chatTools/panel.js`의 `[data-theme="theme_dark"]`가 실측 값(`dark`)과 맞지 않는다고 보았어요. 이 판단은 팝업 경로의 인라인 스크립트 기준이에요. 본 화면에서는 React 공급자가 그 값을 쓸 수 있으므로, 이전 동작의 영향을 findings에 적을 때 이 근거와 실제 Chrome 확인 결과를 함께 반영해야 해요.

### CSS의 테마 선택자

- vendor CSS: `--sem-*` 토큰은 `:root` 블록 하나(선언 1,224개)에 다크 값, `[data-theme=light]` 블록 하나(선언 157개)에 라이트 값이 있어요. `[data-theme=dark]` 16곳은 스포츠 위젯(`.sports-embed`·`sw_*`) 전용이고 루트 토큰과 무관해요. `.theme_dark`는 0곳이에요.
- index CSS: `.theme_dark` 153곳, `[data-theme=…]` 0곳이에요.

## 색 토큰

다크는 vendor CSS의 `:root`, 라이트는 `[data-theme=light]` 값이에요. CSS의 `#fff`는 `#ffffff`로 적었어요. 두 `static` 토큰은 라이트 블록에서 다시 정의하지 않으므로 두 테마가 같아요.

| 역할                | 치지직 토큰                                       | 다크        | 라이트      | 공통 변수                   |
| ------------------- | ------------------------------------------------- | ----------- | ----------- | --------------------------- |
| 페이지 배경         | `--sem-color-background-neutral-base`             | `#141517`   | `#ffffff`   | `--bct-bg`                  |
| 패널·카드 면        | `--sem-color-surface-neutral-weaker`              | `#1c1d1f`   | `#ffffff`   | `--bct-surface`             |
| 약한 면(입력·검색)  | `--sem-color-surface-neutral-weak`                | `#202224`   | `#f0f1f2`   | `--bct-surface-weak`        |
| 기본 면(배지·트랙)  | `--sem-color-surface-neutral-base`                | `#2e3033`   | `#e1e1e5`   | `--bct-surface-base`        |
| 마우스 올림         | `--sem-color-surface-interaction-lighten-hovered` | `#ffffff0d` | `#0000000d` | `--bct-hover`               |
| 약한 테두리         | `--sem-color-border-neutral-weak`                 | `#2e3033`   | `#d0d1d3`   | `--bct-border`              |
| 더 약한 테두리      | `--sem-color-border-neutral-weaker`               | `#202224`   | `#e1e1e5`   | `--bct-border-weaker`       |
| 기본 테두리         | `--sem-color-border-neutral-base`                 | `#4d4d4d`   | `#c0c1c2`   | `--bct-border-strong`       |
| 반투명 선           | `--sem-color-border-neutral-alpha-weak`           | `#ffffff26` | `#00000026` | `--bct-border-alpha`        |
| 더 옅은 반투명 선   | `--sem-color-border-neutral-alpha-weaker`         | `#ffffff1a` | `#0000001a` | `--bct-border-alpha-weaker` |
| 주 글자             | `--sem-color-content-neutral-primary`             | `#ffffff`   | `#0e0f10`   | `--bct-text`                |
| 본문 글자           | `--sem-color-content-neutral-cool-strong`         | `#c9cedc`   | `#2e3033`   | `--bct-text-body`           |
| 보조 글자           | `--sem-color-content-neutral-cool-base`           | `#9da5b6`   | `#4d4d4d`   | `--bct-text-muted`          |
| 흐린 글자           | `--sem-color-content-neutral-cool-weak`           | `#697183`   | `#6d6e70`   | `--bct-text-dim`            |
| 브랜드 글자(기본)   | `--sem-color-content-brand-base`                  | `#00e693`   | `#168f5c`   | `--bct-brand-text-base`     |
| 브랜드 글자(강)     | `--sem-color-content-brand-strong`                | `#00ffa3`   | `#23815a`   | `--bct-brand-text`          |
| 브랜드 채움         | `--sem-color-surface-brand-strongest-static`      | `#00ffa3`   | `#00ffa3`   | `--bct-brand`               |
| 브랜드 채움 위 글자 | `--sem-color-content-neutral-inverse-static`      | `#0e0f10`   | `#0e0f10`   | `--bct-on-brand`            |
| 브랜드 옅은 면      | `--sem-color-surface-brand-alpha-weak`            | `#00ffa326` | `#1bb37326` | `--bct-brand-weak`          |
| 위험                | `--sem-color-content-accent-red-strong`           | `#ff5454`   | `#e02020`   | `--bct-danger`              |
| 그림자(약)          | `--sem-color-shadow-base`                         | `#0003`     | `#0000000d` | `--bct-shadow-color`        |
| 그림자(강)          | `--sem-color-shadow-strong`                       | `#0000004d` | `#0000001a` | `--bct-shadow-color-strong` |

## 모서리·글꼴·그림자

- 모서리 토큰(vendor CSS `:root`): `--sem-radius-sm` 6px, `--sem-radius-md` 8px, `--sem-radius-lg` 12px, `--sem-radius-2xl` 20px, `--sem-radius-circular` 9999px예요. 확장 UI는 6·8·12·원형만 써요(`--bct-radius-sm`·`--bct-radius-md`·`--bct-radius-lg`·`--bct-radius-full`).
- 본문 글꼴 토큰 `--sem-typography-body-15-400-font-family`는 `Pretendard, -apple-system, sans-serif`예요. 두 CSS 모두 Pretendard `@font-face`가 없어요(0곳). index CSS에는 `Sandoll Nemony2` `@font-face`가 121곳 있어요. 확장은 패키지의 `vendor/fonts/PretendardVariable.woff2`를 `"BetterChzzk Pretendard"`로 한 번 선언하고 `--bct-font`로 써요.
- 그림자: index CSS에서 `--sem-color-shadow-*`를 쓰는 조합 중 가장 많은 것(15곳)은 `0 4px 4px 0 강, 0 4px 12px 4px 약`이에요. 다음은 `0 6px 6px (0) 강, 0 6px 18px 6px 약`(18곳)이에요. 공통 `--bct-shadow`는 첫 번째 조합이에요.

## 대비

WCAG 상대 휘도로 대체값을 계산했어요. 치지직 토큰 값도 같아요. 작은 글자(18px 미만)는 4.5:1 이상이 기준이에요.

| 글자                              | 다크: 배경 / 패널 면 / 약한 면 / 기본 면 | 라이트: 배경·패널 면 / 약한 면 / 기본 면 |
| --------------------------------- | ---------------------------------------- | ---------------------------------------- |
| `--bct-text`                      | 18.27 / 16.87 / 15.96 / 13.23            | 19.19 / 16.97 / 14.71                    |
| `--bct-text-body`                 | 11.61 / 10.72 / 10.14 / 8.41             | 13.23 / 11.70 / 10.15                    |
| `--bct-text-muted`                | 7.39 / 6.82 / 6.45 / 5.35                | 8.45 / 7.47 / 6.48                       |
| `--bct-text-dim`                  | 3.73 / 3.45 / 3.26 / 2.70                | 5.10 / 4.51 / 3.91                       |
| `--bct-brand-text`(강)            | 13.78 / 12.72 / 12.03 / 9.98             | 4.82 / 4.26 / 3.69                       |
| `--bct-brand-text-base`(기본)     | 11.08 / 10.23 / 9.68 / 8.03              | 4.10 / 3.63 / 3.15                       |
| `--bct-danger`                    | 5.78 / 5.34 / 5.05 / 4.19                | 4.78 / 4.22 / 3.66                       |
| `--bct-on-brand` on `--bct-brand` | 14.47                                    | 14.47                                    |

- 작은 브랜드 글자는 `--bct-brand-text`를 써요. 라이트 `#23815a`는 배경·패널 면에서 4.82예요. `--bct-brand-text-base`의 라이트 `#168f5c`(4.10)는 작은 글자에 쓰지 않아요.
- 다크의 작은 보조 글자는 `--bct-text-muted`(`#9da5b6`)를 써요. `--bct-text-dim`의 다크 `#697183`(3.45~3.73)은 작은 글자에 쓰지 않아요.
- 라이트의 작은 `--bct-brand-text`·`--bct-danger`는 약한 면·기본 면 위에서 4.5:1 미만이에요. 이 조합은 배경·패널 면 위에 두거나 18px 이상·굵은 글자로만 써요. 다크의 `--bct-danger`도 기본 면 위에서는 4.19예요.

## 공통 테마 모듈 반영

- `shared/uiTheme.js`가 위 표의 변수를 `:root`에 `var(--sem-…, 대체값)`으로 선언해요. 대체값 표는 이 파일 한 곳에만 있어요.
- 라이트 대체값은 `html.light`·`html[data-theme="light"]`, 다크 대체값은 `html.theme_dark`·`html[data-theme="dark"]`·`html[data-theme="theme_dark"]`에서 써요. 표식이 없으면 다크예요. 두 표식이 엇갈리면 뒤에 오는 다크 규칙을 따라요.
- 그 밖의 변수: `--bct-radius-sm`·`--bct-radius-md`·`--bct-radius-lg`·`--bct-radius-full`, `--bct-font`(`"BetterChzzk Pretendard", -apple-system, BlinkMacSystemFont, system-ui, "Malgun Gothic", sans-serif`), `--bct-shadow`, `--bct-focus-ring`(`--bct-brand-text`)이에요.

## 실제 Chrome 수동 점검(미확인)

- 홈·라이브 본문·다시보기·시청자 채팅 팝업에서 다크·라이트를 바꾼 뒤 `<html>`의 `class`·`data-theme`·`style.colorScheme` 값을 확인해요. 특히 본 화면 다크의 `data-theme`이 `dark`인지 `theme_dark`인지 기록해요.
- 같은 화면에서 `getComputedStyle(document.documentElement).getPropertyValue("--sem-color-background-neutral-base")`와 공통 테마를 요청한 뒤의 `--bct-bg`가 같은 색인지 확인해요.
- 공통 테마를 요청한 문서에 `#betterchzzk-ui-theme` `<style>`이 하나만 있고, 글꼴 요청이 `chrome-extension://` 주소로만 나가는지 네트워크 기록에서 확인해요.
