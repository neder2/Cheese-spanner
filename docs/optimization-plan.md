# Better Chzzk 성능 최적화 계획 (플랜 1~6)

작성 기준 커밋: `b2d2062` (v1.2.0). 2026-07-03 성능 감사(6개 영역 병렬 감사) 결과를 실행 계획으로 정리한 문서입니다.

## 공통 규칙 (모든 플랜에 적용)

- **성능 개선만 수행합니다.** 기능 동작, UI, 옵션 의미가 바뀌는 변경은 금지합니다. 각 수정은 "같은 결과를 더 적은 비용으로"가 원칙입니다.
- 본문의 `파일:줄` 표기는 커밋 `b2d2062` 기준입니다. 줄 번호는 밀릴 수 있으므로 **함께 적힌 함수/식별자 이름으로 위치를 재확인**한 뒤 수정합니다.
- 플랜당 커밋을 분리합니다. 커밋 제목은 AGENTS.md 규칙(`Better Chzzk <version>`)을 따릅니다.
- 각 플랜 완료 시 `npm test`, `npm run lint`, `npm run format:check`를 통과해야 합니다. 기존 테스트(`tests/`)가 깨지면 우회하지 말고 원인을 파악합니다.
- 공용 유틸은 `content.js`의 `BetterChzzk.utils`에 이미 있습니다: `createThrottledDomSync`(rAF+최소 간격 스로틀), `createMutationObserverSync`, `startPageChangeDetection`, `bindFeatureOptions`. 새 유틸을 만들기 전에 이들을 우선 사용합니다.
- 배경 지식: MutationObserver의 특성상 **값이 같아도 `setAttribute`/`className` 할당은 mutation record를 생성**합니다. 이 성질이 기능 간 상호 트리거 루프(플랜 2)의 원인입니다.

---

## 플랜 1 — chatTools 증분 처리 전환 (라이브 시청 상시 CPU 제거)

**대상**: `features/chatTools.js`
**문제**: 라이브 채팅은 초당 수십 건의 DOM 변경을 만드는데, 현재 120ms 스로틀마다 화면의 **모든** 채팅 row를 처음부터 다시 파싱합니다. row 1개 파싱에 `querySelectorAll("*")` 3~4회 + `getComputedStyle` 수십 회가 들어 라이브 시청 중 상시 CPU 점유의 주범입니다.

### 작업 항목

1. **처리 완료 row 스킵**: `syncChatTools`(chatTools.js:1475-1479)가 `findChatRows()` 전체에 `parseChatMessage()`(:807-816)를 무조건 실행 중. 이미 존재하는 `BLIND_PROCESSED_ATTR` / `MODERATOR_COLLECTED_ATTR` 마킹을 재파싱 스킵 조건으로 사용하고, mutation의 `addedNodes` 기반 증분 처리로 전환합니다. 단, blind 처리(가려진 메시지 복원)는 기존 row의 attr/텍스트 변경으로도 발생하므로, 그 경로는 해당 row만 재검사하도록 남겨야 합니다.
2. **row당 스캔 통합**: row 1개에 대해 `collectAttributeTextCandidates`(:610), `pickHiddenOriginalText`(:710), `getRoleSignalElements`(:745), `getTreeAttrText`(:471-480)가 각각 `querySelectorAll("*")` 전수 순회를 반복합니다. **1회 순회로 attr/hidden/role 신호를 동시 수집**하도록 통합하고, `isElementHidden`(:482-493)/`isHiddenWithin`(:495-503)의 `getComputedStyle` 결과를 row 파싱 스코프에서 캐시합니다.
3. **모더레이터 목록 diff 렌더**: `renderModeratorList`(:1043-1081)가 매 sync(:1482)마다 `textContent=""` 후 최대 100개 버튼을 재생성합니다. 메시지 배열의 버전/카운트를 비교해 변경 시에만 렌더하고, 가능하면 신규분만 append합니다.
4. **채팅 루트 없는 페이지 가드**: 채팅 루트를 못 찾으면 `content.js:283-293`의 bodyObserver가 documentElement 전체를 무스로틀 감시하며 매 배치 `findChatRoot`(:1433-1461)의 문서 전체 폴백 스캔이 실행됩니다. `isLiveRoute()`일 때만 옵저버를 설치하거나, 루트 재탐색을 스로틀합니다.
5. **옵저버 감시 축소**: `startObserver`(:1487-1505)의 `characterData:true` + attribute 6종 감시를 childList(addedNodes) 위주로 좁히고, blind 감지에 필요한 attr 변경만 `shouldSchedule`로 통과시킵니다.
6. **findChatRows 중복 제거 O(n²) → O(n)**: `:1424-1430`의 `rowList.some((other) => other.contains(row))`를 부모 마킹(Set) 기반 1-pass로 교체합니다.
7. **모더레이터 캐시 persist 디바운스**: `collectModeratorMessage` → `persistModeratorCache`(:920-947, 호출부 :1029-1030)가 메시지 1건마다 storage 전체 read+write를 수행합니다. 수백 ms~수 초 디바운스를 넣되, `pagehide`/`visibilitychange`에서 flush해 유실을 방지합니다.

