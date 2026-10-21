# 1.4.5 릴리스 준비 검증

## 상태

2026-10-21 KST 사용자 요청("일단 버전 다 올려놓고 안내 문구 추천 해줘", "a로 ㄱㄱ", "자체적으로 테스트해")으로 버전·안내·문서와 자동 검증, 분리 프로필 실제 업데이트 점검, 임시 배포 ZIP 대조까지 Claude가 수행했어요. 남은 필수 점검 항목은 같은 날 사용자가 실제 Chrome에서 직접 확인했다고 알렸어요("남은 항목 직접 확인했어", [사용자 확인](#사용자-확인-2026-10-21)). 이어서 사용자 요청("커밋·push·태그 v1.4.5·Release(zip 첨부) 진행해", "집도 새로 만들어줘")으로 공개 날짜를 정하고 최종 ZIP을 다시 만들어 커밋·push·태그·GitHub Release를 진행해요. 스토어 제출·main 병합은 하지 않았어요.

- 이 기록 뒤 같은 날 **다시보기 내 채팅 강조**(`features/vodOwnChat.js`, 기본 켜짐)를 더했어요. 아래 1.4.4 대비 차이·임시 ZIP(파일 수·해시)·실제 업데이트 점검은 그 전 기준이라, 공개 전 ZIP을 다시 만들어 대조하고 [상태](tracking/status.md) 기록의 실제 화면 확인을 마쳐야 해요.
- 소스 기준: branch `1.4.5`, HEAD `1fc34fa`(원격 `1.4.5`와 같음)와 미커밋 변경(버전·안내·업데이트 내역·README·스토어 문구, 다른 세션의 `docs/tracking/findings.md` 기록).
- 환경: macOS 27.0.1, Node 24.15.0, Chrome for Testing 155.0.8059.12(Playwright 캐시의 `chromium-1247`), 세션 임시 폴더 `/tmp/cs145-5OHa`의 새 프로필. 사용자 Chrome·로그인·저장값은 쓰지 않았고 치지직은 로그아웃 상태예요.

## 1.4.4 대비 사용자 동작 차이

[업데이트 내역 1.4.5](update-history.md#145-2026-10-21)와 같아요: 방송 목록 필터 1단계, 방송 화면 제목 옆 이전 방제, 화면 디자인 통일(`shared/uiTheme.js` 추가), 화면 확대 단축키 방식, 새 설치의 볼륨 % 표시 켜짐, 광고·설치 안내 팝업 대응 보강과 프로필·신고 창 보호, 1.4.4에 있던 문제 수정. 새 권한·호스트·서드파티 코드는 없어요(manifest `permissions`·`host_permissions`·`optional_*`는 1.4.4와 같음). 새 저장은 사이트 탭 sessionStorage `betterChzzkListFilterSession`(목록 필터)이고, 기록 페이지 채널 사진은 공개 채널 정보를 조회만 해요(PRIVACY 반영됨).

## 버전과 안내 자료

- manifest·package·package-lock 루트(`version`, `packages[""].version`)를 1.4.5로 바꾸고 `tests/extension-pages.test.js`의 버전 기대값을 이전 릴리스와 같은 방식으로 바꿨어요.
- `shared/updateGuide.js` 1.4.5: 제목 `새 기능`, 요약 `방송 목록 필터 개선(이상·이하·범위, 보고 와도 유지), 방송 화면 제목 옆에서 이전 방제 확인`, 카드 없음. 2026-10-21 사용자가 추천 A안을 마침표 없이 반점으로 구분하도록 확정했어요. 같은 날 사용자 요청("문구에 짧게 넣어줘")으로 끝에 `, 다시보기에서 내 채팅 강조`를 더했어요(아래 실제 업데이트 점검은 더하기 전 문구로 했어요). `tests/update-guide-catalog.test.js`가 문구·카드 없음·마침표 없음을 고정해요.
- `docs/update-history.md` 1.4.5 절(날짜는 공개 때 정해요), README 버전·`1.4.5 변경 사항`·목록 필터 기준값 설명, 스토어 설명 2줄과 개인정보 관행 문서 버전을 고쳤어요.

## 자동 검증

| 명령                                       | 결과                                                    |
| ------------------------------------------ | ------------------------------------------------------- |
| `npm run test:all -- --test-concurrency=2` | 1,874개 통과, 실패·취소 0, 종료 코드 0                  |
| `npm run lint`                             | 종료 코드 0                                             |
| `npm run format:check`                     | 범위 밖 기존 `.claude/settings.local.json`만 실패(보존) |
| `git diff --check`                         | 종료 코드 0                                             |

스토어 문구 수정 뒤 `release-safety`·`extension-pages`·`update-guide-catalog` 146개를 다시 통과했어요.

## 임시 배포 파일

최종 ZIP이 아니에요. `npx --no-install web-ext build --config web-ext-config.mjs --artifacts-dir /tmp/cs145-5OHa/artifacts --filename "cheese_spanner-1.4.5.zip"`: 2,945,464바이트, SHA-256 `2993e476217e1a88df68f23ef0a1c3c2a9f675fea5226b58717b7952950cefb5`, 122개 파일. 압축을 풀어 모든 파일이 작업 트리와 바이트 단위로 같고 manifest가 1.4.5이며 확정 문구가 `shared/updateGuide.js`에 들어 있어요. 1.4.4 배포 ZIP(121개) 대비 추가는 `shared/uiTheme.js` 하나이고 빠진 파일은 없어요. 테스트·문서·스토어 자료·package 파일·숨김 파일·`features/adAutoSkip.js`·`features/updateNotice.js`는 없어요.

### 배포 ZIP (내 채팅 강조·안내 문구 추가 뒤)

2026-10-21 사용자 요청("zip 만들고 릴리즈 노트 올려")으로 `npx --no-install web-ext build --config web-ext-config.mjs --filename "cheese_spanner-1.4.5.zip"`을 실행해 `web-ext-artifacts/cheese_spanner-1.4.5.zip`을 만들었어요(같은 이름의 기존 파일 없음). 2,949,035바이트, SHA-256 `51feffb1144e110674cdaaca875dd7f754638ed26e476bd457f62e3df9428cd1`, 123개 파일. 압축을 풀어 모든 파일이 작업 트리와 바이트 단위로 같고, manifest 1.4.5, `shared/updateGuide.js`에 `다시보기에서 내 채팅 강조`가 들어간 요약이 있어요. 1.4.4 배포 ZIP 대비 추가는 `features/vodOwnChat.js`·`shared/uiTheme.js`이고 빠진 파일은 없으며 테스트·문서·스토어 자료·package·숨김 파일·`features/adAutoSkip.js`·`features/updateNotice.js`는 없어요. 직전 검증: `test:all -- --test-concurrency=2` 1,879개 통과(종료 0), `lint`·`git diff --check` 통과. 이 ZIP으로 실제 업데이트 점검은 아직 하지 않았어요.

## 실제 업데이트 점검 (Chrome for Testing, Claude가 CDP로 조작)

방법: 실제 배포 파일 `web-ext-artifacts/cheese_spanner-1.4.4.zip`을 풀어 새 프로필에 `--load-extension`으로 설치하고, 같은 경로의 내용을 위 1.4.5 임시 ZIP으로 바꾼 뒤 확장을 다시 로드했어요. Node 내장 WebSocket으로 CDP에 붙어 탭·입력을 조작했어요(스크립트는 세션 임시 폴더).

- 1.4.4 새 설치: 안내 상태 `{"status":"suppressed","version":"1.4.4"}`, 치지직 홈에 안내 없음(새 설치 제외).
- 업데이트: 명령줄로 로드한 확장을 `chrome.runtime.reload()`로 다시 로드하면 `unsupportedDeveloperExtension`으로 꺼졌어요(테스트 환경 제약). 이 프로필의 개발자 모드를 켜고 `developerPrivate.reload`로 다시 로드하자 1.4.5가 되고 상태가 `{"status":"pending","version":"1.4.5"}`로 바뀌었어요(onInstalled `update`, 1.4.4→1.4.5).
- 최초 1회·한 탭: 새 `/lives` 문서(앞)와 `/category` 문서(뒤)를 함께 열자 앞 탭에만 1.5초 안에 안내가 나타났고 뒤 탭(숨김)에는 없었어요. 문구는 `치즈 스패너 1.4.5 새 기능` / 확정 요약, 닫기 `×` 하나예요. 표시 뒤 상태는 `seen`이고, 그 탭 새로고침과 새 치지직 탭에서 다시 나타나지 않았어요.
- 20초·게이지·호버: 게이지가 3초 뒤 약 0.83으로 줄었고, 호버한 6.4초 동안 그대로였어요. 표시부터 27.0초, 호버를 뗀 뒤 17.1초에 닫혀 남은 시간만 이어 갔어요.
- 초점: Chrome for Testing 창이 OS 초점을 잃은 동안(`document.hasFocus()` false)에는 새 문서에 자동 안내를 띄우지 않았고, 이미 떠 있던 다시보기 창의 타이머도 멈춰 있었어요. 이후 확인은 탭에 `Emulation.setFocusEmulationEnabled`를 켜고 상태를 `pending`으로 되돌려 반복했어요(테스트 프로필 저장값만 바꿈).
- 배치: `/lives`에서는 오른쪽 자리가 확장의 `현재 목록 검색` 입력과 겹쳐 왼쪽(x=12, y=72)에 놓이며 사이드바 메뉴·`전체 방송` 제목·라이브/동영상 탭 일부를 20초 동안 덮어요(입력·영상·컨트롤을 피하는 기존 규칙대로). 처음 스크린샷이 비쳐 보인 것은 0.18초 등장 애니메이션 중 캡처였고, 다시 잰 값은 opacity 1·배경 `rgb(28, 29, 31)`이에요.
- 동작 줄이기: `prefers-reduced-motion: reduce`에서 게이지가 1초마다 0.05씩 계단으로 줄었어요.
- 좁은 폭: 420px 화면에서 위 여백 64px, 300px 폭으로 화면 안에 들어왔어요.
- Escape: 안내 안 닫기 버튼에 초점을 둔 뒤 Escape로 닫혔어요.
- 라이트·다크: 치지직 자체 테마를 라이트로 바꾼 문서에서 배경 흰색·글자 `rgb(14, 15, 16)`, 다크에서 배경 `rgb(28, 29, 31)`·글자 흰색으로 읽혔어요(스크린샷 확인).
- 다시보기: 일반 설정 탭에서 누르면 `치지직 화면에서 확장 아이콘을 열어 다시 눌러 주세요.`로 거절했어요. 확장 아이콘 팝업은 `chrome.action.openPopup()`이 `Could not find an active browser window.`로 열리지 않아 **팝업 경로는 확인하지 못했어요.** 같은 탭에 다시보기 창(`data-bcug-view`, 오른쪽 위, 불투명, 게이지)이 떠 있는 것을 관측했지만, 첫 시도 스크립트가 중간에 오류로 끝나 어떤 경로로 열렸는지 기록이 없어 근거로 쓰지 않아요.

## 필수 점검 상태 (`docs/operations.md`)

| 항목                     | 상태 | 근거·남은 확인                                                                                                                                                                               |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 버전과 내용              | 완료 | manifest·package·lockfile·안내 자료 1.4.5 일치, 업데이트 내역·README를 최종 코드와 대조, 문구 2026-10-21 사용자 확정                                                                         |
| 자동 검증                | 완료 | 위 표                                                                                                                                                                                        |
| 실제 업데이트와 최초 1회 | 완료 | Claude: 1.4.4 배포 ZIP→1.4.5 임시 ZIP 업데이트, 한 탭 표시, 시간 종료·새로고침·새 탭 미재표시. 사용자: 이 ZIP 기준 실제 업데이트, 닫기 버튼 뒤·브라우저 재시작 뒤·뒤로 가기 복원 뒤 미재표시 |
| 20초와 시청 방해 방지    | 완료 | Claude: 20초·게이지·호버 일시정지·초점 없는 동안 보류·숨은 탭 제외·동작 줄이기. 사용자: 키보드 초점 일시정지, 전체화면·입력 중 보류                                                          |
| 한 창 안내와 다시보기    | 완료 | Claude: 한 줄 표시·닫기·Escape·라이트/다크·좁은 폭. 사용자: 치지직 탭의 확장 아이콘 팝업 다시보기, 팝업을 닫은 뒤 유지, 자동 안내 OFF에서의 다시보기                                         |
| 배포 파일                | 완료 | [최종 ZIP](#최종-배포-zip)                                                                                                                                                                   |
| 검증 기록                | 완료 | 이 문서                                                                                                                                                                                      |

## 사용자 확인 (2026-10-21)

Claude가 남은 항목으로 알린 다음 내용을 사용자가 실제 Chrome에서 직접 확인했다고 알렸어요("남은 항목 직접 확인했어"). 항목별 세부 관측값은 받지 않았어요.

- 치지직 탭에서 확장 아이콘 팝업의 **다시보기** 표시, 팝업을 닫은 뒤 안내 유지, 자동 안내 OFF에서의 다시보기
- 닫기 버튼 뒤·브라우저 재시작 뒤·뒤로 가기 복원 뒤 같은 버전 안내 미재표시
- 전체화면·입력 중 새 자동 안내 보류, 키보드 초점 동안 타이머 일시정지
- 내 채팅 강조를 더한 1.4.5 ZIP 기준 실제 업데이트
- 로그인한 Chrome에서 다시보기 내 채팅 강조

필수 점검 밖인 [남은 확인 사항](tracking/findings.md) 2026-10-21 항목(디자인 통일의 라이트 테마·테마 전환, 오래된 탭 채널 식별 의심, 댓글 정상 목록)은 이번 확인 범위로 알리지 않았으므로 그대로 남겨요.

## 최종 배포 ZIP

2026-10-21 사용자 요청("집도 새로 만들어줘", "걍 덮어씌워")으로 공개 날짜 반영 뒤 `npx --no-install web-ext build --config web-ext-config.mjs --filename "cheese_spanner-1.4.5.zip" --overwrite-dest`를 실행해 `web-ext-artifacts/cheese_spanner-1.4.5.zip`을 덮어써 다시 만들었어요. 2,949,035바이트, SHA-256 `3e7bf3874ca20e654e32abfb1c1ae5f006bae9ba720961590f32e7c6d484a251`, 123개 파일. 압축을 풀어 모든 파일이 작업 트리와 바이트 단위로 같고, manifest 1.4.5, `shared/updateGuide.js`에 `다시보기에서 내 채팅 강조`가 들어간 요약이 있어요. 1.4.4 배포 ZIP 대비 추가는 `features/vodOwnChat.js`·`shared/uiTheme.js`이고 빠진 파일은 없으며 테스트·문서·스토어 자료·package·숨김 파일·`features/adAutoSkip.js`·`features/updateNotice.js`는 없어요. 직전 검증: `test:all -- --test-concurrency=2` 1,879개 통과(종료 0), `lint`·`git diff --check` 통과, 바꾼 문서 `prettier --check` 통과.
