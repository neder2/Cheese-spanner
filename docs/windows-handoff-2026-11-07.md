# Windows 작업 인수인계 — 맥 최신본과 선택 반영

작성일: 2026-11-07 (KST)

**사용자가 최신 개발본으로 지정한 맥 작업을 기준으로 삼아요.** 이 문서는 Windows 작업 폴더에 남아 있던 변경과, 이후 수행한 영상 녹화 복원을 구분한 비교 자료예요. Windows 브랜치나 작업 폴더 전체를 맥에 병합·복사하는 지시가 아니에요. 이번 GitHub 업로드 대상은 이 문서 한 파일뿐이에요.

맥의 현재 미커밋 파일은 직접 확인하지 못했어요. 아래 GitHub 상태는 원격 조회로 확인한 사실이고, 맥 작업 폴더 전체가 그 상태와 같다는 뜻은 아니에요.

## 1. 비교 기준과 이력이 갈라진 지점

| 구분                          | 확인한 상태                                             |
| ----------------------------- | ------------------------------------------------------- |
| Windows 브랜치                | `1.4.7`                                                 |
| Windows HEAD                  | `8cbf2f5657bb2a92fe6c076c47046284ccec2e7d` — 2026-11-02 |
| 문서 추가 전 GitHub `1.4.7`   | `4bef5e0a22a70461a945df4eb4140bb24379cc07` — 2026-11-05 |
| 두 이력의 공통 조상           | `a7f366d9241b08a04f26b1fbab8cda57d1a70162`              |
| 공통 조상 이후 커밋           | Windows 쪽에만 3개, GitHub 쪽에만 1개                   |
| 녹화 복원 전 미커밋 변경      | 66개 파일: 수정 53개, 삭제 11개, 신규·미추적 2개        |
| Windows manifest·package 버전 | `1.4.6` — 이번 작업에서 올리지 않았어요                 |

