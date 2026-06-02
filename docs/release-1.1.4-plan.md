# Better Chzzk 1.1.4 릴리스 계획서

- **작성일:** 2026-06-02
- **대상 버전:** 1.1.4
- **릴리스 브랜치:** `1.1.4` (현재 `origin/1.1.4`와 동기화됨, 로컬 앞선 커밋 없음)
- **직전 릴리스:** `v1.1.3` (태그 존재)
- **결정 사항:** 이번 라이브 캐시 용량 기능을 **1.1.4에 포함**한다.

---

## 1. 목표

`1.1.4` 브랜치에 쌓인 변경(라이브 위치 유지 보호 로직, 빨리 감기 버튼, 다시보기 방송시각 기본 비활성화, **라이브 캐시 용량 옵션**)을 정식 1.1.4로 마무리하여:

1. 작업물을 모두 커밋하고,
2. 변경 이력을 확정하고,
3. `main`에 병합하고,
4. `v1.1.4` 태그 및 GitHub Release를 만들고,
5. 스토어 제출용 패키지(zip)를 생성한다.

---

## 2. 포함 범위 (1.1.4 변경 사항)

`docs/update-history.md`의 `## 미출시` 4개 항목이 1.1.4 범위다.

| # | 변경 | 관련 파일 |
| - | ---- | --------- |
| 1 | **라이브 캐시 용량 옵션 추가** — 라이브 위치 유지가 기억하는 깊이(분)를 설정, 저장 방식 툴팁 포함 | `shared/settings.js`, `features/skipControl.js`, `options.html`, `styles.css`, `tests/settings.test.js` |
| 2 | 라이브 타임머신 강제 실시간 복귀 보호 로직 | `features/skipControl.js` (b46902a에 포함) |
| 3 | 라이브 컨트롤 `빨리 감기` 버튼 | `features/skipControl.js` (b46902a에 포함) |
| 4 | 다시보기 방송시각 기본 비활성화 정리 | `features/vodBroadcastClock.js`, `shared/settings.js` (b46902a에 포함) |

> 참고: 2~4번은 이미 `b46902a "Release version 1.1.4"` 커밋에 들어가 있고, 1번만 아직 워킹 트리에 미커밋 상태다.

추가로 워킹 트리에 섞여 있는 **무관한 1줄 변경**도 함께 처리 여부를 정한다.

- `features/monthlyBroadcastTime.js`: 라벨 `"내 채널 누적"` → `"내 시청 시간"` (단순 문구). → **1.1.4에 포함하되 변경 이력에 한 줄 추가** 권장.

---

## 3. 사전 점검 결과 (2026-06-02 기준)

| 항목 | 상태 | 비고 |
| ---- | ---- | ---- |
| 버전 일관성 | ✅ | `manifest.json` · `package.json` · `package-lock.json` · README 모두 `1.1.4` |
| 테스트 (`node --test`) | ✅ | 9/9 통과 |
| 린트 (`eslint .`) | ✅ | 통과 |
| 워킹 트리 커밋 | ⚠️ | 수정 8개 + 언트래킹 2개 미처리 |
| 변경 이력 확정 | ⚠️ | `## 미출시`만 존재, `## 1.1.4` 섹션 없음 |
| `v1.1.4` 태그 | ❌ | 없음 (현재 `v1.1.3`까지) |
| `main` 병합 | ❌ | 미병합, 또한 분기됨(아래 4.4) |
| 패키지 제외 설정 | ❌ | web-ext ignore 설정 없음 → dev 파일이 zip에 포함됨 |

---

## 4. 작업 단계

> 모든 작업은 `1.1.4` 브랜치에서 시작한다. 커밋 메시지 끝에는 프로젝트 관례대로
> `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` 를 붙인다.

### 4.1 워킹 트리 커밋

대상: 라이브 캐시 용량 기능 + 라벨 문구 변경.

```
git add shared/settings.js features/skipControl.js options.html styles.css \
        tests/settings.test.js features/monthlyBroadcastTime.js README.md docs/update-history.md
git commit -m "Add live cache capacity option for live position hold"
```

- `README.md`/`docs/update-history.md`는 4.2에서 추가 편집하므로, 4.1과 4.2를 한 커밋으로 묶어도 된다.
- 커밋 전 `node --test`, `eslint .` 재확인.

### 4.2 변경 이력 확정 (`미출시` → `1.1.4`)

`docs/update-history.md`에서 `## 미출시` 헤딩을 아래로 교체한다.

