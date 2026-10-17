# 공용 기반 작업 지침

## 책임과 실행 컨텍스트

`shared/`는 기능 간 계산·설정·저장 계약을 제공해요. 디렉터리 전체가 DOM 독립 모듈인 것은 아니에요. 서비스 워커에 추가할 파일은 실제 의존성을 확인하고 `window`·`document`를 무가드로 사용하지 않아요.

| 소유 파일                                    | 책임·경계                                                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.js`                                | 옵션 스키마·기본값·정규화·최초 로드 공유·변경 구독을 소유해요. 기능 UI와 권한 요청을 넣지 않아요                                              |
| `data.js`                                    | 응답·URL·날짜·시청 구간·제목 정규화, fetch·storage·댓글 공용 요청을 제공해요. 기능별 DOM·페이지 상태를 보관하지 않아요                        |
| `categoryExclusions.js`                      | 카테고리 정체성·상태·명령 검증과 워커의 독립 local 저장 큐를 소유해요. 이름 검색·목록 DOM·시청 기록은 맡지 않아요                             |
| `selectors.js`                               | isolated용 선택자 체인·제한된 진단을 제공해요. MAIN에서 이 전역에 접근할 수 있다고 가정하지 않아요                                            |
| `vodTimeline.js`                             | 상세 정규화·분할 방송 연결 계산을 소유해요. fetch 자체는 호출자가 주입하고 UI·저장소를 다루지 않아요                                          |
| `liveTiming.js`                              | 관측한 라이브 끝 보정과 현재 위치의 연속 버퍼만 계산해요. 시계·DOM·재생·저장은 호출자가 소유해요                                              |
| `volumeControls.js`, `volumeControlsPage.js` | 각 world에서 독립적으로 볼륨 hit test를 제공해요. 두 파일의 구현 일치와 별도 경로를 유지해요                                                  |
| `watchHistoryStore.js`                       | 시청 기록 mutation 검증·멱등 병합·삭제 시점·임시 ID 연결을 계산해요. 실제 쓰기는 background의 큐가 수행해요                                   |
| `watchHistoryBackup.js`                      | 시청·내 채팅의 파일 투영·엄격 검증·요약을 담당해요. 후원·설정·인증 정보와 저장 호출을 넣지 않아요                                             |
| `watchHistoryBackupMerge.js`                 | 백업 병합·불확실 항목 분류·파일에 한정한 삭제 복원 범위를 계산해요. 파일 입출력과 실제 저장은 맡지 않아요                                     |
| `watchHistoryBackupController.js`            | 워커에서 기록 페이지의 발신 문서·확인 토큰·요청 순서를 조정해요. 주입된 기존 기록 큐와 writer만 사용해요                                      |
| `donationHistory.js`                         | 본인 일반 후원의 월별 정규화·조회 범위·통합 표시 계산을 제공해요. 시청 세션을 생성하지 않아요                                                 |
| `donationHistoryImport.js`                   | background의 사용자 시작 조회·취소·계정 재확인을 소유해요. 결과 저장은 주입된 기록 writer로만 해요                                            |
| `liveStart.js`                               | 등록 채널과 live-detail의 검증을 공유해요. 순수 검증에서 알림·탭 효과를 실행하지 않아요                                                       |
| `liveStartMonitor.js`                        | background의 독립 작업 큐·alarm·상태 저장·알림·탭 동작을 소유해요. 페이지 관찰자나 시청 기록 큐를 대신하지 않아요                             |
| `adVideoRegistration.js`                     | 저장 옵션과 동적 MAIN 등록을 일치시켜요. 플레이어의 실제 광고 처리 코드를 넣지 않아요                                                         |
| `settingsBackup.js`                          | 백업 대상 키 목록·콘텐츠 쓰기 허용 목록·값 검증·설정 파일 형식·적용 단계 계획을 계산해요. 저장 호출을 넣지 않아요                             |
| `settingsStore.js`                           | 워커의 설정 저장 큐(발신자·키·값·기대값 검증)와 설정 파일 내보내기·미리보기·적용·되돌리기를 설정 저장 잠금 안에서 해요                        |
| `followingFolders.js`                        | 팔로잉 폴더 저장값의 엄격 검증과 개별 변경 명령 계산이에요. DOM·chrome 비의존으로 콘텐츠와 워커에서 로드해요                                  |
| `followingTitleHistory.js`                   | 팔로잉 라이브 제목 이력 저장값 정규화·목록 응답 해석·조회 병합이에요. DOM·chrome 비의존으로 콘텐츠와 워커에서 로드해요                        |
| `followingTitleCollector.js`                 | 워커의 1분 알람·목록 조회(일반 치지직 탭 우선, 탭이 없거나 실패하면 같은 알람에서 워커)·제목 이력 단일 저장이에요. 페이지 DOM을 다루지 않아요 |
| `chatMultiview.js`                           | 채팅 멀티뷰 구성 검증·변경과 네이티브 채팅 프레임 주소 계산이에요. DOM·chrome 비의존으로 콘텐츠와 워커에서 로드해요                           |
| `uiTheme.js`                                 | 치지직 안 확장 UI의 공통 `--bct-*` 변수·대체값 한 벌·확장 글꼴 선언이에요. isolated 전용이며 기능별 모양·표시 조건은 넣지 않아요              |

## 변경 시 지켜야 할 조건

- 옵션 키는 스키마에서 파생해요. 소비자가 별도 기본값을 새 공급원으로 만들지 않아요. 과거 `chatToolsEnabled` 변환은 기존 선택을 보존하지만, 폐기·미공개 옵션이 같은 이름의 새 기능을 자동 활성화하게 만들지 않아요.
- `data.js`는 기존 utils와 병합돼야 해요. 콜백 storage 오류를 그 콜백 안에서 읽고, 실패한 읽기를 빈 저장소로 취급해 원래 데이터를 덮어쓰지 않아요.
- `liveTiming.js`도 기존 utils를 보존해요. 멀티뷰와 스트림 정보가 같은 경계 관측 원칙을 사용하되 저장 목표 딜레이·seek 행동은 계산 함수에 넣지 않아요. 경계 전진 관측 전·소스 변경·역행·오래된 시계는 측정 대기이고, 버퍼 결측과 관측한 0은 달라요.
- 시청 세션은 절대값 스냅샷이에요. 재전송·여러 탭·세션 정리 뒤의 늦은 응답에도 중복 누적하지 않아요. 삭제·전체 초기화·임시 ID 연결·보관 상한이 조합될 때 삭제한 기록이 복원되지 않아야 해요.
- 기록·활동·제목·시청 구간의 입력 길이와 개수 상한을 읽기·쓰기 모두에서 적용해요. 과거 데이터가 검증됐을 것이라고 가정하지 않아요. 방송별 기록과 동시 시청을 합친 전체 합계는 구분해요.
- 백업은 원본 시청·채팅만 내보내고 현재 후원은 보존해요. 같은 파일의 재적용과 구형 합계의 불확실한 병합을 구분해요. 복원 범위를 방송 전체 삭제 예외로 확대하거나 삭제·퇴역 장벽을 낮추지 않아요. `chatCutoffAt`과 `backupRestore`의 정리·명시 삭제·늦은 ID 연결 경로를 함께 검증해요.
- 후원 갱신은 빈 달도 완료된 조회로 보관해요. 계정 변경·페이지 변화·취소·한도 초과 시 월 일부와 조회 완료 상태를 저장하지 않아요. 같은 금액·내용의 별개 후원을 문자열로 합치지 않아요.
- 방송 시작은 첫 관측·재시작을 기준화해요. 처리 상태 저장 뒤 효과를 실행하는 현재 방침을 유지하며 실패한 알림·자동 입장을 같은 방송에 자동 재시도하지 않아요. 이미 열린 `url` 또는 `pendingUrl`의 동일 방송·대기 탭을 확인해 중복 생성하지 않아요.
- 동적 광고 등록은 빠른 옵션 변경 중에도 마지막 저장값으로 수렴해야 해요. 자신이 소유한 등록만 바꾸고 기존 descriptor의 불필요한 CSS·제외 경로·프레임 주입도 검사해요.
- 취소된 공유 요청이 다음 세대의 캐시를 채우거나 지우지 않게 해요. AbortError만으로 외부 취소를 단정하지 않아요. KST 날짜 계산, 17시간 분할 관측 모델, 실제 미디어 범위를 서로 혼용하지 않아요.
- 선택자 체인을 쉼표 목록으로 합치지 않아요. 우선순위가 문서 순서로 바뀔 수 있어요. URL 허용 목록을 확장할 때 실제 호스트·용도·소비 지점을 확인해요.

## 설정 저장 경계

백업 대상 키의 writer는 모두 확장 출처 Web Lock `betterchzzk:options-storage` 안에서 최신 값을 읽고 써요. 옵션 페이지·워커는 `withOptionsStorageLock`을 직접 쓰고, 콘텐츠는 `settingsStoreSet`으로 워커 큐에 요청해요. 잠금을 잡은 채 네트워크 요청을 기다리지 않아요(방송 대상 채널 조회는 잠금 밖). 설정 파일 적용은 잠금을 한 번 잡은 상태에서 최신 값·미리보기 지문 비교·단계별 쓰기·되돌리기까지 끝내고, 효과 옵션은 끄는 쪽 먼저·켜는 쪽 마지막이에요. 잠금 밖 변경(다른 기기 Chrome sync)이 관측된 키는 이후 단계에서 쓰지 않고 되돌리지도 않으며 결과에 따로 알려요. 시청 기록·카테고리 제외·안내 큐와 합치지 않아요.

회귀는 `tests/settings-store.test.js`(발신자·허용 목록·기대값 충돌·도착 순서·읽기와 쓰기 사이 끼어든 writer·잠금 없는 대조군·되돌리기 실패/충돌 구분), `tests/live-start.test.js`(복원 직후 진행 중 방송 기준화), `tests/options-settings-backup.test.js`(옵션 UI)와 기존 writer 테스트의 저장 흉내(`tests/helpers/settings-store-emulation.js`)가 보호해요.

## 카테고리 제외 저장

유형·ID는 원래 대소문자를 보존하는 정확한 쌍이에요. 태그 제외는 같은 형식에 예약 유형 `CHEESE_SPANNER_TAG`, 소문자 정규화 ID, 표시용 태그로 보관해 저장 키·버전·명령을 바꾸지 않아요. 이름을 바꿔 같은 유형·ID를 다시 추가해도 기존 표시 이름·순서를 갱신하지 않아요. 상태·명령의 허용 필드·버전·길이·최대 100개·중복을 엄격하게 검증하며 잘못된 값을 절삭하거나 빈 목록으로 저장하지 않아요.

같은 확장 ID의 정상 최상위 `/lives` 탭만 get·add·remove를 요청해요. 전체 목록 교체·초기화는 제공하지 않고 전용 큐에서 최신 local 값에 개별 변경을 적용해요. 시청 기록·새 기능 안내·방송 알림의 큐와 분리하고 각 storage 콜백 안에서 lastError를 읽어요. 변경한 revision은 저장 성공 뒤에만 응답하고, 같은 항목 추가·없는 항목 해제는 쓰지 않는 성공이에요. 읽기 실패·손상·상한·쓰기 실패에서도 기존 선택을 보존하며 큐의 다음 요청은 계속 처리해요.

이 공용 파일은 DOM 독립으로 워커와 isolated에서 각각 로드해요. MAIN 브리지·DOM 속성·합성 이벤트에서 특권 저장 명령을 받는 경로를 만들지 않아요. 저장소 키 삭제 뒤 늦은 응답을 막는 페이지 세대·revision 반영은 콘텐츠 소유이며 워커 큐의 개별 저장과 구분해요.

## 회귀 검증

설정은 `tests/settings.test.js`, `tests/options-page.test.js`, `tests/options-save-race.test.js`에서 키 일치·기본값·구형 저장값·저장 오류를 확인해요. 공용 storage·라우트·선택자는 `tests/extension-pages.test.js`, URL·구간 방어는 `tests/security-boundaries.test.js`, `tests/navigation-data.test.js`를 확인해요.

카테고리 제외는 `tests/category-exclusions-store.test.js`에서 순수 검증·실제 worker 로드·다중 탭 순서·콜백 실패·손상 보존·독립 큐를 확인해요. 소비자인 `tests/category-tools-exclusions.test.js`와 category-tools 모델·repository·lifecycle, extension-pages·refactoring-data-modules의 로드 순서도 함께 확인해요. 브라우저 재시작·실제 Chrome SPA 발신 정보는 합성 테스트 통과로 대신하지 않아요.

기록 변경은 `tests/watch-history-store.test.js`, `tests/watch-activity.test.js`, `tests/donation-history-import.test.js`에서 재전송·삭제 경합·다중 탭·소유 계정·활동만 저장하는 경로를 확인해요. 분할 방송은 `tests/vod-timeline.test.js`와 실제 통계·시계 소비자 회귀도 함께 실행해요.

알림은 `tests/live-start.test.js`, 등록은 `tests/live-start-registration.test.js`, 동적 스크립트는 `tests/ad-video-registration.test.js`를 확인해요. world·단일 writer·로컬 실행 코드 경계는 `tests/release-safety.test.js`가 보호해요.

공용 계산·유틸의 작은 변경은 직접 테스트와 영향을 받는 소비자 테스트, 변경 파일 lint·포맷 검사로 마쳐요. 설정 스키마·저장 형식·쓰기 큐·권한·발신자 검증·world·로딩 경계·manifest·의존성·검사 설정을 바꾸거나 영향 범위를 특정하기 어렵거나 여러 기능을 넓게 바꿨다면 전체 test:all·lint·format:check를 실행해요. 릴리스 전과 전체 검사 요청에도 전체 검증을 해요. 테스트는 `--test-concurrency=2`로 제한하고 검사 명령을 순차 실행하며 여러 테스트 묶음을 겹치지 않아요. 선택한 검사 범위와 전체 생략 이유를 남겨요.

## 치지직 안 공통 테마

`uiTheme.js`는 치지직 안 확장 UI의 색·모서리·그림자·글꼴 기준을 소유해요. 변수는 `:root`에 `var(--sem-…, 대체값)` 형태로 선언해 치지직 시맨틱 토큰을 그대로 따르고, 토큰이 없을 때만 대체값을 써요. 대체값은 `docs/measurements/chzzk-design-tokens-2026-10-17.md`의 실측값 한 벌이며 이 파일에만 둬요. 치지직 값이나 표식이 바뀌면 날짜가 있는 실측 기록을 남기고 이 표만 고쳐요.

- 대체값은 루트 표식으로 골라요. 라이트는 `html.light`·`html[data-theme="light"]`, 다크는 `html.theme_dark`·`html[data-theme="dark"]`·`html[data-theme="theme_dark"]`이고, 표식이 없으면 치지직 기본인 다크예요. 두 표식이 엇갈리면 뒤에 둔 다크 규칙이 이겨요. 근거 없는 `[class*="dark"]` 판별이나 `prefers-color-scheme` 분기를 추가하지 않아요.
- manifest isolated 목록에서 `content.js` 바로 뒤에 둬요. `content.js`의 `injectStyleOnce`를 쓰고, `shared/updateGuideView.js`와 모든 `features/*`보다 먼저 로드돼야 해요. 더 앞에 로드되면 로드 순서 오류를 던지고 요청 함수를 등록하지 않아요. MAIN world·서비스 워커·확장 페이지(options·history·replay-pending)는 이 파일을 읽지 않아요. 확장 페이지는 `styles.css`의 자체 토큰을 써요.
- 요청 함수는 `BetterChzzk.utils`에 병합한 `ensureUiTheme()` 하나예요. 요청 전에는 아무것도 하지 않고, 첫 요청에 `#betterchzzk-ui-theme` `<style>` 하나를 `<html>`에 넣어요. 반복 요청은 아무것도 바꾸지 않아요. 이 스타일은 변수와 `"BetterChzzk Pretendard"` `@font-face`만 담아 그 자체로 보이는 효과가 없으므로, 기능을 꺼도 지우지 않아요.
- 글꼴 주소는 `chrome.runtime.getURL("vendor/fonts/PretendardVariable.woff2")`로 만든 패키지 파일이에요. 이 파일은 `web_accessible_resources`에서 치지직 출처에만 열려 있어요. 외부 글꼴 서버·원격 URL·`@import`를 추가하지 않고, 기능 안에 `@font-face`를 다시 선언하지 않아요.
- 확장 스타일이 들어간 UI를 다른 문서(예: 채팅 멀티뷰 칸 프레임)에 그리게 되면 그 문서에도 같은 정의가 있어야 해요. 지금 함수는 현재 문서만 다뤄요. 필요해지면 이 모듈이 대상 문서를 받도록 넓히고, 기능 안에 정의를 복사하지 않아요.

변수 이름은 다음과 같아요. 면 `--bct-bg`·`--bct-surface`(패널·카드·팝오버)·`--bct-surface-weak`(입력·검색)·`--bct-surface-base`(배지·트랙), 마우스 올림 `--bct-hover`, 테두리 `--bct-border`·`--bct-border-weaker`·`--bct-border-strong`·`--bct-border-alpha`, 글자 `--bct-text`·`--bct-text-body`·`--bct-text-muted`·`--bct-text-dim`, 브랜드 `--bct-brand-text`·`--bct-brand-text-base`·`--bct-brand`(채움)·`--bct-on-brand`·`--bct-brand-weak`, 위험 `--bct-danger`, 그림자 `--bct-shadow-color`·`--bct-shadow-color-strong`·`--bct-shadow`(팝오버·패널·툴팁 공통), 모서리 `--bct-radius-sm`(6)·`--bct-radius-md`(8)·`--bct-radius-lg`(12)·`--bct-radius-full`(원형), 초점 `--bct-focus-ring`, 글꼴 `--bct-font`이에요.

작은 글자(18px 미만)는 4.5:1을 지켜요. `--bct-text-dim`(다크 3.7:1)과 `--bct-brand-text-base`(라이트 4.1:1)는 큰 글자·비활성·글자가 아닌 표시에만 써요. 라이트의 작은 `--bct-brand-text`·`--bct-danger`는 `--bct-bg`·`--bct-surface` 위에서만 4.5:1을 넘고, 약한 면·기본 면 위에서는 기준에 못 미쳐요.

회귀는 `tests/ui-theme.test.js`(요청 전 미주입·1회 주입·변수와 글꼴만 선언·원격 URL 없음·표식별 대체값·대비·로드 순서), `tests/release-safety.test.js`(MAIN 제외·isolated 포함), `tests/extension-pages.test.js`의 manifest 순서 검사가 보호해요. 로딩 순서를 바꾸면 전체 검증을 해요.

## 새 기능 안내 공용부

updateGuide.js는 현재 버전과 정확히 일치하는 로컬 설명 자료, updateGuideController.js는 워커의 독립 큐·local 상태·문서 토큰, updateGuideView.js는 자동·수동에서 함께 사용하는 한 창의 비모달 안내 내용을 소유해요. 항목을 동시에 표시하고 닫기 버튼 하나를 제공하며 페이지 넘김·설정 이동·위치 강조를 만들지 않아요. view는 DOM에 의존하므로 워커에 로드하지 않아요. 시청 기록 큐나 MAIN 재생 코드와 합치지 않아요.

소비 저장 성공 전에는 표시를 승인하지 않고, 상태 손상·읽기 실패·이전 문서·만료된 토큰을 거부해요. OFF/ON 경합과 워커 재시작에서 pending의 소급 표시를 막아요. options.html의 허용 목적지 fragment는 settings.js의 공용 발신자 검증을 통해 광고 등록·방송 등록에서도 같은 경계를 지켜요.