### 회귀 주의

- blind 메시지 복원, 모더레이터 메시지 수집·클릭 스크롤 이동이 증분 전환 후에도 동작해야 합니다. `tests/chat-tools.test.js`가 기준선입니다.

### 검증

- `npm test` 통과.
- 라이브 방송 페이지에서 DevTools Performance 10초 녹화: 채팅 유입 중 `syncChatTools` 관련 스크립팅 시간이 전환 전 대비 뚜렷이 감소하는지 확인. 이미 처리된 row가 재파싱되지 않는지 임시 콘솔 카운터로 확인 후 카운터 제거.

---

## 플랜 2 — 무변경 DOM 쓰기 제거 (기능 간 상호 트리거 루프 차단)

**대상**: `features/skipControl.js`, `features/timeMachineLagLabel.js`, `features/vodBroadcastClock.js`
**문제**: 값이 같아도 매 sync마다 `setAttribute`/`className`을 재작성해 mutation record가 계속 생성되고, 이것이 서로의 MutationObserver(attributeFilter)에 걸려 **두 기능이 각자의 스로틀 상한(160ms/50ms)으로 영구 상호 구동**됩니다. 라이브 재생 중 유휴 상태가 사라지는 원인이며, 수정 자체는 "쓰기 전 현재값 비교" 수준으로 작습니다.

### 작업 항목

1. `features/skipControl.js` — 쓰기 전 값 비교 추가:
    - `:1226-1231` `button.className = ...` (현재값과 다를 때만 할당)
    - `:1162-1164` pill의 `className`
    - `:1245-1247` label/aria-label/tooltip `setAttribute`
2. `features/timeMachineLagLabel.js`:
    - `:544` `button.setAttribute(TEXT_PATCHED_ATTR, "1")` — 이미 `"1"`이면 생략
    - `:539` nodeValue 쓰기 — 값 비교 후 변경 시에만 (자기 옵저버 characterData 재트리거 방지)
3. `features/vodBroadcastClock.js`:
    - `applyClockTitle`(:1034-1036) — 비교 없이 title을 쓰고 있음. 비교 추가
    - `:1231-1245` 매 tick title+aria-label 쓰기 — 비교 후 변경 시에만

### 트리거 경로 참고 (수정 후 소멸해야 하는 루프)

- skipControl의 className 쓰기 → timeMachineLagLabel 옵저버(attributeFilter에 `class`, timeMachineLagLabel.js:697)
- timeMachineLagLabel의 `TEXT_PATCHED_ATTR` 쓰기 → skipControl 옵저버(attributeFilter에 `LIVE_EDGE_PATCHED_ATTR`, skipControl.js:1648-1660)
- vodBroadcastClock의 title/aria-label 쓰기 → skipControl 옵저버("playback" 모드 attributeFilter에 title/aria-label 포함)

### 검증

- 라이브 재생 페이지를 열고 조작 없이 10초 방치한 상태에서, 임시 MutationObserver 카운터(또는 Performance 녹화)로 skipControl/timeMachine sync가 채팅 유입 외 요인으로 반복 실행되지 않는지 확인.
- 라이브 되감기/실시간 버튼 라벨, 스킵 pill 툴팁, VOD 방송 시각 클록이 전과 동일하게 갱신되는지 수동 확인.

