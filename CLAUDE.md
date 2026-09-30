# 치즈 스패너 — 작업 지침

치즈 스패너(Cheese Spanner)는 치지직 시청·탐색을 개선하는 무료 비공식 Chrome Manifest V3 확장이에요.
런타임은 빌드 없는 일반 JavaScript·IIFE와 패키지에 포함한 자산으로 구성돼요. 별도 개발자 서버·로그인·분석 수집은 없어요.

## 구조와 작업 기준

```text
./
├── AGENTS.md                              → 공통 작업 경계와 작업 전 확인
├── CLAUDE.md                              → 같은 내용의 Claude 진입 지침
├── docs/
│   ├── architecture.md                    → 실행 영역·책임·의존 방향·데이터 흐름
│   ├── business-rules.md                  → 확인된 제품 의도와 사용자 동작 기준
│   ├── security.md                        → 권한·계정·프로필 보관·실행 경계
│   ├── standards.md                       → 작업·Git·검증·릴리스의 전체 규칙
│   ├── engineering-notes.md               → DOM·재생·저장·요청의 실측 함정
│   ├── operations.md                      → 환경 준비·검증·브라우저·배포 절차
│   ├── contracts.md                       → 치지직 DOM/API와 확장 교환 형식
│   └── tracking/
│       ├── status.md                      → 구현·검증·계획·중단 상태
│       ├── findings.md                    → 남은 문제·영향·후속 확인
│       └── decisions/
│           ├── index.md                   → 주요 선택과 제약
│           ├── 0001-native-playback.md    → 입장 화질 목적과 네이티브 재생 경계
│           ├── 0002-history-writer.md     → 기록 단일 쓰기 경계
│           ├── 0003-profile-storage.md    → 프로필 단위 기록 보관
│           ├── 0004-live-start-effects.md → 알림·자동 입장의 중복 방지 우선
│           └── 0005-history-backup.md     → 시청·내 채팅 백업과 보존 우선 병합
├── shared/
│   └── AGENTS.md                          → 공용 설정·데이터·기록·워커 보조 기능
└── features/
    ├── AGENTS.md                          → 페이지 기능별 소유권·수명·테스트
    ├── categoryTools/AGENTS.md            → 방송 목록 필터·메타데이터·탐색
    ├── chatTools/AGENTS.md                → 행 정체성·원문·운영자 패널
    ├── liveMultiview/AGENTS.md             → 메인·보조 재생과 배치
    ├── monthlyBroadcastTime/AGENTS.md     → KST 방송 계산·공유 조회
    ├── videoSearch/AGENTS.md              → 채널 영상·댓글 검색 데이터
    └── vodComments/AGENTS.md              → 댓글 상태·원본 위임·표시
```

## 반드시 지킬 경계

1. 기존 변경과 미추적 파일을 보존해요. 요청 대상과 현재 branch가 다르면 구현 전에 멈추고, branch 변경·커밋·push·병합·태그·버전·Release는 명시적으로 요청받은 범위에서만 해요.
2. 실제 구조는 manifest·package·코드·테스트로 확인하고 제품 의도는 추측하지 않아요. 실측하지 못한 데이터·재생 성공·브라우저 검증을 만들어 보고하지 않아요.
3. 실행 코드는 패키지 안에 두고 MAIN/isolated의 권한 경계를 지켜요. 기능 실패를 새 창·iframe·원격 플레이어 실행으로 바꾸지 않아요.
4. 시청 기록은 background의 단일 writer만 변경해요. DOM 노드는 재사용될 수 있으므로 현재 데이터 정체성을 확인하고 늦은 요청·삭제된 기록의 복원을 막아요.
5. 검증을 통과시키려고 테스트를 삭제하거나 약하게 만들지 않아요. 작은 변경은 관련 테스트를 기본으로 하고, 설정·저장·권한·로딩 경계 변경이나 영향 범위가 불명확한 변경·릴리스 전에는 전체 검증을 수행해요. 테스트 동시 실행은 2개로 제한하고 lint·포맷 검사는 순차 실행해요. 실브라우저 확인 여부는 별도로 보고해요.

## 작업 전 확인

- 한국어 존댓말·해요체로 응답해요. 요청이 리뷰·계획·구현 중 무엇인지 구분하고, 현재 branch·HEAD·상태·기존 diff·요청 version을 확인해요. 버전 branch는 숫자만 사용해요.
- 기본으로 `docs/standards.md`, `docs/engineering-notes.md`와 해당 모듈의 `AGENTS.md`를 읽어요. 미구현 계획이나 기존 문제를 건드릴 때는 `docs/tracking/status.md`와 `docs/tracking/findings.md`도 확인해요.
- 재생·화질·광고 수정 전에는 `docs/business-rules.md`의 재생 기준과 `docs/contracts.md`의 페이지 객체·응답 경계를 확인해요. 입장·설정 저장 시 화질 적용과 일시정지 재개 위치 보존을 일반적인 지속 강제로 넓히지 않아요.
- 시청·활동·후원·알림 변경 전에는 `docs/security.md`의 주체별 권한·프로필 보관을 확인하고 background의 발신자 검증·쓰기 큐·각 기능의 취소 경로를 읽어요.
- 새 파일·옵션·권한 변경 전에는 manifest의 world·로드 순서, `shared/settings.js`의 스키마, 각 HTML 진입점, 동적 광고 등록을 함께 확인해요. `tests/release-safety.test.js`와 `tests/extension-pages.test.js`의 해당 계약도 읽어요.
- 루트의 `options.js`·`optionsLiveStart.js`는 옵션 편집·권한·등록 UI를, `history.js`는 기록 조회·표시·변경 요청을 소유해요. 루트에 기능 로직을 한데 모으거나 UI에서 시청 기록을 직접 쓰지 않아요.
- 릴리스 작업 전에는 `docs/operations.md`, `docs/update-history.md`, README, PRIVACY, THIRD_PARTY_NOTICES와 스토어 문구를 변경 범위에 맞춰 확인해요. 과거 계획·실측·릴리스 기록의 당시 상태를 현행 사실로 복사하지 않아요.
- 1.4.1부터 매 버전의 릴리스 준비 완료 보고·릴리스 제안·승인 요청 전에 `docs/operations.md`의 새 기능 안내 필수 점검을 반드시 완료해요. 버전별 내용·최초 1회·20초·다시보기·실제 Chrome 화면·배포 파일을 확인하고, 미검증 항목이 남으면 릴리스 준비 완료로 보고하거나 공개·제출하지 않아요. 사용자가 릴리스를 요청한 경우에도 이 점검을 먼저 수행해요.

## 문제를 발견했을 때

다른 방송·메시지의 데이터 혼입, 삭제한 기록의 재생성, 외부 출처의 특권 명령 실행, 원격 실행 코드 유입, 의도하지 않은 데이터 전송·결제·채팅 전송은 즉시 사용자에게 알려요. 재생·입력 경로가 반복 동작으로 막히거나 사용자 데이터를 덮어쓸 가능성도 영향을 확인하고 먼저 보고해요.

그 밖의 현재 범위에서 해결할 수 없는 문제는 조건·증상·영향·지금 고치지 않는 이유와 후속 확인을 `docs/tracking/findings.md`에 남겨요. 현재 코드와 확인된 의도가 다르더라도 문서를 정리하는 작업에서 런타임을 함께 바꾸지 않아요. 확정된 의도와 구현된 상태를 나눠 기록해요.
