존댓말 사용

버전 업데이트, GitHub 메인 머지, 릴리스 작업을 할 때는 GitHub Release 또는 업데이트 내역을 반드시 작성하거나 갱신한다.

버그를 수정할 때는 보정용 우회 코드부터 만들지 말고, 기존 코드의 어느 경로가 어떻게 잘못되어 증상이 생겼는지 먼저 파악한다. 원인이 되는 기존 로직의 소유 표면에서 수정하는 것을 우선하며, 외부 서비스 변화처럼 직접 고칠 수 없는 원인일 때만 그 근거를 명확히 설명하고 보정 코드를 검토한다.

<!-- vowline:start -->
Always use the skill `vowline` consistently, including for all sub-agents.
<!-- vowline:end -->

## 내부 자료 보관 위치

과거 조사·실측·릴리스 검증 기록과 스토어 제작 자료·등록 문구는 비공개 저장소 `neder2/cheese-spanner-internal`에서 관리해요. 기존 자료는 `archive/product-docs/2026-11-11/<브랜치>/`에 원래 경로로 보존돼 있어요. 새 릴리스 검증은 내부 저장소의 `releases/<버전>/verification.md`에 기록하고, 제품 실행 코드·테스트·현행 제품 규칙·에이전트 지침은 이 공개 저장소에 유지해요.
