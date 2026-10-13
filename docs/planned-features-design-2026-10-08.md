# 미구현 계획 5개 설계·수용 기준 — 2026-10-08

## 위임 범위와 근거

2026-10-08 사용자가 `docs/tracking/status.md`의 미구현 계획 5개(채팅 위치·높이, 사이드바 위치·높이, 팔로잉 폴더, 채팅 멀티뷰, 설정 파일 저장·불러오기)의 구현·디자인·세부 설계를 Claude에게 위임했고 Codex가 감독·검수를 맡았어요. 아래 세부 동작은 이 위임에 따라 Claude가 정한 설계예요. 사용자가 개별 항목을 확인한 결정은 아니므로 이후 사용자 결정이 있으면 그 결정이 우선해요.

작업 기준은 이 저장소의 `1.4.3` branch, HEAD `d358a420bd0f54e9624ed6b98a918da2be4b2644`, 작업 시작 시 추적 diff 없음이에요. 커밋·버전·릴리스는 범위 밖이에요.

## 실제 화면 근거와 한계

- 2026-10-08 23:21 KST 인증정보 없는 `curl`로 `https://chzzk.naver.com/live/feb20a676694b1163fed010da0848303/chat`과 같은 채널의 `/live/…` 응답 헤더를 확인했어요. 둘 다 `HTTP/2 200`, `content-security-policy: frame-ancestors 'self' https://naver.com https://*.naver.com`이었고 `X-Frame-Options`는 없었어요. 같은 출처(`chzzk.naver.com`) 문서가 이 경로를 프레임으로 넣는 것을 사이트 정책이 허용한다는 근거예요. **실제 프레임 로딩·로그인 상태·채팅 입력 대상·전송 성공은 확인하지 않았어요.**
- 같은 시각 라이브 HTML이 참조하는 공개 CSS `index-B5SHICxp.css`에서 사이드바 `._container_1b725_2{position:fixed;top:0;left:0;width:82px;z-index:9999}`, 펼침 `width:240px`, 1199px 이하 펼침 오버레이의 `:before{position:fixed;top:0;bottom:0;left:0;right:0;width:100vw}`, 본문 `._body_duf89_11{padding-left:82px;display:flex}`와 1200px 이상 펼침 `padding-left:240px`, 상위 `._glive_duf89_1{min-width:950px}`를 확인했어요. 채팅·VOD aside 구조는 [2026-09-28 패널 너비 실측](measurements/panel-resize-2026-09-28.md)을 따라요.
- 이번 세션의 내장 브라우저는 `https://chzzk.naver.com is not allowed due to safety restrictions`로 치지직을 열지 못했고, Claude in Chrome 커넥터는 연결되지 않았어요. 실제 Chrome 화면 확인은 Codex 검수 항목으로 남겨요.

## 1. 채팅 위치·높이