---

## 플랜 3 — non-passive wheel 리스너 게이트 수정 (스크롤 지연 제거)

**대상**: `features/volumeWheelPage.js`, `features/skipControl.js`
**문제**: window에 non-passive(capture) wheel 리스너가 있으면 브라우저는 **모든 휠 스크롤에서 메인 스레드 핸들러 완료를 기다립니다**. 핸들러 실행 비용보다 스크롤 시작 지연 자체가 체감 문제입니다. `preventDefault`가 필요하므로 non-passive 자체는 불가피하며, **설치 범위/시점을 좁히는 것**이 목표입니다.

### 작업 항목

1. `features/volumeWheelPage.js` — 기능 off인데도 리스너 설치됨:
    - `syncWheelListener`(:292-295)가 `isPlaybackRoute()`만 검사. enabled 상태 검사를 추가해 `enabled && isPlaybackRoute()`일 때만 설치하고, 옵션 변경 시 해제합니다. enabled 값은 이미 핸들러 내부(:242)에서 읽고 있으므로 동일 상태 소스를 게이트에서 사용하면 됩니다(MAIN world 파일이므로 chrome API 직접 접근 금지 — 기존 상태 전달 방식 유지).
2. `features/volumeWheelPage.js` — 핸들러 검사 순서 역전(:241-257):
    - 현재: `getMainVideoElement()`(:199, `querySelectorAll("video")`+rect+computedStyle) 실행 **후** `getVolumeControlAt()`(:144, composedPath 순회) 실행.
    - 변경: composedPath에서 볼륨 컨트롤 후보를 먼저 확인하고 없으면 즉시 반환. video 탐색은 컨트롤 확인 후 마지막에 수행.
3. `features/skipControl.js` — 재생 페이지 이탈 후 리스너 잔존:
    - 설치는 `ensureSkipPillInjected`(:1527) 경유 `:1412`, 해제는 `teardownRuntime`(:1872)뿐. `handlePageChange`의 비재생 분기(:1588-1594)에서도 wheel 리스너를 해제하거나, 리스너를 window 대신 pill 요소에 직접 바인딩합니다.

### 회귀 주의

- 볼륨 컨트롤 위에서 휠 볼륨 조절, 스킵 pill 위에서 휠 스킵 초 조절이 전과 동일해야 하고, 그 위에서는 페이지 스크롤이 여전히 막혀야 합니다(preventDefault 유지).

### 검증

- 홈(`chzzk.naver.com`)으로 이동한 뒤 DevTools 콘솔에서 `getEventListeners(window).wheel`(또는 임시 로그)로 잔존 리스너가 없는지 확인.
- 볼륨휠 옵션을 끈 상태로 /live 페이지에서 wheel 리스너가 설치되지 않는지 확인.

---

## 플랜 4 — autoQualityPage VOD 무한 적용 루프 차단

**대상**: `features/autoQualityPage.js` (MAIN world)
**문제**: VOD 재생 중 `timeupdate`(초당 ~4회)마다 화질 적용 파이프라인 전체가 재실행됩니다. startup 안정화(settle) 이후에도 적용 윈도우가 계속 연장되어, 설계상의 8초 윈도우/정지 조건이 무력화됩니다. 매회 video 재탐색 + 트랙별 문자열 빌드(초당 ~100회 문자열 생성, GC 압력) + `JSON.stringify` 상태 기록이 반복됩니다.

### 작업 항목