```markdown
# 업데이트 내역

## 1.1.4 (2026-06-02)

- 라이브 위치 유지가 기억하는 범위를 옵션에서 `라이브 캐시 용량`(분)으로 조절할 수 있도록 했습니다. …(기존 문구 유지)
- 라이브 타임머신 … 보호 로직을 추가했습니다.
- 라이브 플레이어 컨트롤에 `빨리 감기` 버튼을 추가했습니다. …
- 다시보기 방송시각 표시 기능을 기본 비활성화로 변경했습니다. …
- 월간 달력 누적 시간 라벨을 `내 시청 시간`으로 정리했습니다.   ← (4번 라벨 변경 반영 시)
```

- 향후 작업을 위해 맨 위에 빈 `## 미출시` 섹션을 새로 둘지 여부는 선택.
- AGENTS.md 규칙: 릴리스 시 업데이트 내역 작성은 **필수**.

### 4.3 개발 파일 정리 (저장소 / 패키지 제외)

**언트래킹 파일 처리 결정**

- `AGENTS.md` — 에이전트 작업 지침(확장 코드 아님). → `.gitignore`에 추가하거나, 저장소에 커밋하되 패키지에서는 제외.
- `docs/refactoring-guide.md` — 개발 문서. → `docs/`의 다른 문서처럼 커밋하거나 언트래킹 유지. 어느 쪽이든 패키지에서는 제외.

**패키지 제외 설정 추가** (스토어 zip에 dev 파일이 들어가지 않도록)

web-ext 기본값은 `node_modules`, `.git` 정도만 제외하므로 `tests/`, `docs/`, `*.md` 등은 명시적으로 빼야 한다. 프로젝트 루트에 `web-ext-config.mjs` 추가:

```js
export default {
  ignoreFiles: [
    "tests",
    "tests/**",
    "docs",
    "docs/**",
    "store-assets",
    "store-assets/**",
    "dist",
    "dist/**",
    "web-ext-artifacts",
    "web-ext-artifacts/**",
    "*.md",
    "AGENTS.md",
    "package.json",
    "package-lock.json",
    "eslint.config.js",
    ".prettierrc.json",
    "web-ext-config.mjs",
    ".claude/**",
  ],
};
```

- 빌드 후 zip 내부에 `manifest.json`이 참조하는 파일(JS/HTML/CSS/icons)만 남는지 확인.
- `.gitignore`에는 이미 `*.zip`, `node_modules/`, `.claude/`가 있어 빌드 산출물은 무시됨.

### 4.4 `main` 병합 (README 충돌 해결) — ⚠️ 핵심 리스크

**분기 상태**

- `1.1.4`에만 있는 커밋: `b46902a`(README 약 709줄 재작성 포함).
- `main`에만 있는 커밋: `4de8699`(방송 목록/검색 설명 보강), `d0efd19`(팔로워 배지 호버 설명 **정정**).
- 두 브랜치 모두 README를 건드려 **병합 시 README.md 충돌이 거의 확실**하다.

**권장 절차** — `1.1.4`는 이미 push된 브랜치이므로 히스토리 재작성(rebase) 대신 머지로 진행한다.

```
git checkout 1.1.4
git merge main            # README.md 충돌 발생 예상
# 충돌 해결 (아래 체크포인트) 후
node --test && npx eslint .
git commit                # 머지 커밋
git checkout main
git merge --ff-only 1.1.4 # main을 1.1.4 끝점으로 전진
```

**README 충돌 해결 시 반드시 보존할 것** (b46902a 재작성본이 덮어쓰지 않도록):

1. **`d0efd19` 정정 유지** — 팔로워 수 배지는 `pointer-events:none`이라 호버 툴팁이 뜨지 않는다.
   - 본문: "축약된 팔로워 수 배지를 **항상 표시**"로 서술. "마우스를 올리면 정확한 수를 보여 줍니다"류 문구 **금지**.
   - 컨트롤 표: "팔로워 배지 **호버** → 정확한 수(툴팁)" 행을 **넣지 않는다**.
2. **`4de8699` 보강 내용 유지** — `현재 목록 검색`(결과 수/스피너/빈 상태), `필터 메뉴`(팔로워·시청자/조회수 구간·직접 입력·초기화·활성 개수), `댓글 일치 표시` 등 상세 설명.
3. b46902a 재작성본의 새 구조(라이브 위치 유지 / 빨리 감기 / **라이브 캐시 용량** 설명·설정표)도 함께 유지.

> 즉, 최종 README = (b46902a 신규 구조) + (4de8699 보강) + (d0efd19 정정) 의 합집합이어야 한다.

**대안:** 명시적 릴리스 경계를 원하면 `git checkout main && git merge --no-ff 1.1.4`로 머지 커밋을 남겨도 된다.