같은 `1.4.7`이라는 브랜치 이름을 쓰지만 Windows HEAD는 원격 HEAD의 직전 버전이 아니에요. 원격 [`4bef5e0`](https://github.com/neder2/Cheese-spanner/commit/4bef5e0a22a70461a945df4eb4140bb24379cc07)에는 녹화뿐 아니라 재생·광고·미니 플레이어·채팅 등 많은 수정이 함께 들어 있어요. Windows 파일로 덮으면 그 변경을 되돌릴 수 있어요.

Windows 쪽에만 있는 커밋도 맥에서 같은 변경을 이미 했는지 먼저 비교해요.

| Windows 커밋 | 내용                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `36e941a`    | 그리드 관련 기록·문구·일부 잔재 정리                                                                        |
| `19de8dd`    | 다시보기 날짜 옆의 19 배지를 날짜로 오인해 숨기던 문제 수정                                                 |
| `8cbf2f5`    | 옵션 설명 간소화, 검색어·도움말 보존, 시청 기록·백업 설명 정리, 팔로잉 목록 펼침·접힘 기억 설명과 검사 보완 |

## 2. 녹화 복원 전에 있던 변경

### 안내 문구·도움말 간소화

방송 목록, 채팅·영상 멀티뷰, 팔로잉 폴더, 방송 알림, 스트림 정보, 방송 달력, 댓글, 시청·후원 기록과 백업의 긴 설명·오류 문구를 짧게 바꾼 변경이 많아요. 설정·기록 페이지에서 중복 도움말을 덜어낸 변경도 있어요.

| 기존 문구                         | Windows에서 바뀐 문구 예 |
| --------------------------------- | ------------------------ |
| `블라인드된 메시지의 원문이에요.` | `블라인드 메시지 원문`   |
| `댓글을 불러오지 못했어요.`       | `댓글 불러오기 실패.`    |
| `되돌렸어요.`                     | `되돌리기 완료.`         |

주요 대상은 부록의 `features/`·`shared/` 파일과 `options.html`, `history.html`, `replay-pending.html`이에요. 다만 채팅 원문·사이드바 파일에는 아래의 실제 동작 변경도 있으므로 모두 문구 수정으로 취급하면 안 돼요.

맥에서 채택할 최종 문구를 먼저 정하고 검사 기대값을 맞춰요. Windows 문구를 그대로 채택하기로 확정한 상태는 아니며, 기존 해요체·접근성 안내의 의미도 함께 확인해야 해요.

### 라이브 블라인드 원문 복구 보완

대상: `features/chatToolsPage.js`(당시 신규), `features/chatTools.js`, `features/chatTools/messageStore.js`, `manifest.json`, `tests/chat-blind-source.test.js`(당시 신규), 관련 계약·개인정보 설명이에요.

- 새 MAIN 스크립트가 현재 채팅 행의 내부 원문을 읽고, isolated 기능이 현재 행·메시지 식별값·작성자·시각을 확인해 표시하는 구조예요.
- 초기 블라인드, 행 재사용, 같은 닉네임의 다른 계정, 불완전한 자료와 조회 중 DOM 변경을 구분해요.
- 방송 이동 뒤 이전 방송 메시지가 다시 표시되지 않도록 현재·직전 방송의 식별값을 제한된 메모리에 보관해요. 기능 OFF·문서 종료 정리도 포함돼요.
- 검증되지 않은 내부 원문을 과거 DOM 캐시로 대신하지 않는 경로가 있어요. 원문을 확장 저장소나 외부 서버에 보내는 기능은 아니에요.

원격 커밋에도 블라인드 복구 관련 변경이 있어요. 맥의 현재 구현과 이 MAIN 브리지 방식이 같은지 먼저 확인하고, 두 방식을 중복 설치하거나 `messageStore.js` 전체를 Windows 사본으로 교체하지 않아요. 실제 클린봇·블라인드 상황의 확인은 Windows에서 완료하지 못했어요.

### 사이드바 아래쪽 잘림 보정

대상: `features/headerBannerLayout.js`, `tests/header-banner-layout.test.js`, 관련 README·유지보수 설명이에요.

- 상단 배너가 없어도 사이드바 보정을 준비하도록 기존의 조기 종료 조건을 바꿨어요.
- 사이드바의 원래 인라인 세로 이동 값과 실제 계산된 값을 비교해 외부 스타일의 간섭을 확인해요.
- 배너가 없을 때는 확인된 사이드바만 보정하고, 관련 없는 헤더·본문 보정은 해제해요.
- 보정용 표시를 잠깐 해제해 원래 스타일을 읽고, 원래 값이 바뀌면 다시 판정해요.

맥의 미니 플레이어·오른쪽 사이드바 수정과 같은 기능이라고 가정하지 않아요. `headerBannerLayout.js`의 이 변경과 맥의 `panelResize.js` 등 최신 배치 처리를 함께 비교해요.

### 문서·작업 지침 정리

`AGENTS.md`, `CLAUDE.md`, 구조·계약·보안·유지보수 문서, 추적 문서와 과거 검증 기록을 정리한 변경이 있어요. 오래된 개별 지시서·실측 문서 11개는 삭제 상태였고, `docs/clip-quality-plan.md`는 중단 근거와 재개 조건 위주로 줄어 있었어요.

맥의 최신 `docs/tracking/status.md`·`findings.md`를 Windows 사본으로 덮어쓰지 않아요. 삭제 목록 역시 맥에 새 근거나 참조가 추가됐는지 확인하고, 필요한 내용을 담당 문서에 보존한 뒤 판단해요.

## 3. 이번 Windows 녹화 복원에서 한 일

Windows에는 녹화 파일 자체가 없었지만 원격 `4bef5e0`에는 이미 있었어요. 원격 커밋 전체를 병합하지 않고 다음 연결만 Windows 작업본에 골라 넣었어요.

- `features/videoRecorder.js`, `shared/recordingDownloads.js`, 녹화 검사
- `videoRecorderEnabled`·`videoRecorderFolder` 설정, 콘텐츠의 폴더 쓰기 허용 목록
- 옵션 페이지의 녹화 묶음·빈 폴더 값 처리·선택 권한 `downloads` 요청
- manifest 로딩과 background의 녹화 다운로드 메시지 처리
- 앰비언트·스트림 정보·녹화 항목의 공통 키보드 이동과 관련 검사
- 사용 안내, 개인정보·권한·메시지 계약 설명

맥에 이미 있는 녹화 구현을 Windows 사본으로 다시 덮는 작업은 필요하지 않아요. `shared/recordingDownloads.js`는 확인한 원격 원본과 같고, 녹화 본체의 원격 대비 실행 코드 차이는 아래 보완이에요.

### 별도로 검토할 녹화 수정: 메뉴 제거 뒤 늦은 저장 응답

파일: `features/videoRecorder.js`의 `removeMenu()`.

재현 순서는 다음과 같아요.

1. 톱니바퀴에서 녹화 저장 폴더를 입력하고 저장해요.
2. 저장 응답을 늦춘 상태로 네이티브 설정 메뉴를 제거해요.
3. DOM 동기화로 이전 입력·버튼 참조가 정리된 뒤 저장 성공 응답을 돌려줘요.
4. 원본에서는 이미 null인 `editSave.disabled`를 수정하려고 해 `TypeError`가 발생해요.

Windows에서는 메뉴 제거 때 저장 요청의 세대도 무효화하고 임시 폴더 표시를 해제했어요. 맥의 함수 구조가 아직 같을 때 검토할 최소 차이는 아래예요.

```diff
         expanded = false;
         permissionRevision++;
+        // A pending save belongs to the old menu; storage changes still update the next menu's options.
+        saveRevision++;
+        folderOverride = null;
```

실제 설정 저장을 취소하는 변경은 아니에요. 저장소 변경 알림은 계속 받아 새 메뉴에 반영하고, 이전 메뉴에 속했던 응답만 UI를 건드리지 않게 해요.

`tests/video-recorder.test.js`에 메뉴 제거 후 저장 응답을 돌려주고, 새 메뉴가 저장된 폴더를 표시하는 검사를 추가했어요. 이 검사는 수정 전 실패·수정 후 통과했어요. 맥 최신본에서 같은 문제가 이미 해결됐다면 그 구현을 유지하고 필요한 검사만 비교해요.

### 추가한 메뉴 조합 검사

`tests/player-settings-menu-navigation.test.js`는 기존 스트림 정보·앰비언트 두 순서에 더해 **스트림 정보·앰비언트·녹화의 여섯 설치 순서**를 검사해요. 모든 추가 항목의 위·아래·Home·End 이동, 앰비언트 스위치에서 다음 항목으로 이동, 원래 메뉴 항목 사이의 이동을 확인해요.

두 기존 기능의 메뉴 이동 보완은 원격에도 있었어요. 맥에서는 최신 구현을 유지하면서 녹화까지 포함한 조합 검사의 필요성을 판단해요.

## 4. Windows에서 확인한 검증과 한계

| 검사                                          | 결과                                         |
| --------------------------------------------- | -------------------------------------------- |
| 초기 녹화·설정·권한 관련 묶음                 | 144개 통과                                   |
| 보완 후 녹화·메뉴 연동 묶음                   | 20개 통과                                    |
| 전체 `test:all`, 동시 실행 2개                | 1,928개 중 1,864개 통과, 64개 실패           |
| 녹화 복원 전 사본에서 실패 항목 재실행        | 같은 실패 64개 재현                          |
| 전체 lint                                     | 통과                                         |
| 이번 변경 파일의 포맷·diff 검사               | 통과                                         |
| 전체 포맷 검사                                | 이번 녹화에서 바꾸지 않은 기존 8개 파일 실패 |
| 실제 Chrome 녹화·음성·다운로드·하위 폴더 저장 | 미검증                                       |

실패 64개는 문구의 실제 값과 검사 기대값 불일치, 옛 문구를 기다리는 조건 대기 실패 등이에요. 작업 전 사본과 실패 내용을 대조했고 집계 시각처럼 실행 때 바뀌는 값 외에는 같은 실패였어요. 이 수치를 맥 최신본의 실패 개수나 제품 기능 64개의 결함으로 해석하지 않아요.

전체 포맷 검사에서 남은 파일은 다음 8개이며, 녹화 복원 전후 바이트가 같았어요.

- `features/categoryTools.js`
- `features/followingFolders.js`
- `features/liveMultiview/playback.js`
- `features/liveStartRegistration.js`
- `features/vodBroadcastClock.js`
- `features/vodComments/view.js`
- `shared/donationHistory.js`
- `shared/donationHistoryImport.js`

이번 Windows 작업은 릴리스 준비 완료나 실브라우저 검증 완료가 아니에요. manifest·package 버전, 커밋·태그·Release도 변경하지 않았어요. 이 문서를 추가하는 GitHub 커밋은 코드 배포와 별개예요.

## 5. 맥에서 이어갈 순서

1. **맥의 현재 HEAD와 미커밋 작업을 먼저 보존·확인해요.** 이 문서의 원격 기준보다 맥 작업이 더 진행됐을 수 있어요.
2. **녹화의 늦은 저장 응답 문제를 우선 비교해요.** 아직 남아 있으면 위 재현을 검사로 확인하고 해당 수명주기만 보완해요. 원격에 이미 있던 녹화·권한·설정 전체를 다시 가져오지 않아요.
3. **블라인드 원문 복구와 사이드바 보정을 별도로 비교해요.** 맥의 최신 구현을 기준으로 누락된 동작·회귀 검사만 선별해요.
4. **문구 정리는 최종 표현을 정한 뒤 반영해요.** 동작·접근성 의미를 유지하며 검사 기대값을 맞추고, 실패를 없애려고 검사를 삭제하거나 약하게 만들지 않아요.
5. **문서는 필요한 근거만 합쳐요.** 맥의 현재 상태·검증 기록은 유지하고, Windows의 삭제 목록을 일괄 적용하지 않아요.
6. **최종 변경 범위에 맞게 검사해요.** 설정·저장·권한·로딩 경계를 바꾸면 관련 검사 뒤 전체 검사를 순서대로 실행해요.

맥에서 전체 검사가 필요할 때의 명령은 다음과 같아요.

```sh
npm run test:all -- --test-concurrency=2
npm run lint
npm run format:check
git diff --check
```

실제 Chrome에서는 라이브·다시보기의 영상과 음성, 녹화 중지 후 파일 생성, 다운로드 권한 승인·거절과 지정 폴더, 메뉴 교체 중 폴더 저장, 방송·영상 교체를 별도로 확인해야 해요.

## 부록: 녹화 복원 전 변경 파일 전체

아래 목록은 Windows `8cbf2f5`와 **녹화 복원 직전 사본**의 차이예요. 이번 녹화 복원에서 새로 추가한 파일이나 이 인수인계 문서는 포함하지 않아요. `M`은 수정, `D`는 삭제, `A`는 당시 신규·미추적 파일이에요.

| 상태 | 파일                                                         |
| ---- | ------------------------------------------------------------ |
| A    | `features/chatToolsPage.js`                                  |
| A    | `tests/chat-blind-source.test.js`                            |
| M    | `AGENTS.md`                                                  |
| M    | `CLAUDE.md`                                                  |
| M    | `PRIVACY.md`                                                 |
| M    | `README.md`                                                  |
| D    | `docs/01_moderator_chat_collection_followup_fix_guide.md`    |
| D    | `docs/02_vod_title_history_cross_contamination_fix_guide.md` |
| M    | `docs/architecture.md`                                       |
| M    | `docs/category-tools-loading-verification.md`                |
| D    | `docs/category-tools-performance-comparison.md`              |
| D    | `docs/chat-weekly-ranking-verification.md`                   |
| D    | `docs/chzzk-compatibility-2026-09-11.md`                     |
| M    | `docs/clip-quality-plan.md`                                  |
| M    | `docs/contracts.md`                                          |
| M    | `docs/engineering-notes.md`                                  |
| D    | `docs/feature-expansion-proposal.md`                         |
| M    | `docs/measurements/ad-decision-2026-09-11.md`                |
| D    | `docs/measurements/header-buttons-2026-09-14.md`             |
| D    | `docs/measurements/player-buttons-2026-09-14.md`             |
| M    | `docs/measurements/watchparty-banner-gap-2026-09-24.md`      |
| D    | `docs/refactoring-1.3.4.md`                                  |
| M    | `docs/release-1.3.7-verification.md`                         |
| M    | `docs/release-1.3.8-verification.md`                         |
| M    | `docs/release-1.3.9-verification.md`                         |
| M    | `docs/release-1.4.0-verification.md`                         |
| M    | `docs/security.md`                                           |
| M    | `docs/standards.md`                                          |
| D    | `docs/test-cleanup-verification.md`                          |
| M    | `docs/tracking/findings.md`                                  |
| D    | `docs/volume-wheel-muted-verification.md`                    |
| M    | `features/AGENTS.md`                                         |
| M    | `features/categoryTools.js`                                  |
| M    | `features/chatMultiview.js`                                  |
| M    | `features/chatTools.js`                                      |
| M    | `features/chatTools/messageStore.js`                         |
| M    | `features/chatTools/panel.js`                                |
| M    | `features/followingFolders.js`                               |
| M    | `features/headerBannerLayout.js`                             |
| M    | `features/liveMultiview/layoutControls.js`                   |
| M    | `features/liveMultiview/model.js`                            |
| M    | `features/liveMultiview/playback.js`                         |
| M    | `features/liveMultiview/runtime.js`                          |
| M    | `features/liveMultiview/settingsPanel.js`                    |
| M    | `features/liveStartRegistration.js`                          |
| M    | `features/monthlyBroadcastTime.js`                           |
| M    | `features/sidebarCustomization.js`                           |
| M    | `features/streamInfo.js`                                     |
| M    | `features/vodBroadcastClock.js`                              |
| M    | `features/vodComments/model.js`                              |
| M    | `features/vodComments/nativeAdapter.js`                      |
| M    | `features/vodComments/view.js`                               |
| M    | `history.html`                                               |
| M    | `manifest.json`                                              |
| M    | `options.html`                                               |
| M    | `replay-pending.html`                                        |
| M    | `shared/data.js`                                             |
| M    | `shared/donationHistory.js`                                  |
| M    | `shared/donationHistoryImport.js`                            |
| M    | `shared/liveStartMonitor.js`                                 |
| M    | `shared/watchHistoryBackup.js`                               |
| M    | `shared/watchHistoryBackupController.js`                     |
| M    | `shared/watchHistoryBackupMerge.js`                          |
| M    | `tests/extension-pages.test.js`                              |
| M    | `tests/header-banner-layout.test.js`                         |
| M    | `tests/options-settings-backup.test.js`                      |