1. **핵심**: `onVodStartupProgress`(:1129-1138, 특히 :1137)가 settle 후에도 매 timeupdate마다 `startPageAutoApply(5000)` → `extendPageApplyWindow`(:1430)로 deadline을 now+5s로 연장 → 즉시 `runPageApply` 실행. **`vodStartupSettled` 이후에는 timeupdate 리스너를 제거하거나 `startPageAutoApply` 호출을 건너뛰도록** 수정합니다. (리스너 부착부: :1046-1050)
2. apply 1회 스코프 캐싱: 한 번의 `applyQuality()` 경로에서 `getMainVideo()`가 `shouldDeferVodStartupQuality`(:1123), `ensureVodPlaybackGuardAttached`(:1036), `getPlayer`(:824), `applyQualityToPlayer`(:1316)에서 각각 독립 호출됩니다(호출당 querySelectorAll+rect+computedStyle). apply 1회 스코프에서 video 참조와 트랙별 `trackText()`(:868-917) 결과를 로컬 캐시합니다.
3. `hasVisibleVodResumeControl`(:1081-1089): 문서 전체 `button, a, [role='button']` 전수 + 요소마다 rect/computedStyle. 결과를 짧게(~200ms) 캐시하거나 탐색 범위를 플레이어 루트 하위로 한정합니다.
4. defineProperty 인터셉터 폴스루(:624-676): 래퍼 첫 줄에서 `prop !== "videoTracks"`(defineProperties는 `"videoTracks" in descriptors`)이면 즉시 네이티브로 폴스루하고, `isPlaybackRoute()` 정규식 평가 결과를 라우트 변경 이벤트 시점에 boolean으로 캐시합니다. `Object.defineProperties` 래퍼(:642-658)의 전 키 복사도 videoTracks가 없으면 생략합니다.
5. (선택) `document.querySelectorAll("*")` 전체 스캔 폴백(:810-817): tracked target+셀렉터 스캔으로 한정하거나 스캔 상한/네거티브 캐시를 도입합니다.

### 회귀 주의

- VOD 진입 직후 화질 적용, 이어보기(resume) 상황에서의 지연 적용, 라이브 화질 적용이 전과 동일해야 합니다. 이 파일은 과거 회귀가 잦았던 영역이므로(docs/ 이력 참고) 수동 검증을 충분히 합니다.

### 검증

- VOD 재생 30초 동안 임시 카운터로 `runPageApply` 실행 횟수 측정: settle 후 0회여야 함(현재는 초당 ~4회). 확인 후 카운터 제거.
- VOD/라이브 각각에서 설정 화질이 실제 적용되는지 수동 확인.

---

## 플랜 5 — 목록 페이지 스캔·스로틀 정비 (categoryTools / videoSearch / monthlyBroadcastTime)

**대상**: `features/categoryTools.js`, `features/videoSearch.js`, `features/monthlyBroadcastTime.js`
**문제**: 세 파일 모두 rAF 병합만 자체 구현하고 공용 `createThrottledDomSync`(최소 160ms 간격 보장)를 쓰지 않아, 무한 스크롤/리렌더 중 **매 프레임 문서 전체 스캔**이 가능합니다. 스캔 자체도 광범위 셀렉터(`button, a, span, div`) + 요소마다 rect/computedStyle로 비쌉니다. 5-A/5-B/5-C를 각각 별도 커밋으로 진행합니다.

### 5-A. categoryTools

1. `scheduleApply`(:3293-3312)를 `createThrottledDomSync(runApply, 160)` 기반으로 교체(현재 rAF 병합만 있고 최소 간격 없음).
2. **applyTools 1회 스코프 캐싱**: `findCardLinks`(:1097-1117)가 문서 전체 `a[href]`를 배열화해 앵커마다 rect를 읽고, 서두의 `getContentLeft`/`getTabBottom`(:1054-1073)이 각각 `findTabLine`(:655-684, `document.querySelectorAll("button, a")` 전수+rect)을 중복 실행합니다. applyTools 1회 실행 스코프에서 이 결과들을 1회 계산해 인자로 전달·재사용하고, rect 필터는 그리드 확정 후 후보군에만 적용합니다.
3. `/lives` 페이지: `getGlobalSortControls`(:725-741)의 셀렉터가 `button, a, [role='button'], span, div`로 사실상 전체 DOM 스캔이며, `listStateKey()` 경유로 **applyTools 1회당 6~10회** 호출됩니다(:3146, :1148, :1154, :792-796, :1056, :1066). 실행당 1회 캐시하고, 셀렉터에서 `span, div`를 제거해 정렬 UI 컨테이너 기준으로 범위를 좁힙니다. `getGlobalSortKey`(:777-790)의 getComputedStyle 체인(:754-775)도 같은 캐시에 포함.
4. 배지 동기화 캐싱: `syncFollowerBadges`(:2219-2228)→`pickProfileImage`(:2123-2136), `syncLiveElapsedBadges`(:2317-2324)가 매 실행 카드별 이미지 전수 조회+rect 면적 계산. 카드 요소에 배지 host/프로필 이미지 참조를 expando로 캐시하고 label 변화 시에만 DOM을 갱신합니다.
5. read-then-write 배치화(:3198-3241): captureScrollAnchor(read) → syncInjectedCards(write) → getCardEntries(read) → 배지 sync → HIDE_ATTR(write) → restoreScrollAnchor(read)로 읽기/쓰기가 교차. 측정을 먼저 일괄 수행하고 쓰기를 뒤로 묶습니다.
6. 팔로워 hydration 경량 경로: `queueFollowerHydrationPass`(:1312-1318)가 결과 반영을 위해 applyTools 전체를 재실행. hydration 완료분만 배지/가시성 부분 갱신하는 경로로 분리. `handleAutoLoadScroll`(:3105-3126)의 스크롤 배지 보충도 뷰포트 근처 카드 대상 부분 갱신으로 축소(`getRowsNearViewport` :1518-1528 활용).