- **위치:** `chatPosition`(`right` 기본·`left`). 라이브 `#aside-chatting`, VOD `#vod-aside`, 확장 댓글 전용 `#betterchzzk-vod-comment-aside`에 같은 위치를 적용해요. 네이티브 노드를 옮기지 않고 확장 marker와 CSS `order`만 사용해요. 모아보기 상자와 VOD 댓글 탭은 채팅 안에 있으므로 함께 움직여요.
- **적용 조건:** 너비 조절과 같은 조건(일반 라이브·다시보기, 부모가 가로 flex, 영상 열이 보임, 화면 안에 나란히 있음)에서만 적용해요. 접힘·세로 쌓임·전체화면·채팅 팝업·임베드·클립·같이보기 오른쪽 배치는 원래 배치를 유지해요.
- **너비 경계:** 왼쪽에 둔 채팅은 오른쪽 경계에서 조절하고 드래그 방향도 뒤집어요. 라이브 채팅의 원래 바깥 구분선도 영상 쪽으로 옮겨요.
- **높이(2026-10-08 감독 보완 반영):** 라이브 채팅·다시보기 채팅·댓글 영역 자체의 표시 높이를 하단 경계 드래그로 줄일 수 있어요. 기본은 원래 높이(지정 없음)이고 범위는 240px부터 확장이 높이를 지정하지 않았을 때의 원래 표시 높이까지예요. 더블클릭하면 기본 높이로 돌아가요. 라이브 채팅은 세로 flex라 메시지 목록만 줄고 입력 영역(`flex:none`)은 유지되며, 댓글 전용 영역도 내부가 세로 flex예요. 채팅 크기 조절(`chatResizeEnabled`)의 일부이고 모아보기 설정과 무관해요. 높이는 local `betterchzzk:panel-resize:chat-height:v1`(null 또는 1~8192 정수)에 너비와 같은 수명 규칙으로 저장해요. 경계는 너비와 같은 확정 결정(마우스 전용, 초점 없음)을 따르고, 키보드 사용자는 옵션의 `저장한 크기 초기화` 버튼으로 너비·높이 선택을 기본으로 돌릴 수 있어요.
- **모아보기 높이:** 확장 소유 모아보기 상자의 최대 높이(`chatToolsModeratorBoxHeight`, 240~720px, 기본 420px=현재값)도 따로 조절할 수 있어요. 화면 높이 제한(`100vh - 120px`)은 유지해요.
- **수용 기준:** 기본값에서 DOM·스타일 변화 없음, 왼쪽 선택 시 순서·경계·드래그 방향 반전, 높이 드래그·더블클릭 복원·원래 높이 상한·저장 실패 시 현재 문서 유지, OFF·조건 이탈 시 marker 정리, 저장 너비 키·형식 불변.

## 2. 사이드바 위치·높이

- **위치:** `sidebarPosition`(`left` 기본·`right`). 사이드바의 `left/right`와 본문 여백 방향만 확장 marker로 바꿔요. 원래 본문 여백 값은 marker를 잠시 뺀 같은 작업 안에서 읽어 그대로 오른쪽 여백으로 옮기고, 사용자 지정 너비가 있으면 그 너비를 사용해요. 1199px 이하 펼침 오버레이의 딤 배경도 오른쪽 기준으로 맞춰요.
- **같은 쪽 순서:** 사이드바는 항상 화면 가장자리, 채팅은 그 안쪽이에요(왼쪽: 사이드바·채팅·영상, 오른쪽: 영상·채팅·사이드바).
- **일시 해제:** 넓은 화면(사이드바 없음), 전체화면, 가로 넘침(원래 최소 폭 950px보다 좁음)에서는 원래 왼쪽 배치로 돌아가요. 선택값은 바꾸지 않아요.
- **미리보기·툴팁:** 팔로잉 미리보기 카드는 이미 오른쪽 공간이 부족하면 행 왼쪽에 표시해요. 접힌 사이드바의 네이티브 항목 툴팁(`._tooltip_bwftz_133{left:100%;padding-left:17px}`)과 툴팁 표시 영역(`._content_1b725_30._show_tooltip_1b725_35{margin-right:-200px;padding-right:220px}`)은 `features/panelResize.js`의 위치 스타일이 소유해 오른쪽 배치에서 왼쪽으로 미러링해요. 클래스 해시가 바뀌어도 `[class*="_show_tooltip_"]`, 항목 안의 단일 클래스 `_tooltip_*`로 찾아요. 실제 Chrome에서 접힌 오른쪽 사이드바의 채널·메뉴 hover 툴팁이 왼쪽에 보이고 잘리지 않는지가 Codex 검수 항목이며, 어긋나면 같은 파일에서 고쳐요.
- **높이:** 사이드바 외곽은 화면 높이 전체예요. 긴 팔로잉 목록이 아래 구역을 밀어내지 않도록 팔로잉 목록의 최대 표시 행 수(`followingListMaxRows`, 0~30 정수, 0=제한 없음)를 정하고 목록 안에서 스크롤해요.
- **수용 기준:** 기본값에서 변화 없음, 오른쪽 선택 시 `left:auto/right:0`과 본문 `padding-right`, 너비 조절 경계·방향 반전, 접힘·오버레이·넓은 화면·전체화면 전환 뒤 원래 상태 복원, 행 수 제한이 원본 행을 옮기거나 숨기지 않음.

## 3. 팔로잉 폴더

