# 1.3.8 릴리즈 준비 검증

- 검증일: 2026-09-15
- 작업 브랜치: `1.3.8`, 기준 HEAD: `659ad7ff5782bea66cf2ce1d395a80b41f1fd83b`
- 검증 대상: 버전과 릴리즈 문서를 갱신한 작업 트리. 기준 HEAD 자체는 1.3.7이다.
- 메인 반영 기준: 이력이 정리된 원격 `main`의 `34dd065341d070d59e4bebbd3256c6fd1db79140`. 1.3.8 변경 커밋만 이 기준 위에 재적용했다.
- 릴리즈 본문 원본: [1.3.8 업데이트 내역](update-history.md#138-2026-09-15).

## 버전과 문서

- `manifest.json`, `package.json`, `package-lock.json`의 루트와 루트 패키지 버전, README의 현재 버전을 모두 `1.3.8`로 맞췄다.
- 기존 확장 페이지 테스트의 목표 버전을 `1.3.8`로 변경하고, manifest·package·lockfile·최신 변경 내역의 버전 일치 검사를 유지했다.
- 좌클릭 홀드 2배속, 화면 확대와 슬라이더, 멀티뷰 자유 배치, 스트림 정보 메뉴 이동, 재생·설정 개선, 방송 달력과 공지 종료를 릴리즈 노트와 README 요약에 반영했다.
- 과거 변경 이력과 1.3.7 공지 데이터·보관 템플릿의 버전은 당시 동작을 설명하거나 검증하는 값이다. 현재 배포 버전과 구분한다.
- 스토어 설명의 이전 공지 표시·저장 안내를 종료된 동작에 맞추고, 단축키 기본값 복원·달력 개선·화면 확대 기본값 안내를 반영했다.

## 버전 갱신 시점 자동 검증

| 검사                                                                                                 | 결과                             |
| ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| `node --test tests/extension-pages.test.js tests/release-safety.test.js tests/update-notice.test.js` | 133개 통과                       |
| `npm.cmd run test:all`                                                                               | 774개 통과, 실패·취소·건너뜀 0개 |
| `npm.cmd run lint`                                                                                   | 통과                             |
| `npm.cmd run format:check`                                                                           | 통과                             |
| `git diff --check`                                                                                   | 통과                             |

버전 증가 뒤에도 이전 공지가 다시 표시되거나 주입되지 않는 검사를 포함한다. 전체 검사에는 새 좌클릭 홀드와 화면 확대의 연동, 멀티뷰 자유 배치, 달력 및 옵션 기본값 복원 검사가 포함된다. 이 문서는 검사 완료 후 작성하고 별도로 포맷을 확인했다.

## 후속 수정의 릴리즈 노트 반영

- 자유 배치에서 방송을 놓은 위치에 추가하는 동작과 방송 시작 날짜 표시를 현재 코드와 대조해 릴리즈 노트·README 요약에 반영했다. 팔로잉 미리보기와 함께 사용하는 동작은 자유 배치의 기능 설명에 포함했다.
- 릴리즈 노트는 직전 배포 버전 1.3.7과 1.3.8의 최종 동작 차이를 기준으로 작성한다. 1.3.8 개발 중 발생한 미리보기 가림과 확대 시 버튼 소실은 별도 버그 수정 항목에서 제외하고, 원인과 수정 과정은 개별 실측 문서에 남긴다.
- 자유 배치의 추가 대상 제외 영역과 화면 가장자리 배치, 한국 시간 자정 이후 시작 날짜 갱신 조건을 함께 명시했다.
- 이번 후속 작업은 문서 포맷과 diff 공백을 확인했다. 위 774개 결과는 버전 갱신 당시 기록이며, 이후 기능 수정까지 포함한 전체 재검증 결과가 아니다. 자유 배치의 개별 검증은 [방송 추가 기록](measurements/multiview-free-drop-2026-09-15.md)과 [미리보기 표시 기록](measurements/multiview-preview-layer-2026-09-15.md)을 참고한다.

## 메인 반영과 배포 ZIP 최종 검증

- 후속 변경 관련 검사: `node --test tests/live-multiview.test.js tests/following-preview-tooltip.test.js tests/extension-pages.test.js tests/release-safety.test.js` 252개 통과.
- 원격 main 이력에 반영한 뒤 `npm.cmd run test:all` 784개 통과. 실패·취소·건너뜀은 0개다.
- `npm.cmd run lint`, `npm.cmd run format:check`, `git diff --check` 통과.
- 원격에 있던 문서 정리를 유지하고, 기존 로컬 main은 `codex/main-before-1.3.8`에 보존했다. 미공개 기획안 `docs/feature-expansion-proposal.md`는 커밋에서 제외했다.
- 생성 명령: `npx.cmd --no-install web-ext build --config web-ext-config.mjs --artifacts-dir web-ext-artifacts --filename cheese_spanner-1.3.8.zip`
- 파일: `web-ext-artifacts/cheese_spanner-1.3.8.zip`
- 크기: 2,659,203바이트. 파일 88개, 디렉터리 포함 100개 항목.
- SHA-256: `b4c564128c5b213a6d985393e6bcae48a17a7ea7d3406b208bfe22931112ca64`
- ZIP의 manifest 버전은 1.3.8이다. 모든 파일이 추적 중인 작업 트리 소스와 바이트 단위로 일치하며, manifest·확장 HTML·background import·동적 광고 스크립트·라이선스의 필수 참조 86개가 존재한다.
- HLS·Pretendard 라이선스와 `THIRD_PARTY_NOTICES.md`를 포함한다. tests·docs·store-assets·node_modules·개발 설정·기존 ZIP과 미공개 adAutoSkip 파일은 포함하지 않는다.

## 실브라우저와 게시 범위

이번 작업에서는 실제 확장 재로드·주입과 실브라우저 동작을 확인하지 않았다. 개별 기능의 기존 실측이나 자동 테스트를 1.3.8 최종 패키지의 실사용 검증으로 간주하지 않는다.

1. 확장을 다시 로드하고 치지직 탭을 새로고침해 버전 1.3.8을 확인한다.
2. 라이브·다시보기에서 좌클릭 홀드·클릭·드래그, 150–500% 확대·슬라이더와 왼쪽 플레이어 버튼을 확인한다.
3. 멀티뷰 자유 배치·전체화면 왕복, 스트림 정보 메뉴, 연속 방송 달력과 좁은 설정창의 저장·복원 동작을 라이트·다크 모드에서 확인한다.

배포 ZIP을 생성하고 1.3.8 변경을 원격 main의 최신 이력 위에 하나의 커밋으로 정리했다. [GitHub 1.3.8 릴리즈](https://github.com/neder2/Cheese-spanner/releases/tag/v1.3.8)에 릴리즈 노트와 검증한 ZIP을 게시했다. 스토어 게시 작업은 수행하지 않았으며, 실제 스토어 등록 시 `store-assets/chrome-web-store-description.txt`의 최신 설명도 반영해야 한다.

## 게시 커밋 제목 정정

- 사용자 요청에 따라 게시 커밋 제목을 `Cheese Spanner 1.3.8`로 정정한다. 교체 대상은 `main`과 `v1.3.8`이며, 교체 전 커밋은 `c67a09e00ef3f0f4d195b8f0c7db76738c6355c8`이다.
- 커밋 명명 규칙과 개발 패키지 이름을 현재 제품명에 맞추고, 사용자가 삭제를 요청한 업데이트 안내를 릴리즈 노트 원본과 README 요약에도 반영한다.
- 변경 파일은 지침·문서·개발 패키지 메타데이터로 한정한다. 이 파일들은 배포 ZIP에 포함되지 않으며 실행 코드와 기존 패키지 해시는 동일하다.