### 5-B. videoSearch

1. `findFilterPillGroup`(:1942-1970, 호출부 :2075 `ensureBarMounted`)이 mutation마다 `document.querySelectorAll("button, a, span, div")` 전수 + 요소별 textContent. 결과를 캐시하고 `isConnected`로 무효화 판정, `createThrottledDomSync`로 최소 간격 보장(schedule은 :2171-2190).
2. 댓글 검색 증분 렌더: `runCommentSearch`가 3개 영상 처리마다 `lastFilterKey = null; applyFilter()`(:847-848) → 전면 재클론·재주입(applyFilter :1799-1873, 최대 80카드 × 최대 20회 = 1600회 카드 빌드, 썸네일 재디코드·깜빡임). 새로 매치된 카드만 증분 추가하거나 기존 `INDEX_APPLY_INTERVAL_MS`(260ms) 패턴으로 재렌더를 스로틀합니다.
3. `alignCommentIconsToTagRows`(:1599-1619, :1568-1597): 카드마다 read(rect)→write(style) 교차로 레이아웃 스래싱. read 전부 선행 수집 후 write 일괄 적용. `handleCommentTooltipResize`(:1367-1371)의 무스로틀 resize 직결에 스로틀 적용.
4. `shouldSchedule`에 값싼 `isVideosTab()` 선행 리턴 추가(:2124-2169) — 현재 `shouldIgnoreMutations`(isOurMutation, closest 다수)가 먼저 평가되어 라이브 시청 중에도 상시 실행됨(content.js:252-253의 평가 순서 참고).

### 5-C. monthlyBroadcastTime

1. 위젯 미마운트 시 재탐색 백오프: 호스트를 못 찾으면 mutation마다 `getActionControls`(:699-779, `document.querySelectorAll("button, a")` 전수+isVisible(rect+computedStyle), 정렬 비교함수 내 rect 재계산 :713-714) + 실패 시 `findFollowerInfo`(:757-761)까지 연쇄. **재시도 간격을 점증(백오프)시키고**, rect는 map 단계에서 1회만 계산합니다.
2. `hasActiveWidgetForCurrentRoute`(:2029-2031)가 `mutationShouldSchedule`의 `some()` 안에서 mutation마다 재호출됨(:2033-2041) — 배치당 1회 평가로 호이스팅.
3. `buildCalendarRenderKey`(:1792-1839): 월간 모든 start × watchHistoryEntries 전체 `getWatchMatchScore`(:1140-1150) 스코어링이 렌더 스킵 키 계산에서 반복. (watchHistory 버전, monthKey) 기준으로 메모이즈.
4. `normalizeWatchHistory` 전량 재실행(:2115-2120, :1027-1066)이 storage onChanged마다 즉시 발생(300ms 디바운스는 리렌더에만 적용 :2101-2107). 정규화도 디바운스 뒤로 이동.
5. 달력/통계 fetch 루프(:1506-1526, :1547-1577)에 AbortController `signal` 연결(`fetchVideoPage` :902-914, `fetchVideoDetail` :1207 — 공용 `fetchJson`은 이미 signal 지원, shared/data.js:425) + 페이지 간 소량 지연 추가.

