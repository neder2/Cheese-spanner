# 치즈 스패너 1.3.9 릴리스 검증

아래 최초 초안 기록 이후 패키지를 다시 만들었다. 현재 배포본의 검증 결과와 해시는 문서 끝의 **수정사항 반영 재게시**를 기준으로 한다.

- 검증일: 2026-09-19.
- 작업 브랜치: `1.3.9`, 시작 HEAD: `52d7d3536811dc0cde223fdc7a5adac67955571e`.
- 대상: 1.3.8 이후의 현재 작업 트리. manifest·package·lockfile의 루트 및 루트 패키지 버전은 모두 `1.3.9`다.
- 릴리스 본문 원본: [1.3.9 업데이트 내역](update-history.md#139-2026-09-19).

## 검증

- 최종 광고 소스 인식 수정 후 `npm.cmd run test:all` 858개 통과. 실패·취소·건너뜀은 0개다.
- `npm.cmd run lint`, `npm.cmd run format:check`, `git diff --check` 통과.
- 사용자 탭의 아시안게임 중계에서 `blockedWrappedLiveRequests=1`과 광고 차단 성공을 확인했다. 상세 원인과 사용자 실측은 [아시안게임 재생 조사](measurements/asian-games-playback-2026-09-19.md)에 기록했다.
- 브라우저 조작 도구로 전체 기능을 직접 재검증하지는 않았다. 기능별 기존 실측·자동 검사와 사용자 확인 범위를 전체 화면·권한 시나리오의 종단 검증으로 확대하지 않는다.

## 배포 ZIP

- 경로: `web-ext-artifacts/cheese_spanner-1.3.9.zip`.
- 생성 명령: `npx.cmd web-ext build --config web-ext-config.mjs --filename cheese_spanner-1.3.9.zip`.
- 파일 수: 97개. 크기: 2,693,537바이트.
- SHA-256: `e016cd4f9d5658d17d34da183a0c243b683ad9a2bc86592760d59ce440d3de3a`.
- 모든 ZIP 파일의 바이트 해시가 작업 트리의 대응 파일과 일치한다. manifest 버전·정적 참조, 동적 광고 스크립트, 방송 시작 모니터와 시청 기록 레이아웃 파일, 서드파티 고지를 확인했다.
- 개발 의존성, 테스트, 조사 문서, 스토어 자료, 기존 ZIP, 미공개 `adAutoSkip.js`는 제외했다.
- 패키지를 먼저 제공한 뒤 변경한 README·릴리스 문서·스토어 문구는 패키징 제외 대상이며 런타임에는 추가 변경이 없다.

## 릴리스·스토어 자료

- 릴리스 노트의 개발 중 표시를 배포일로 바꾸고 현재 작업본의 시청 기록·내 활동·후원 가져오기, 배너 배치 및 배속 변경을 최종 사용자 동작 기준으로 반영했다.
- [스토어 설명](../store-assets/chrome-web-store-description.txt)에 현재 기능·데이터 처리를 반영했다.
- [새 권한 요청 사유](../store-assets/chrome-web-store-permission-justifications.txt)를 준비했다. `alarms`는 사용자가 선택한 채널의 방송 시작 확인, 선택 권한 `notifications`는 데스크톱 알림에 사용한다.
- 실제 Chrome 웹 스토어의 권한 사유·설명·개인정보처리방침 등록과 심사 제출은 이 작업에서 직접 조작하지 않았다.
- 이전 버전 작업본을 대상으로 작성된 미공개 기획안 `docs/feature-expansion-proposal.md`는 기존 파일을 유지하되 릴리스 커밋에서 제외한다.

## 수정사항 반영 재게시 — 2026-09-19

- 사용자 요청으로 기존 1.3.9 초안에 후속 수정사항을 반영하고 같은 버전으로 다시 패키징했다. 시작 브랜치는 `1.3.9`, HEAD는 `74ef00554537c5db926e4bf29de5583c28d96a05`다.
- 방송 알림 전용 탭·상단 채널 검색과 등록 해제, 프로필 표시, 후원 내역 전체 기간·증분 갱신과 통합 조회, 옵션창 테마 버튼·부드러운 탭 스크롤을 포함한다. 관련 README·개인정보·서드파티 고지·스토어 설명과 업데이트 내역을 함께 반영했다.
- 관련 대상 테스트 96개 통과 후 전체 `npm.cmd run test:all` 890개 통과. 실패·취소·건너뜀은 0개다. `npm.cmd run lint`, `npm.cmd run format:check`, `git diff --check`도 통과했다.
- 생성 명령: `npx.cmd --no-install web-ext build --config web-ext-config.mjs --filename cheese_spanner-1.3.9.zip --overwrite-dest`.
- 패키지: `web-ext-artifacts/cheese_spanner-1.3.9.zip`, 98개 파일, 2,704,353바이트.
- SHA-256: `432739ecc532175f5cbc6ac187857517c9b4c791c22f51d9083b8008ea322974`.
- 모든 ZIP 항목의 바이트 해시와 작업 트리 원본이 일치한다. manifest·HTML·CSS·background 참조 및 추가 필수 파일 93개, manifest·package·lockfile 버전 일치를 확인했다. 개발 의존성·테스트·문서·스토어 자료·기존 ZIP·미공개 광고 자동 넘김은 포함하지 않았다.
- 이번 재게시 작업에서는 확장 재로드·치지직 새로고침·주입 확인과 실브라우저 스모크를 새로 수행하지 않았다. 기능별 기존 실측은 [방송 알림 검색](measurements/live-start-header-search-2026-09-19.md), [후원 내역 갱신](measurements/donation-history-refresh-2026-09-19.md), [옵션창 테마·스크롤](measurements/options-motion-theme-2026-09-19.md)에 별도로 남아 있으며 이번 최종 ZIP의 재검증으로 간주하지 않는다.
- 최소 수동 확인: 새 ZIP으로 확장을 다시 로드하고 치지직 탭을 새로고침한 뒤 방송 알림 검색·등록·해제와 SPA 이동, 좁은 옵션창의 화이트·다크 및 테마 저장, 로그인한 탭에서 후원 내역 갱신을 확인한다. OS 알림 권한 승인·거부와 새 방송 시작 전환은 별도 확인 대상이다.
- Chrome 웹 스토어 제출은 수행하지 않는다. 제출할 때 새 ZIP과 갱신된 스토어 설명·개인정보처리방침, 기존 권한 사유를 함께 반영해야 한다. 별도 기능 기획안은 계속 커밋에서 제외한다.