### 4.5 태그 및 푸시

```
# main이 1.1.4 내용까지 포함한 상태에서
git tag -a v1.1.4 -m "Better Chzzk 1.1.4"
git push origin main
git push origin 1.1.4
git push origin v1.1.4
```

- `v1.1.3`이 경량/주석 태그 중 어느 형식인지 확인 후 형식을 맞추는 것이 깔끔하다.

### 4.6 패키징 (web-ext)

```
npx web-ext lint          # manifest/권한 사전 점검
npx web-ext build         # web-ext-artifacts/better_chzzk-1.1.4.zip 생성
```

- 4.3의 `ignoreFiles` 적용 상태에서 빌드.
- zip 내용물 확인: `manifest.json`, `background.js`, `content.js`, `options.html`, `styles.css`, `shared/`, `features/`, `history.*`, `replay-pending.html`, `icons/`만 포함되고 `tests/`·`docs/`·`*.md`·`node_modules/`는 빠졌는지 확인.

### 4.7 GitHub Release

- 태그 `v1.1.4` 기준으로 Release 생성.
- 릴리스 노트 = `docs/update-history.md`의 1.1.4 섹션 내용.
- (스토어 업로드 시) 4.6의 zip 첨부.

---

## 5. 리스크 및 대응

| 리스크 | 영향 | 대응 |
| ------ | ---- | ---- |
| **README 병합 충돌** | 높음 | 4.4 체크포인트대로 d0efd19 정정 + 4de8699 보강 보존. 병합 후 README 육안 검토 |
| `b46902a`가 main 정정(d0efd19)을 되돌림 | 중간 | 병합 후 README에서 "팔로워 배지 호버 툴팁" 문구/표 행이 **없는지** 검색 확인 |
| dev 파일이 스토어 zip에 포함 | 중간 | 4.3 `ignoreFiles` 적용 후 zip 내용물 확인 |
| 태그 누락/형식 불일치 | 낮음 | 4.5에서 `v1.1.3` 형식 확인 후 동일하게 |
| 미커밋 라벨 변경 누락 | 낮음 | 4.1에 포함, 4.2 이력에 반영 |

**병합 후 정정 보존 확인 명령(예):**

```
git grep -nE "팔로워.*호버|배지.*툴팁|마우스를 올리면 정확한" -- README.md
# 결과가 없어야 정상 (d0efd19 정정이 유지된 상태)
```

---

## 6. 롤백 절차

- **태그 생성 전:** `git reset --hard origin/1.1.4`로 로컬 작업 폐기 가능(미push 상태 한정).
- **태그 push 후 문제 발견:** `v1.1.4` 태그 삭제 후 재작업.
  ```
  git push origin :refs/tags/v1.1.4   # 원격 태그 삭제
  git tag -d v1.1.4                    # 로컬 태그 삭제
  ```
- **main 병합 되돌리기:** 머지 커밋을 `git revert -m 1 <merge-sha>` 로 되돌림(히스토리 보존).

---

## 7. 최종 체크리스트

- [ ] `node --test` 9/9 통과
- [ ] `eslint .` 통과
- [ ] 워킹 트리 클린(`git status` 비어 있음)
- [ ] `manifest.json` / `package.json` / `package-lock.json` / README 버전 = 1.1.4
- [ ] `docs/update-history.md`에 `## 1.1.4 (2026-06-02)` 섹션 존재
- [ ] `AGENTS.md` / `docs/refactoring-guide.md` 처리 결정 완료
- [ ] `main` 병합 완료, README에 d0efd19 정정·4de8699 보강 모두 반영
- [ ] README에 "팔로워 배지 호버 툴팁" 문구/표 행 없음(검색 확인)
- [ ] `v1.1.4` 태그 생성·push, `main`·`1.1.4` push
- [ ] `web-ext lint` 통과, `web-ext build` zip 생성 및 내용물 확인
- [ ] GitHub Release 작성(1.1.4 노트 첨부)

---

## 부록: 결정 필요 항목 요약

1. **`AGENTS.md` 저장소 커밋 여부** — 커밋(권장: 도구 설정) vs `.gitignore`.
2. **`docs/refactoring-guide.md` 커밋 여부** — 커밋 vs 언트래킹 유지.
3. **`main` 병합 방식** — `--ff-only`(깔끔한 선형) vs `--no-ff`(명시적 릴리스 머지 커밋).
4. **라벨 변경(monthlyBroadcastTime)** — 1.1.4 포함 여부 및 이력 표기.
5. **빈 `## 미출시` 섹션 유지 여부** — 다음 작업용으로 남길지.