### 검증 (5 공통)

- `npm test` 통과(특히 `tests/extension-pages.test.js`).
- 카테고리 페이지에서 무한 스크롤 중 Performance 녹화: 프레임당 applyTools/ensureBarMounted 실행이 사라지고 160ms 간격으로 병합되는지 확인.
- 팔로워 배지·필터, 검색 결과 필터링, 댓글 검색, 달력 위젯이 전과 동일하게 동작하는지 수동 확인.

---

## 플랜 6 — 장기 사용 열화 방지 (storage·네트워크 반복 비용)

**대상**: `features/liveWatchHistory.js`, `features/categoryTools.js`, `history.js`
**문제**: 시청 기록이 누적될수록 매 flush 비용이 커지는 구조와, 실패 응답을 캐시하지 않아 무한 재시도하는 fetch 경로입니다. 당장 체감은 작지만 장기 사용자에게 선형 이상으로 악화됩니다.

### 작업 항목

1. **liveWatchHistory flush 증분화**: `mutateHistory`(:409-416, 호출부 :555, 주기 `FLUSH_MS = 15000` :5)가 15초마다 storage 전체 로드 → `normalizeHistory`(:278-331)로 **모든 엔트리**(상한 2000 × 세션 300) 재정규화(엔트리당 정렬 + `addTitleHistory` 경유 shared/data.js:402 `normalizeTitleHistory` 전체 재정렬) → 전체 재기록. **세션 중에는 in-memory 히스토리를 유지하고 정규화는 로드 시 1회만** 수행하거나, 변경된 엔트리만 read-modify-write 하도록 재구성합니다.
2. force flush 무변경 생략: `visibilitychange`/`pagehide` 경로(:547-548, :787-795)에서 실제 변경분(delta·leftAt 변화)이 없으면 write를 생략합니다.
3. **categoryTools 팔로워 fetch 네거티브 캐시**: `getFollowerCount`(:1433-1462)가 실패(404/네트워크 오류/값 미제공) 시 followerCache에 기록하지 않아, `hydrateFollowerIds`(:1478-1510)의 `!followerCache.has(id)` 선정 + 700ms 재큐와 맞물려 실패 채널을 **무기한 재요청**할 수 있습니다. 실패도 TTL 있는 sentinel(예: `{ value: null, expiresAt }`)로 캐시에 기록합니다.
4. history.js(확장 내부 페이지): storage onChanged마다 전체 재로드+전체 재렌더(:1342-1351 → :251-294 → :1203-1208). 라이브 시청 중 15초마다 반복되므로 onChanged 재로드에 수 초 디바운스를 넣고, `renderCalendar`(:743-799)의 일자별 `getDayEntries`(전체 엔트리 순회 × 31일)를 루프 밖 1회 집계로 교체합니다.
5. (선택) 세션당 `watchedRanges` 개수 상한: `upsertSessionDetail`(:508-513) — 200개 초과 시 오래된 것부터 인접 병합.

### 회귀 주의

- 시청 기록의 일자별 합산, 제목 히스토리, 다시보기 연결 기능이 증분화 후에도 동일한 저장 결과를 만들어야 합니다. `tests/settings.test.js` 외 관련 테스트와, 변경 전후 storage 스냅샷 비교로 확인합니다.

### 검증

- 라이브 30분 시청 시나리오(또는 시뮬레이션)에서 flush당 처리 시간이 히스토리 크기와 무관해지는지 확인.
- 네트워크 탭에서 존재하지 않는 채널의 팔로워 API가 1회 실패 후 TTL 내 재요청되지 않는지 확인.

---

## 부록 — 백로그 (플랜 1~6 미포함, 후속 검토)

감사에서 확인됐지만 위 플랜에 넣지 않은 항목입니다. 플랜 완료 후 별도 작업으로 검토합니다.