- **저장:** Chrome sync `betterchzzk:following-folders:v1`. 최대 10개 폴더, 이름 1~20자, 전체 채널 지정 150개, 한 채널은 한 폴더에만 속해요(같은 원본 행을 두 곳에 보여 줄 수 없기 때문이에요). 저장 직렬화 크기가 sync 항목 한도 안인지 저장 전에 확인해요.
- **표시:** `followingFoldersEnabled`(기본 꺼짐). 팔로잉 목록에 확장 소유 폴더 머리 행을 붙이고 CSS `order`로 폴더별로 묶어요. 폴더 안에서는 고정→방송 중→고정 오프라인→오프라인 순서이며 고정 기능의 오프라인 상단 옵션을 따라요. 폴더 밖 채널은 마지막의 `폴더 밖 채널` 머리 아래에 기존 순서로 남아요. 원본 행은 옮기거나 복제하지 않아요.
- **접기:** 폴더 머리 버튼(`aria-expanded`)으로 접고 펼치며 상태는 같은 저장값에 남아요. 오프라인 숨김·목록 접기 기억·고정과 독립이에요.
- **관리(2026-10-08 설계, 2026-10-11 변경):** 아래 관리 패널은 2026-10-11 사용자 결정으로 없애고 사이드바 직접 조작(새 폴더 버튼·끌어 놓기·더블클릭 이름 변경·⋯ 메뉴·채널 선택 창·되돌리기)으로 바꿨어요. 현행 기준은 [업무 규칙](business-rules.md#팔로잉-폴더)이에요. 당시 설계: 팔로잉 새로고침 버튼 옆 `팔로잉 폴더 관리` 버튼이 비모달 패널을 열어요. 만들기·이름 변경·위/아래 이동·두 번 눌러 삭제, 폴더별 채널 추가(현재 목록에 보이는 채널 선택)·빼기를 모두 키보드로 할 수 있어요. 마우스로는 팔로잉 링크를 폴더 머리에 끌어 넣을 수 있어요. 폴더 삭제는 지정만 지우고 실제 팔로우를 바꾸지 않아요.
- **한계:** 원본 목록이 접혀 일부 채널만 렌더링되면 그 채널만 묶어 보여요. 키보드 탭 순서는 원래 DOM 순서예요.
- **수용 기준:** 단일 소속·상한·이름 검증, 저장 실패 시 이전 상태 유지·안내, 다른 탭의 변경 반영, 행 재사용·목록 교체 뒤 현재 href 기준으로 다시 판정, OFF 시 marker·머리 행 정리.

## 4. 채팅 멀티뷰

- **연결 방식:** 치지직이 제공하는 네이티브 채팅 팝업 경로 `https://chzzk.naver.com/live/{32자리 채널 ID}/chat`만 같은 출처 프레임으로 표시해요. 위 CSP 근거 외의 주소·`srcdoc`·원격 플레이어·새 창·새 탭·확장 자체 채팅 소켓은 사용하지 않아요. 로딩 실패는 해당 칸에만 실패와 다시 시도를 보여 주고 다른 경로로 대체하지 않아요.
- **표시:** `chatMultiviewEnabled`(기본 꺼짐). 헤더 오른쪽 도구 영역의 `채팅 멀티뷰` 버튼이 비모달 패널을 열어요. 최대 4개 채팅을 가로로 나란히 보여 주며 각 칸 머리에 채널 이름과 `입력 대상: {채널}`을 표시해요. 채팅 입력·로그인·작성 권한은 각 프레임의 치지직 화면이 그대로 소유해요.
- **조작:** 채널 URL·ID 입력 또는 채널명 검색(최대 5개 결과)으로 추가, 칸별 앞/뒤 이동·제거, 패널 크기(작게·보통·크게)와 위치(오른쪽 아래·왼쪽 아래) 버튼, 마우스 크기 조절, Escape 닫기를 제공해요. 구성·크기·위치는 확장 local `betterchzzk:chat-multiview:v1`에 남고 열림 상태는 저장하지 않아 새로고침이 채팅을 자동으로 다시 열지 않아요.
- **부작용 경계:** manifest 콘텐츠 스크립트와 동적 광고 등록은 최상위 프레임에만 주입돼요(`all_frames` 없음, `allFrames:false`). 따라서 프레임 안에서는 시청 기록·내 채팅 기록·재생 제어·알림·보상 수령이 실행되지 않으며, 프레임에서 보낸 채팅은 내 채팅 기록에 들어가지 않아요. 영상 멀티뷰와 독립이고, 채널 페이지의 기존 `채팅` 링크는 현재 탭을 그 채널 라이브 화면으로 이동하는 별도 기능이에요.
- **수용 기준:** 프레임 주소가 검증된 채널 ID의 채팅 경로뿐임(정적 검사 포함), 중복·상한·잘못된 입력 거절, 늦은 검색·조회 응답 폐기, 닫기·OFF·pagehide에서 프레임 제거, 주입 범위 회귀 검사.

## 5. 설정 파일 저장·불러오기

- **포함:** sync 옵션 전체(테마 포함), 팔로잉 고정 채널, 팔로잉 폴더, local의 사이드바·채팅 너비, 방송 알림·자동 입장 대상 채널, 멀티뷰 채널별 목표 딜레이·보조 화질, 채팅 멀티뷰 구성.
- **제외:** 시청·채팅·후원 기록, 방송 알림 처리 상태·확인 시각, 새 기능 안내 상태, 컴프레서 탭별·기본 선택, 플레이어에서 끈 앰비언트 선택, 옵션 묶음 접힘·마지막 탭, 사이트 sessionStorage의 멀티뷰 구성, 권한 승인 상태, 로그인·쿠키·토큰. 카테고리·태그 제외는 전체 방송 탭 전용 워커 큐와 발신자 경계에 묶여 있고 전체 교체 명령이 없으므로 이번 형식에서 제외해요.
- **형식:** `kind:"cheese-spanner.settings-backup"`, `formatVersion:1`, `extensionVersion`, `createdAt`, `sync`, `local`. UTF-8 JSON 1 MiB 이하. 알 수 없는 최상위·구역 필드는 거부하고, 이후 버전에서 늘어날 수 있는 옵션 키만 무시 목록으로 안내해요. 값은 기존 정규화·검증 함수로 엄격히 확인하며 잘못된 값을 절삭해 쓰지 않아요.
- **불러오기:** 파일 선택 → 검증 → 워커가 현재 값과 비교한 미리보기(구역별 변경, 무시 항목, 필요한 권한, 현재 값 지문) → 확인 → 권한 요청(옵션 문서의 사용자 동작) → 워커 적용. 파일 읽기와 미리보기는 저장하지 않아요. 파일에 없는 구역은 현재 값을 유지하고, 멀티뷰 채널별 값은 파일에 있는 채널만 덮어써요. 저장하지 않은 옵션 변경이 있으면 시작하지 않아요.
- **직렬화 경계(2026-10-08 감독 2차 보완):** 백업 대상 키를 쓰는 모든 writer가 같은 **설정 저장 잠금**을 공유해요. 잠금은 확장 출처의 Web Lock `betterchzzk:options-storage`(`withOptionsStorageLock`)이고 옵션 페이지와 서비스 워커가 함께 사용해요.
    1. 콘텐츠 문서는 사이트 출처라 이 잠금을 직접 얻을 수 없어요. 그래서 고정 채널·폴더·패널 너비/높이·멀티뷰 딜레이/화질·채팅 멀티뷰 구성과 콘텐츠가 바꾸는 sync 옵션(`skipSeconds`, `ambientIntensity`, `followingPreviewSoundEnabled`)은 `BetterChzzk.utils.settingsStoreSet(area, values)`로 워커의 **설정 저장 큐**(`betterchzzk:settings-store`)에 요청해요. 워커는 같은 확장·최상위 치지직 탭의 발신자와 키 allowlist·값 형식을 검증하고 잠금 안에서 저장한 뒤 결과를 응답해요. 시청 기록·카테고리 제외·안내 큐와는 분리돼요.
    2. 옵션 페이지의 옵션 저장·기본값 복원, 워커의 설치 정규화, 예전 채팅 도구 옵션 이전은 같은 잠금 안에서 써요. 예전 옵션 이전은 확장 출처 문서에서만 실행해요.
    3. 방송 알림 대상의 읽기-수정-쓰기는 기존 방송 큐 순서를 유지하면서 그 안에서 같은 잠금을 잡아요.
    4. 설정 파일 적용은 워커가 잠금을 한 번 잡은 상태에서 최신 값 읽기 → 미리보기 지문 비교 → 단계별 쓰기 → 실패 시 되돌리기까지 끝내요. 따라서 다른 writer의 요청은 적용 전이나 후에만 실행되고 그 사이에 끼어들지 못해요. 적용 후에 실행된 요청은 그대로 최신 값이 돼요. 옵션 팝업이 닫혀도 워커 안의 적용은 끝까지 진행돼요.
       잠금 밖에 남는 쓰기는 다른 기기에서 들어오는 Chrome sync 동기화뿐이에요. 적용 중 대상 키에 확장이 쓰지 않은 변경이 관측되면 충돌로 보고 되돌리기에서 그 키를 덮지 않으며 결과에 알려요.
- **부분 실패와 효과 순서:** 알림·자동 입장·통나무 받기·종료 방송 새로고침·시청/채팅/후원 기록처럼 되돌릴 수 없는 효과를 만드는 옵션(`EFFECT_OPTION_KEYS`)은 따로 다뤄요. 파일이 끄는 효과는 가장 먼저 끄고, 파일이 켜는 효과는 다른 모든 단계(sync 일반 값 → local → 방송 대상 워커 교체)가 성공한 뒤 마지막에 켜요. 중간 단계가 실패하면 앞 단계를 위 규칙으로 되돌려 효과가 켜지지 않아요. 되돌리기까지 실패하면 실제로 남은 구역을 정확히 알려요.
- **권한:** 알림·미리보기/멀티뷰 영상 호스트 권한이 필요한 옵션은 적용 버튼의 사용자 동작에서 먼저 요청해요. 거부하면 아무것도 쓰지 않고 `권한이 필요한 기능을 끈 채 불러오기`를 따로 선택할 수 있어요.
- **방송 대상 복원:** 대상의 알림·자동 입장 값이 바뀐 채널은 워커가 기존 방식대로 처리 상태를 지우고 다음 확인을 기준 상태로만 기록해요. 그래서 복원 직후 이미 진행 중인 방송에 알림·자동 입장을 실행하지 않아요.
- **수용 기준:** 저장→변경→불러오기 왕복 일치, 미지원 종류·버전·필드·손상·한도 거절, 미리보기 후 수정 경합 재확인, 여러 저장 영역의 부분 실패 되돌리기·정확한 안내, 권한 거부 시 무변경, 방송 대상 복원 직후 자동 입장 없음.

## 위임 통합 계약

2026-10-08 Codex가 폴더와 채팅 멀티뷰를 별도 Claude 세션에 맡겼어요. 아래는 공용 통합 소유자(이 문서 작성 세션)가 manifest·옵션·설정 파일 백업·문서에서 사용하는 계약이에요. 위임 세션은 공용 파일(manifest·options·settings·styles·docs·다른 기능)을 수정하지 않고 검사도 실행하지 않아요.

### 폴더 세션 — `shared/followingFolders.js`, `features/followingFolders.js`, 전용 테스트

- `shared/followingFolders.js`는 DOM·chrome 비의존 IIFE로 `globalThis.BetterChzzkFollowingFolders`를 노출해요. isolated 콘텐츠에서는 `features/sidebarCustomization.js` 앞, 워커에서는 설정 저장 큐 앞에 로드해요(통합 결과: 설정 파일 검증은 워커가 하므로 옵션 페이지에는 로드하지 않아요).
- 필수 공개 값: `STORAGE_KEY = "betterchzzk:following-folders:v1"`(chrome.storage.sync), `MAX_FOLDERS = 10`, `MAX_NAME_LENGTH = 20`(앞뒤 공백 제거 후 code point), `MAX_ASSIGNMENTS = 150`, `EMPTY_STATE`(`{version:1,folders:[]}`의 동결 사본).
- 필수 함수 `parseState(value)`: 엄격 검증으로 `{ok:true,state}` 또는 `{ok:false,error}`를 반환해요. 허용 형식은 정확히 `{version:1,folders:[{id,name,channelIds,collapsed}]}`이고 추가 필드·중복 폴더 ID·두 폴더에 속한 채널·소문자 32자리 16진수가 아닌 채널 ID·상한 초과·sync 한 항목 한도(키 포함 직렬화 8,192바이트 미만, 여유를 둬 8,000바이트 이하)를 거부해요. 폴더 ID는 `/^[a-z0-9-]{1,24}$/`, `collapsed`는 boolean이에요. 잘못된 값을 잘라 성공으로 만들지 않아요.
- 런타임 옵션: `followingFoldersEnabled`(기본 false), `followingListMaxRows`(0=제한 없음, 최대 30). 행 수 제한은 원본 행을 숨기거나 옮기지 않고 목록 안 스크롤로만 제한하며, 사이드바의 다른 구역과 원래 `더보기`·접기 조작에 계속 접근할 수 있어야 해요.
- 고정 기능과의 순서 조합은 `data-bcsf-order-group`·`data-bcsf-pinned` 속성을 읽기만 하고 `features/sidebarCustomization.js`를 수정하지 않아요. 수정이 필요하면 통합 소유자에게 요청해요.
- **저장 경로:** 폴더 저장은 `chrome.storage.sync.set`을 직접 호출하지 않고 `BetterChzzk.utils.settingsStoreSet("sync", { [STORAGE_KEY]: state })`를 사용해요. 반환 Promise는 저장 성공에서 resolve, 발신자·검증·저장 실패와 워커 무응답에서 reject돼요. 읽기와 `storage.onChanged` 구독은 기존처럼 직접 해요. 워커는 이 키의 값을 `parseState`로 다시 검증하므로 `shared/followingFolders.js`는 `importScripts`로 워커에서도 로드할 수 있어야 해요(`window`·`document`·`chrome` 무가드 참조 금지).

### 채팅 멀티뷰 세션 — `features/chatMultiview.js`, 전용 테스트

- 프레임 주소는 `https://chzzk.naver.com/live/{소문자 32자리 채널 ID}/chat`만 사용해요. `srcdoc`·`window.open`·`chrome.tabs`·`target="_blank"` 대체·확장 자체 채팅 소켓은 쓰지 않아요.
- local 키 `betterchzzk:chat-multiview:v1`의 값은 정확히 `{version:1,channels:[{channelId,channelName}],width,height,corner}`예요. `channels`는 최대 4개·중복 없음, `channelName`은 앞뒤 공백을 뺀 0~100자 문자열, `width`·`height`는 패널의 CSS px 정수(너비 320~3840, 높이 240~2160), `corner`는 `"bottom-right"` 또는 `"bottom-left"`예요. 읽을 때 잘못된 값은 기본값으로 읽고 읽기만으로 저장하지 않아요.
- 런타임 옵션 `chatMultiviewEnabled`(기본 false). 진입점은 헤더 오른쪽 도구 영역의 버튼이에요. 열림 상태는 저장하지 않아요.
- 최상위 프레임에서만 동작해야 해요(`window.top !== window`이면 아무것도 하지 않아요). manifest의 주입 범위는 통합 소유자가 관리해요.
- **순수 모델:** `shared/chatMultiview.js`를 추가해 `globalThis.BetterChzzkChatMultiview`로 `STORAGE_KEY`, `MAX_CHANNELS`, `parseConfig(value)`(위 형식의 엄격 검증, `{ok:true,config}` 또는 `{ok:false,error}`), 읽기용 `normalizeConfig(value)`(잘못된 값은 기본 구성)를 노출해요. DOM·chrome 비의존이어야 하고 워커 `importScripts`와 옵션 페이지에서 로드돼요. 통합 소유자가 설정 파일 검증과 워커 저장 검증에 이 함수를 사용해요.
- **저장 경로:** 구성 저장은 `BetterChzzk.utils.settingsStoreSet("local", { [STORAGE_KEY]: config })`를 사용하고 `chrome.storage.local.set`을 직접 호출하지 않아요. 실패·무응답은 reject이며 현재 문서의 메모리 구성은 유지하고 저장 실패를 표시해요.

### 설정 저장 API 확정 — `BetterChzzk.utils.settingsStoreSet(area, values, expected?)`

- 위치: `shared/data.js`의 isolated 공용 유틸이에요. 콘텐츠 문서에서만 사용하고 확장 페이지·워커는 쓰지 않아요.
- `area`: `"sync"` 또는 `"local"`. `values`: `{키: 새 값}`이며 한 번에 최대 8개 키예요. 모든 키가 워커의 콘텐츠 허용 목록과 값 검증을 통과해야 하고 하나라도 실패하면 아무것도 쓰지 않아요.
- `expected`(선택): `{키: 기대}` 객체예요. 기대는 `{ value: 이전 값 }`(저장값이 이 값과 구조적으로 같아야 함) 또는 `{ absent: true }`(키가 없어야 함)예요. `values`에 없는 키를 넣을 수도 있어요. 워커는 설정 저장 잠금 안에서 최신 값을 읽어 모든 기대를 비교하고, 하나라도 다르면 쓰지 않고 거절해요.
- 반환: 저장 성공에서 resolve(값 없음). 실패는 `Error`로 reject하며 `error.code`가 `"conflict"`, `"invalid-request"`, `"untrusted-sender"`, `"key-not-allowed"`, `"invalid-value"`, `"storage-write-failed"`, `"storage-read-failed"`, `"unavailable"` 중 하나예요. `"conflict"`이면 `error.current`에 비교한 키의 현재 상태를 같은 `{value}`/`{absent:true}` 형식으로 담아요. 호출자는 이 값을 기준으로 변경을 다시 적용하거나 사용자에게 알리고, 자동으로 무한 재시도하지 않아요.
- 메시지 형식(참고): `{type:"betterchzzk:settings-store",version:1,area,values,expected?}`. 응답은 `{ok:true}` 또는 `{ok:false,error,current?}`예요.
- 요청 순서: 같은 문서에서 보낸 요청은 보낸 순서대로 처리돼요. 다른 탭·옵션 페이지·설정 파일 적용과는 잠금 단위로 직렬화돼요.

## 파일 소유권

| 영역                                                     | 파일                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 옵션 스키마                                              | `shared/settings.js`(새 옵션·`choice` 종류)                                                                                                                                                                                                                                                                                |
| 채팅·사이드바 위치, 채팅 높이, 접힌 사이드바 툴팁 미러링 | `features/panelResizeModel.js`, `features/panelResize.js`                                                                                                                                                                                                                                                                  |
| 모아보기 높이                                            | `features/chatTools.js`, `features/chatTools/panel.js`                                                                                                                                                                                                                                                                     |
| 팔로잉 폴더·목록 높이                                    | 폴더 세션: `shared/followingFolders.js`(순수 검증·변경), `features/followingFolders.js`(DOM·관리 패널)                                                                                                                                                                                                                     |
| 채팅 멀티뷰                                              | 채팅 멀티뷰 세션: `features/chatMultiview.js`                                                                                                                                                                                                                                                                              |
| 설정 저장 경계                                           | `shared/settingsStore.js`(워커 설정 저장 큐·발신자/키 검증·설정 파일 적용), `shared/data.js`의 `settingsStoreSet` 클라이언트, 기존 writer 전환(`sidebarCustomization`, `panelResize`, `liveMultiview/playback`, `skipControl`, `ambientGlow`, `followingPreviewTooltip`, `settings.js` 이전, `liveStartMonitor` 대상 쓰기) |
| 설정 파일                                                | `shared/settingsBackup.js`(순수 형식·검증·대상 목록·비교·단계 계획), `optionsSettingsBackup.js`(옵션 페이지 파일 선택·다운로드·미리보기·권한·결과 표시)                                                                                                                                                                    |
| 공용                                                     | `manifest.json` 로드 순서, `options.html`·`options.js` 진입점, `styles.css`                                                                                                                                                                                                                                                |

## 검증 계획

1. 기능별 관련 테스트를 `node --test --test-concurrency=2 <파일들>`로 순차 실행해요.
2. 설정 스키마·저장 형식·manifest·워커 메시지를 바꾸므로 마지막에 `npm run test:all -- --test-concurrency=2`, `npm run lint`, `npm run format:check`를 순서대로 한 번 실행해요.
3. 실제 Chrome 확인은 Codex 검수 순서로 넘기고 자동 검사 결과와 구분해 기록해요.
