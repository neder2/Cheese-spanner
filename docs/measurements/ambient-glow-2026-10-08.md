# 앰비언트 효과 실제 Chrome 확인 요청 — 2026-10-08

상태: **실제 Chrome 부분 검증 완료 — DOM 측정·전체 화면·정량 성능 미확인.** 2026-10-08 컴퓨터 사용으로 확인한 결과와 증거를 아래에 기록했어요.

## 배경

`1.4.3` 브랜치에 `features/ambientGlow.js`를 추가했어요. 구현·자동 검사 범위는 [현재 상태](../tracking/status.md)와 [업무 규칙](../business-rules.md#앰비언트-효과)에 있어요. 작성 환경의 내장 브라우저가 `chzzk.naver.com`을 열지 못해서 실제 화면은 확인하지 못했어요. 이 문서는 실제 Chrome에서 확인할 항목과 기록 형식을 정해요.

구현의 화면 가정은 [2026-09-28 패널 너비 실측](panel-resize-2026-09-28.md)의 배치예요. 사이드바 `#sidebar`는 fixed·z-index 9999이고 채팅 `#aside-chatting`은 영상 `main`과 같은 가로 행에 있어요. 효과 레이어는 `body` 끝에 붙는 `#betterchzzk-ambient`(fixed, z-index 9999, `pointer-events:none`)예요. 같은 z-index에서 나중 순서라 사이드바 위에 그려진다는 가정은 **미측정**이에요.

## 실행 경계

- 사용자의 실제 Chrome에서 **새 탭**을 열어 확인해요. 기존 탭의 재생·로그인·계정 설정은 바꾸지 않아요.
- 코드·설정 스키마·테스트를 수정하지 않아요. 커밋·push도 하지 않아요. 문제를 발견하면 이 문서에 조건·증상·스크린샷을 기록해요.
- 확장 관리 페이지 접근이 막히면 우회하지 말고 막힌 사실을 기록해요. 전체 화면 API가 `not granted`로 거절되면 성공으로 기록하지 않아요.
- 확인이 끝나면 앰비언트 효과 설정을 확인 전 값(기본 꺼짐)으로 되돌려요.

## 준비

1. `chrome://extensions`에서 이 작업 트리(`1.4.3` 브랜치)의 치즈 스패너를 다시 로드해요. 확장 ID와 버전 표시를 기록해요.
2. 확장 설정 → `플레이어` → `시청 화면·멀티뷰` → **앰비언트 효과**를 켜고 강도 60%로 저장해요.
3. 진행 중인 라이브(`https://chzzk.naver.com/live/...`) 하나와 다시보기(`https://chzzk.naver.com/video/...`) 하나를 새 탭으로 열어요. 사용한 URL을 기록해요.

## 1. DOM·겹침 구조 측정

라이브 탭에서 일반 화면·사이드바 펼침 상태로 DevTools 콘솔에 아래 코드를 실행하고 출력 JSON 전체를 결과 절에 붙여요. 읽기만 하는 코드예요.

```js
(() => {
    const info = (el) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
            tag: el.tagName,
            id: el.id,
            cls: String(el.className).slice(0, 80),
            position: cs.position,
            zIndex: cs.zIndex,
            isolation: cs.isolation,
            transform: cs.transform,
            opacity: cs.opacity,
            filter: cs.filter,
            willChange: cs.willChange,
            contain: cs.contain,
        };
    };
    const chain = (el) => {
        const out = [];
        for (let node = el; node && node !== document.documentElement; node = node.parentElement) out.push(info(node));
        return out;
    };
    const rect = (el) => (el ? el.getBoundingClientRect().toJSON() : null);
    const layer = document.getElementById("betterchzzk-ambient");
    return JSON.stringify(
        {
            url: location.href,
            htmlClass: document.documentElement.className,
            viewport: [innerWidth, innerHeight, devicePixelRatio],
            layer: layer && {
                hidden: layer.hidden,
                ready: layer.getAttribute("data-bcam-ready"),
                style: layer.getAttribute("style"),
                rect: rect(layer),
                parent: layer.parentElement?.tagName,
                indexInBody: [...document.body.children].indexOf(layer),
            },
            player: rect(document.querySelector(".pzp-pc")),
            header: { rect: rect(document.getElementById("header")), chain: chain(document.getElementById("header")) },
            sidebar: {
                rect: rect(document.getElementById("sidebar")),
                chain: chain(document.getElementById("sidebar")),
            },
            chat: chain(document.getElementById("aside-chatting") || document.getElementById("vod-aside")),
            bodyChildren: [...document.body.children].map(info),
        },
        null,
        2
    );
})();
```

판단 기준: `#sidebar`와 `#betterchzzk-ambient` 사이의 조상 중 `z-index`가 auto가 아니거나 `isolation:isolate`·`transform`·`opacity<1`·`filter`·`will-change`·`contain:paint` 등으로 쌓임 맥락을 만드는 요소가 있으면 표시해요. 레이어가 사이드바 아래에 그려질 수 있는 근거예요.

## 2. 스크린샷

스크린샷은 `docs/measurements/ambient-glow-2026-10-08/`에 아래 파일명으로 저장해요. 브라우저 창 전체(헤더·사이드바·플레이어·채팅이 함께 보이게)를 찍고, 밝은 장면과 어두운 장면이 섞이지 않도록 가능하면 색이 뚜렷한 장면에서 찍어요.

| 파일명                      | 조건                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `live-dark-60.png`          | 라이브, 다크 테마, 사이드바 펼침, 일반 화면, 강도 60%                                  |
| `live-dark-off.png`         | 위와 같은 장면에서 앰비언트 효과 끔(비교용)                                            |
| `live-light-60.png`         | 라이브, 라이트 테마, 강도 60%                                                          |
| `live-dark-100.png`         | 다크, 강도 100%                                                                        |
| `live-dark-10.png`          | 다크, 강도 10%                                                                         |
| `live-dark-wide.png`        | 다크, 치지직 넓은 화면 모드                                                            |
| `live-dark-chat-folded.png` | 다크, 채팅 접기 상태                                                                   |
| `live-dark-collapsed.png`   | 다크, 사이드바 접힘(82px) 상태                                                         |
| `live-narrow-overlay.png`   | 창 너비 1200px 미만, 사이드바를 펼친 겹침 배치(검은 배경이 덮는 상태)                  |
| `live-dark-popup.png`       | 플레이어 가까이에서 치지직 메뉴·팝업(예: 채팅 설정 메뉴, 시청자 프로필 팝업)을 연 상태 |
| `vod-dark-60.png`           | 다시보기, 다크, 강도 60%, 페이지 맨 위                                                 |
| `vod-dark-scrolled.png`     | 다시보기를 아래로 스크롤해 플레이어 위쪽이 헤더 밑으로 들어간 상태                     |
| `vod-light-60.png`          | 다시보기, 라이트, 강도 60%                                                             |

## 3. 동작 확인

| 항목           | 확인 방법                                                                                                    | 기대 결과                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 번짐 범위      | `live-dark-60` 비교                                                                                          | 채팅·사이드바 가장자리 약 100~150px에 영상 색이 옅게 보이고 경계가 부드러워요 |
| 영상·헤더 가림 | 영상 화면·플레이어 컨트롤과 상단 헤더 확인                                                                   | 효과가 영상과 헤더 위에 보이지 않아요                                         |
| 입력 통과      | 효과가 보이는 채팅 왼쪽 가장자리의 메시지 클릭·스크롤, 사이드바 오른쪽 채널 클릭, 채팅 너비 조절 경계 드래그 | 모두 평소처럼 동작해요                                                        |
| 가독성         | 두 테마의 채팅 닉네임·본문, 사이드바 채널명                                                                  | 읽기 어려워지지 않아요                                                        |
| 장면 변화      | 장면이 바뀌는 순간 관찰                                                                                      | 깜빡임 없이 약 0.3초 안팎으로 색이 따라가요                                   |
| 전체 화면      | 전체 화면 진입·종료                                                                                          | 전체 화면 중 효과 없음, 종료 후 다시 표시                                     |
| 탭 전환        | 다른 탭으로 갔다가 돌아오기                                                                                  | 돌아오면 다시 갱신돼요                                                        |
| 방송 이동      | 사이드바에서 다른 라이브로 SPA 이동                                                                          | 이전 방송의 색이 남지 않고 새 영상 색으로 바뀌어요                            |
| 비재생 페이지  | 홈·전체 방송으로 이동(치지직 미니 플레이어 포함)                                                             | 효과가 사라져요                                                               |
| 설정 즉시 반영 | 시청 중 설정에서 강도 변경·끄기 후 저장                                                                      | 새로고침 없이 강도 변경·제거가 반영돼요                                       |
| 멀티뷰         | 멀티뷰를 켜고 보조 방송 추가                                                                                 | 메인 영상 색만 사용하고 보조 창 조작에 영향이 없어요                          |
| 부하(선택)     | Chrome 작업 관리자에서 탭의 CPU·GPU 메모리를 효과 켬/끔으로 30초씩 관찰                                      | 수치를 기록만 해요. 다른 탭 영향이 섞이면 그 사실도 적어요                    |

## 결과

### 실행 환경과 범위

- 실행: 2026-10-08 약 20:48~21:00 KST. 실제 macOS Chrome의 접근성 트리·화면·마우스·키보드로 조작했어요.
- Chrome `154.0.8037.98` 공식 빌드 arm64, macOS `27.0.1`(26A434). `chrome://version` 화면에서 확인했어요.
- 소스: `1.4.3`, HEAD `af08cf40bfe0b2f3f1fd72753bf4bf5e7003e3d8` 및 기존 미커밋 앰비언트 변경. manifest·package·실제 확장 표시는 **1.4.2**예요. 1.4.3 패키지 릴리스 검증이 아니에요.
- 확장 ID: `pahlbfkdkfhjapkempckkkfjfkkenfca`. 관리 페이지의 로드 위치 `~/문서/Codex/2026-10-01/task-2/Chzzk`와 새로고침 완료를 확인했어요. 별도 QA 프로필의 임시 1.4.2 확장(`foinmmfeoolmpndkelpknfamccnonckl`)은 검증 대상으로 사용하지 않았어요.
- 라이브 A: <https://chzzk.naver.com/live/a6c4ddb09cdb160478996007bff35296> (아라하시 타비).
- 라이브 B: <https://chzzk.naver.com/live/75cbf189b3bb8f9f687d2aca0d0a382b> (한동숙). A에서 사이드바로 이동했고, 멀티뷰의 메인으로도 사용했어요.
- 다시보기: <https://chzzk.naver.com/video/15569401> (아라하시 타비, 봉누도 2 클립보기). 새 탭에서 재생했고 00:13 부근에 일시정지해 테마·스크롤을 비교했어요.
- 기존 시청 탭 대신 새 탭에서 검증했어요. 코드·스키마·테스트·버전·커밋·push는 변경하지 않았어요.

### DOM·겹침 측정 JSON

**미수집.** DevTools 콘솔에 읽기 전용 상태 조회를 붙여넣었으나 Chrome이 “Don’t paste code into the DevTools Console…” 경고로 차단했어요. `allow pasting` 입력이나 다른 실행 경로로 우회하지 않았고 사용자 직접 처리를 요청했어요. 따라서 레이어 ID·computed style·body 순서·조상 stacking context·정확한 CSS viewport/DPR는 실측하지 않았어요. 아래 화면 관찰을 DOM 측정 성공으로 대신하지 않아요.

### 동작 확인 결과

| 항목                              | 결과           | 실제 근거와 한계                                                                                                                                                                                                                                   |
| --------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 확장 옵션·주입 효과               | 확인           | 해당 경로의 확장 재로드 후 앰비언트 OFF/60%를 확인하고 켰어요. 실제 번짐과 설정 변화에 따른 제거·재등장을 확인했어요. DOM 마커는 미수집이에요.                                                                                                     |
| 번짐 범위·사이드바 겹침           | 부분 확인      | 다크 일반 화면에서 사이드바 오른쪽·채팅 왼쪽과 플레이어 아래에 영상 색이 부드럽게 보여요. 정확한 100~150 CSS px 폭은 미측정이에요.                                                                                                                 |
| 강도 10/60/100·OFF                | 확인           | 라이브 A를 일시정지한 같은 영상 장면으로 네 화면을 저장했어요. 100%는 뚜렷하고 10%는 매우 옅어요. 각 저장 후 새로고침하지 않았어요.                                                                                                                |
| 영상·헤더 가림                    | 화면상 확인    | 일반 화면과 VOD 스크롤 화면에서 영상 안으로 번짐이 덮이지 않고 헤더도 유지돼요. DOM clip-path는 미측정이에요.                                                                                                                                      |
| 채팅·사이드바 입력                | 확인           | 채팅 가장자리 스크롤, 닉네임 프로필 팝업, 채팅 메뉴 열기, 사이드바 라이브 이동이 동작했어요. 채팅 전송·후원·차단·신고는 실행하지 않았어요.                                                                                                         |
| 채팅 너비 드래그                  | 확인           | 실제 마우스 드래그로 273→323px, 반대 드래그로 273px 복귀를 접근성 값에서 확인했어요. 원래 표시 폭으로 복원했지만 내부 저장값의 null 여부는 읽지 않았어요.                                                                                          |
| 두 테마 가독성                    | 부분 확인      | 관찰한 채팅·채널명은 읽을 수 있었어요. 라이트의 어두운 영상에서는 색보다 회색 음영이 눈에 띄므로 시각 수용 여부가 남아요. 밝은 VOD의 라이트 효과는 매우 옅어요.                                                                                    |
| 장면 변화·탭 전환                 | 부분 확인      | 라이브의 색 변화와 탭 복귀 후 효과 표시를 확인했어요. 연속 녹화·타임스탬프 분석을 하지 않아 0.3초 응답이나 무깜빡임은 확정하지 않아요. 숨긴 탭의 예약 중단도 미측정이에요.                                                                         |
| 넓은 화면·채팅 접기·사이드바 접기 | 확인           | 실제 컨트롤로 전환해 각 화면을 저장했어요. 기본 모드·채팅 표시·사이드바 펼침으로 복귀했어요.                                                                                                                                                       |
| 좁은 창·겹침 배치                 | 부분 확인      | macOS 창 메뉴의 왼쪽 절반 배치에서 사이드바를 펼쳤어요. 검은 오버레이와 사이드바가 보이고 색 번짐은 거의 식별되지 않아요. 스크린샷 너비 1514 물리 px이며 CSS 폭은 미측정이에요. 이전 창 크기로 복귀했어요.                                         |
| 메뉴·팝업                         | 확인           | 채팅 메뉴·프로필 팝업이 열리고 읽을 수 있었어요. 가능한 모든 팝업의 쌓임 순서를 증명하지는 않아요.                                                                                                                                                 |
| 전체 화면                         | 미확인         | 접근성 클릭과 화면 좌표 클릭 모두 일반 화면이 유지됐어요. API 오류 내용은 수집하지 못했으므로 `not granted`라고 단정하지 않아요. 진입·종료·중간 효과 숨김은 통과 처리하지 않아요.                                                                  |
| 라이브 SPA 이동                   | 부분 확인      | A→B 이동 후 A의 녹색 대신 B의 갈색 계열 효과를 관찰했어요. 전환 중 모든 프레임의 잔상 유무는 미측정이에요.                                                                                                                                         |
| 비재생 페이지·미니 플레이어       | 확인           | 전체 방송으로 이동한 화면에서 네이티브 미니 플레이어는 남고 주변 앰비언트 번짐은 보이지 않았어요.                                                                                                                                                  |
| 멀티뷰                            | 화면·조작 확인 | B 메인/A 보조를 추가했어요. 메인 주변 갈색 효과가 유지되고 보조 영상 주변에는 별도 번짐이 보이지 않았어요. 보조 일시정지를 실제 좌표 클릭해 버튼이 재생으로 바뀜을 확인한 뒤 재개·제거·멀티뷰 종료했어요. 내부 선택 video의 정체성은 미측정이에요. |
| CPU·GPU 부하                      | 미실행         | 정량 표본을 수집하지 않았어요. 성능·누수 통과로 보고하지 않아요.                                                                                                                                                                                   |

멀티뷰 버튼은 처음 접근성 목록에서 찾지 못했으나 저장한 화면에는 격자 아이콘이 있었어요. 이를 실제 좌표로 클릭해 검증을 완료했으며, 버튼 미표시 결함으로 분류하지 않아요. 일부 미디어 컨트롤의 접근성 클릭은 상태 변화가 없었고 좌표 클릭으로 다시 확인했어요.

### 스크린샷

요청한 13개 파일을 모두 [증거 폴더](ambient-glow-2026-10-08/)에 저장했어요. 일반 화면은 3024×1740 또는 3024×1742 물리 px이고 좁은 창은 1514×1764예요. 창 크기 복원 과정의 2px 차이 때문에 모든 이미지를 완전한 픽셀 단위 A/B로 취급하지 않아요. OFF/60/100/10은 같은 정지 영상이지만 채팅은 계속 변해요.

저장소에는 2026-10-08 커밋 때 용량을 줄이려고 같은 이름의 가로 1512px JPEG(품질 85)로 바꿔 넣었어요(PNG 원본 61MB → 약 6.4MB). 위 요청 표와 아래 수치 검토의 `.png` 이름은 원본을 가리키며, 수치는 원본 PNG에서 잰 값이에요. 원본 PNG는 작성 PC의 작업 트리에만 남아 있어요.

추가 증거:

- [멀티뷰](ambient-glow-2026-10-08/live-multiview.jpg)
- [멀티뷰 진입 아이콘](ambient-glow-2026-10-08/multiview-launcher.jpg)
- [채팅 프로필](ambient-glow-2026-10-08/live-chat-profile.jpg)
- [SPA 이동](ambient-glow-2026-10-08/live-spa.jpg)
- [전체 방송·미니 플레이어](ambient-glow-2026-10-08/non-playback.jpg)
- [전체 화면 진입 시도 — 일반 화면 유지](ambient-glow-2026-10-08/live-fullscreen-attempt.jpg)
- [설정 복원](ambient-glow-2026-10-08/settings-restored.jpg)

### 남은 문제와 원복

- 라이트 테마의 어두운 장면에서 회색 테두리처럼 보이는 음영을 관찰했어요(`live-light-60.png`). 읽기 불가나 입력 차단은 관찰하지 않았지만, 의도한 색 번짐으로 충분한지는 사용자 시각 검토가 필요해요. 검증 요청이므로 런타임을 조정하지 않았어요.
- DOM 쌓임 맥락 JSON, 실제 전체 화면, 정량 전환 시간·숨김 갱신·GPU 부하는 남아요. DOM 측정은 사용자가 Chrome 보안 경고를 직접 처리한 후 같은 절차로 재개할 수 있어요.
- 최종 UI에서 **앰비언트 OFF·강도 60%, 라이브 멀티뷰 OFF, 저장됨**을 확인했어요. 치지직 테마는 원래 다크로, 창은 이전 크기로, 사이드바·채팅은 펼침으로 되돌렸어요. 테스트 보조 방송도 제거했어요.
- 이 결과는 기능 화면의 부분 검증이며 릴리스 준비 완료 판정이 아니에요. 실행 코드 변경이 없어 런타임 테스트·전체 lint는 재실행하지 않고, 결과 문서의 포맷·링크·diff만 검사해요.

### 스크린샷 수치 검토 — 2026-10-08 Claude

위 PNG 원본(3024×1740, DPR 2 가정)에서 영역 평균 RGB를 읽었어요. 값은 sRGB 휘도(0~255)예요. 라이브 OFF·10·60·100은 같은 정지 장면이지만 채팅 내용은 달라서, 정적인 사이드바 메뉴·채팅 헤더·제목 줄만 비교했어요. 브라우저 DOM이 아니라 화면 픽셀에서 추정한 결과예요.

| 위치(플레이어 경계에서 CSS px) | OFF  | 10%  | 60%  | 100%  |
| ------------------------------ | ---- | ---- | ---- | ----- |
| 사이드바 2                     | 21.4 | 24.1 | 36.4 | 46.2  |
| 사이드바 30                    | 21.4 | 23.2 | 30.9 | 37.7  |
| 사이드바 70                    | 21.4 | 22.2 | 25.0 | 27.5  |
| 사이드바 110                   | 21.4 | 21.4 | 22.4 | 23.1  |
| 채팅 헤더 3                    | 21.4 | 24.9 | 40.8 | 54.2  |
| 채팅 헤더 60                   | 21.4 | 22.4 | 25.7 | 28.3  |
| 채팅 헤더 100                  | 21.4 | 21.4 | 22.4 | 22.9  |
| 플레이어 아래 5                | 15.4 | 24.5 | 69.3 | 105.6 |
| 플레이어 아래 60               | 15.4 | 18.6 | 34.5 | 47.2  |

- **사이드바 위 겹침:** 펼친 사이드바의 불투명 배경이 강도에 비례해 밝아졌어요. 같은 z-index에서 레이어가 사이드바 위에 그려진다는 가정은 화면상 성립해요. 1200px 미만 겹침 배치에서는 검은 오버레이 위로 효과가 보이지 않았어요. DOM 쌓임 맥락은 여전히 미측정이에요.
- **번짐 폭:** 체감되는 밝기 증가는 사이드바 약 70~90px, 채팅 약 60px까지예요. 요청 문서의 기대치였던 100~150px보다 좁아요. 10%는 경계에서도 +3 정도라 거의 보이지 않아요.
- **라이트 테마:** `live-light-60.png`의 사이드바 경계는 (213,216,215)로 흰 배경(약 252) 대비 약 15% 어두워요. R·G·B가 거의 같아 색 번짐보다 회색 그림자로 보이며, Codex의 관찰과 일치해요. `vod-light-60.png`의 밝은 영상에서는 효과가 거의 없어요(약 249).
- **팝업:** `live-chat-profile.png`의 프로필 팝업 왼쪽 끝이 (37,28,24)로, 효과 밖의 같은 표면(13,16,17)보다 갈색으로 밝아졌어요. 글자는 읽을 수 있어요.
- **멀티뷰 문제:** `live-multiview.png`에서 번짐 구멍이 전체 플레이어가 아니라 메인 타일 크기예요. 멀티뷰가 원본 플레이어(`[data-bcmv-native]`)를 `[data-bcmv-host="active"]` 안의 타일로 줄이기 때문이에요. 그래서 메인 타일 아래 멀티뷰 영역에 갈색 번짐이 생겼어요(타일 아래 약 (46,42,37)). 메인 타일 오른쪽 약 15 CSS px 옆의 보조 영상 왼쪽 부분도 계산상 번짐 범위에 들어가요. 픽셀 비교 기준 화면이 없어 보조 영상이 실제로 밝아졌는지는 확정하지 못했어요. 이는 효과가 영상 화면을 덮지 않는다는 기준과 어긋날 수 있어 후속 수정 대상이에요. 같은 날 사용자 결정으로 멀티뷰가 켜진 동안 효과를 표시하지 않도록 바꿨어요. 자동 회귀만 확인했고 실제 Chrome에서는 다시 확인하지 않았어요.

### 헤더 겹침 근거 — 2026-10-08 Claude

헤더 번짐을 허용한 뒤 사용자가 확장을 다시 로드하고 새로고침했지만 헤더에는 효과가 보이지 않았어요. 2026-09-30 기록의 [공개 CSS](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/index-DHEcEx1z.css)를 2026-10-08에 내려받아 확인했어요.

- `._container_1cyju_1`: `z-index:10000`, `height:60px`, `position:sticky`, 배경 `--sem-color-background-neutral-base`예요. 상단 헤더 컨테이너로 판단했어요. 딤 표시 중인 `._show_dimmed_1cyju_15`는 `z-index:9999`예요.
- 사이드바 `._container_1b725_2`는 `z-index:9999`, 겹침 배치의 펼침 `._is_expanded_1b725_12`는 `20000`이에요. 모달·딤·라이브 PiP 컨테이너는 `20000` 이상이에요.

당시 레이어는 `z-index:9999`라서 헤더 아래에 그려졌어요. 헤더와 같은 `10000`으로 올리고 `body` 마지막 자식 순서를 유지해 헤더와 사이드바 위에 그려지게 했어요. 당시에는 현재 치지직 페이지가 같은 CSS 파일을 참조하는지 확인하지 않았어요. 공개 자산의 후속 확인은 아래에 기록했으며, 헤더 위 표시와 헤더 메뉴의 겹침은 실제 Chrome 확인이 남아 있어요.

#### 현재 공개 CSS·JS 재확인 — 2026-10-08

확인 시각은 **2026-10-08 21:47~21:49 KST**예요. 비로그인 공개 HTML의 [홈](https://chzzk.naver.com/), [라이브 A](https://chzzk.naver.com/live/a6c4ddb09cdb160478996007bff35296), [다시보기](https://chzzk.naver.com/video/15569401)가 모두 아래 주소를 참조했어요. `modulepreload`는 HTML의 사전 로드 선언이며, 실행 중 동적으로 추가되는 자산 목록은 측정하지 않았어요.

| HTML 참조 종류                           | 공개 주소                                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| CSS (`stylesheet`)                       | [desktop-media-viewer.css](https://ssl.pstatic.net/static/nng/resource/p/static/css/desktop-media-viewer.css)              |
| CSS (`stylesheet`)                       | [common-vendor-Xm3YENXW.css](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/common-vendor-Xm3YENXW.css)    |
| CSS (`stylesheet`)                       | [player-vendor-BDJ3c8a1.css](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/player-vendor-BDJ3c8a1.css)    |
| CSS (`stylesheet`)                       | [vendor-DVDNLy6N.css](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/vendor-DVDNLy6N.css)                  |
| CSS (`stylesheet`, 현재 메인 CSS)        | [index-B5SHICxp.css](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/index-B5SHICxp.css)                    |
| JS (`script type="module"`, 현재 진입점) | [index-VdvK-ysl.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-VdvK-ysl.js)                       |
| JS (`script`)                            | [desktop-media-viewer.min.js](https://ssl.pstatic.net/static/nng/resource/p/static/js/desktop-media-viewer.min.js)         |
| JS (`script`)                            | [refresh-detector-obfuscated.js](https://ssl.pstatic.net/static/nng/sdk/refresh-detector-obfuscated.js)                    |
| JS (`modulepreload`)                     | [rolldown-runtime-CJJwijRH.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/rolldown-runtime-CJJwijRH.js) |
| JS (`modulepreload`)                     | [common-vendor-pcHQV1G2.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/common-vendor-pcHQV1G2.js)       |
| JS (`modulepreload`)                     | [player-vendor-B7YwD4RF.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-B7YwD4RF.js)       |
| JS (`modulepreload`)                     | [vendor-rOHzekiX.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/vendor-rOHzekiX.js)                     |
| JS (`modulepreload`)                     | [date-vendor-DhkCJ9xZ.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/date-vendor-DhkCJ9xZ.js)           |

현재 메인 CSS는 기존 근거의 `index-DHEcEx1z.css`에서 **`index-B5SHICxp.css`로 바뀌었어요.** 두 CSS 원문의 아래 9개 `z-index` 선언을 대조했으며, 선택자·조건·값이 모두 같아요.

| 대상·선택자                                              | 적용 조건                   | 이전 CSS `z-index` | 현재 CSS `z-index` |
| -------------------------------------------------------- | --------------------------- | ------------------ | ------------------ |
| 헤더 `._container_1cyju_1`                               | 기본 규칙                   | `10000`            | `10000`            |
| 딤 표시 헤더 `._container_1cyju_1._show_dimmed_1cyju_15` | 딤 표시 클래스              | `9999`             | `9999`             |
| 사이드바 `._container_1b725_2`                           | 기본 규칙                   | `9999`             | `9999`             |
| 펼친 사이드바 `._is_expanded_1b725_12`                   | `@media (max-width:1199px)` | `20000`            | `20000`            |
| 모달 `._modal_1s3xv_1`                                   | 기본 규칙                   | `20000`            | `20000`            |
| 딤 `._dimmed_jao35_2`                                    | 기본 규칙                   | `20000`            | `20000`            |
| PiP `._container_wj4te_1._type_pip_wj4te_20`             | PiP 클래스                  | `20000`            | `20000`            |
| 라이브 PiP `._container_z51yg_1._type_pip_z51yg_60`      | PiP 클래스                  | `20000`            | `20000`            |
| 고정 컨테이너 `._container_uh6cg_1`                      | 기본 규칙                   | `20001`            | `20001`            |

헤더의 `height:60px`·`position:sticky`·배경 `var(--sem-color-background-neutral-base)`와 사이드바의 `position:fixed`도 같아요.

같은 날 **2026-10-08 KST에 두 `index-*.css` 원문 전체를 추가로 대조했어요.** 위 9개 겹침 규칙은 그대로지만 전체 CSS가 동일한 것은 아니에요. 클래스 해시가 바뀐 묶음은 20개이며, 예를 들면 `lcsnt`→`bhwhs`, `182bn`→`y6scg`, `126f6`→`18byk`예요. 클래스 해시와 줄 번호만 바뀐 부분을 구분하고, 실제 선언·조건이 달라진 주요 규칙을 아래에 기록했어요. 비교 범위는 위 두 메인 CSS이며 다른 CSS 번들·JS 동작 전체의 호환성 검증은 아니에요.

| 확인한 차이              | 이전 CSS                                                                            | 현재 CSS                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 색상 변수 삭제           | `html`·`html.theme_dark`에 `--color-bg-chzzk-04`, `--color-content-11` 정의         | 두 변수의 정의 삭제                                                                                                                                                                               |
| 색상 변수 추가           | `:root`에 해당 정의 없음                                                            | `--sem-color-surface-accent-red-base-rgb:255, 0, 0` 추가                                                                                                                                          |
| 툴팁 표시 조건           | `._container_182bn_2:has(span[class^=badge_tooltip],div[class^=tooltip_layer])`     | `._container_y6scg_2:has([role=tooltip])`로 변경. `overflow:visible`과 내부 여백 보정값은 유지                                                                                                    |
| 프로필 클릭 영역         | `._container_126f6_2`에 해당 위치 선언·클릭 영역 클래스 없음                        | `._container_18byk_2`에 `position:relative`, `._open_profile_button_18byk_62`에 `position:absolute;top:0;bottom:0;left:0;right:0` 추가                                                            |
| 광고 미니 화면           | `.pre_ad_mini` 규칙 없음                                                            | `overflow:hidden`, `z-index:1001!important`, `width:353px!important`, `height:198px!important`, `position:fixed!important`, `top:44px!important`, `left:auto!important`, `right:0!important` 추가 |
| 광고 미니 영상 크기      | `.pre_ad_mini #preAdVideoContainer` 규칙 없음                                       | `width:100%!important;height:100%!important` 추가                                                                                                                                                 |
| 광고 링크 표시           | 해당 세 조건을 묶은 규칙 없음                                                       | `.mid_ad_mini [data-role=adLink]`, `.pre_ad_mini [data-role=adLink]`, `.hidden_ui.scroll_pip.miniplayer [data-role=adLink]`에 `display:none!important` 추가                                       |
| 일부 배지 배경 흐림      | `._container_lcsnt_2`에 `backdrop-filter:blur(100px)`와 접두사 선언                 | 대응하는 `._container_bhwhs_2`에서 두 흐림 선언 삭제                                                                                                                                              |
| 일부 시간 표시 배경 흐림 | `._time_ji1oh_203`, `._time_9gqw1_121`에 `backdrop-filter:blur(50px)`와 접두사 선언 | 대응하는 `._time_1sgc2_203`, `._time_1g304_121`에서 두 흐림 선언 삭제                                                                                                                             |
| 음소거 표시 조건         | 해당 라이브·VOD 조건을 묶은 규칙 없음                                               | `.type_live .pzp-pc:not(.pzp-pc--muted) .pzp-pc__mute-indicator`, `.type_vod .pzp-pc:not(.pzp-pc--muted) .pzp-pc__mute-indicator`에 `display:none` 추가                                           |

저장소의 JS·CSS·HTML에서 의존성·vendor 파일을 제외하고 검색했을 때, 삭제된 색상 변수 두 개와 변경된 이전 클래스 해시 20개를 직접 참조하는 곳은 없었어요. 이 직접 참조 확인에서는 확장 선택자·색상 변수의 파손을 찾지 못했지만, 현재 DOM 구조와 모든 기능의 정상 동작을 확인한 결과로 확대하지 않아요.

실제 화면에서 남은 확인은 앰비언트 레이어를 `10000`으로 올린 상태의 **헤더 메뉴·프로필 팝업·광고 미니 화면 겹침**이에요. `.pre_ad_mini`의 `1001`과 앰비언트의 `10000`만 비교해 실제 위아래 순서를 확정할 수 없으며, 현재 조상 stacking context와 영상·조작부가 번짐에 덮이는지 확인해야 해요. 공개 CSS에서 광고 미니 화면 규칙을 찾은 사실은 기존 PiP 컨테이너의 `20000` 규칙과 구분해요.

위 결과는 공개 CSS 선언과 저장소의 직접 참조 확인이며, 현재 DOM의 computed style·조상 stacking context·실제 겹침을 검증한 결과는 아니에요. 받은 HTML·CSS 원문은 메모리에서만 읽었고 저장소에 파일로 넣지 않았어요.