| 파일                                | 위치                                      | 내용                                                                                                                                                          | 심각도          |
| ----------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| features/vodReplayChatFix.js        | :79-81, :183                              | fix 대기 중(최대 ~22초) mutation 배치마다 `document.body.textContent` 전체 직렬화 — `hasReplayChat` 판정을 500ms 스로틀 내부로 이동 + 라우트당 캐시           | 높음(기간 한정) |
| features/vodBroadcastClock.js       | :1038-1072, :1080-1101, :453-478          | 제목 히스토리 있는 VOD에서 매 tick 문서 전체 제목 재탐색(cloneNode 포함) + 접힌 패널 재생성 + 클록 reference 재탐색 — 요소 캐시(isConnected 검증) + diff 렌더 | 높음(조건부)    |
| features/skipControl.js             | :1621-1631, :370-375, :104-109+:1487-1491 | 옵저버 타깃을 플레이어 컨테이너로 축소(채팅 제외), 500ms interval을 timeupdate 수신 중·hidden 시 정지, sync 1회당 동일 주입 로직 2회 실행 정리                | 높음/중간       |
| features/timeMachineLagLabel.js     | :89, :656-699, :236-250                   | 50ms 스로틀 상향(150ms+) + 옵저버 타깃 축소, 라이브 엣지 경계에서 버튼 풀 스캔 반복 — 마지막 매칭 버튼 우선 재검증                                            | 높음/중간       |
| features/volumeTooltip.js           | :604-635, :212                            | 오디오 컴프레서 런타임이 off여도 설치되고 옵저버 참조를 안 보관해 해제 불가 — teardown 경로 신설                                                              | 중간            |
| features/adblockPopup.js            | :275-282, :237-247                        | 옵저버 콜백에서 스로틀 없이 `removeAdsPopup` 직접 실행 — `createThrottledDomSync`(150~250ms) 적용                                                             | 중간            |
| features/rewardAutoCollect.js       | :136-151, :64-83, :241-271                | (기본 off) 스캔당 후보 수백 개 `innerText`(강제 스타일 계산) — 저렴한 필터 선행, 옵저버 타깃을 `aside#aside-chatting`으로 축소                                | 높음(활성 시)   |
| features/followingPreviewTooltip.js | :514-534, :1277-1304, :1444-1447          | pointerover마다 조상 textContent 스캔(WeakMap 캐시 필요), 동일 아이템 내 재배치 리플로우, scroll 핸들러 조기 반환                                             | 중간/낮음       |
| features/chatTools.js               | :1021-1027                                | moderatorMessages의 node 참조가 detached DOM 최대 100개 보존 — id 보관 방식 검토                                                                              | 낮음            |
| features/videoSearch.js             | :664-694, :864-887                        | 인덱스 fetch 직렬 루프에 페이지 캐시·소량 지연, updateStatus의 필터 중복 계산 공유                                                                            | 중간/낮음       |
| features/skipControl.js             | :180-186                                  | 휠 스킵 초 변경마다 `chrome.storage.sync.set` — 쿼터(분당 120) 근접 가능, 디바운스 병합                                                                       | 낮음            |
| content.js                          | :137-141, :151-153                        | 문서 클릭마다 setTimeout 4개(0/80/250/800ms) 라우트 체크 — routeBridge pushState 이벤트가 있으므로 지연 배열 축소 검토                                        | 낮음            |
| features/autoQualityPage.js         | :427-432, :450-462                        | 전역 입력 리스너 8개를 VOD 라우트에서만 설치                                                                                                                  | 낮음            |

## 감사에서 확인된 "건드리지 말 것" (현재 잘 되어 있는 부분)

- 전 파일의 teardown 경로(타이머·옵저버·리스너 대칭 해제)와 LRU/TTL 캐시 상한 — 메모리 누수 미발견.
- storage 설계: 옵션은 `shared/settings.js`의 프로세스 공유 캐시+단일 onChanged, 시청 기록은 local, options.js의 400ms 디바운스+동등성 가드.
- `background.js`: onInstalled 단일 리스너뿐인 순수 이벤트 구동 — 유지.
- followingPreviewTooltip의 AbortController+requestToken+디바운스+LRU 조합, monthlyBroadcastTime의 promise 기반 페이지 캐시(`fetchVideoPageCached`), followingRefresh의 visibility/online 가드.
