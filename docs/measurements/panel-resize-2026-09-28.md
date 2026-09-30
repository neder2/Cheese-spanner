# 채팅·사이드바 너비 조절 실측 — 2026-09-28

## 방법과 확인 범위

Chrome의 브라우저 API로 DOM과 computed style·getBoundingClientRect를 읽고, 테스트용 별도 탭에서 메뉴/채팅 접기·넓은 화면·댓글 탭을 조작했어요. Windows 네이티브 컴퓨터 제어, 소스 주입, React 상태 변경은 사용하지 않았어요. 사용자 원래 라이브 탭에서는 읽기만 했어요. 반응형 확인용 viewport override는 측정 뒤 reset했어요. 요청 viewport 수치와 브라우저 줌에 따른 실제 CSS viewport가 달라 기록에는 `innerWidth/innerHeight`를 사용했어요.

대상:

- 라이브: `https://chzzk.naver.com/live/4515b179f86b67b4981e16190817c580`
- 다시보기: `https://chzzk.naver.com/video/15406028`
- 목록: `https://chzzk.naver.com/lives`

측정 시 기존 betterchzzk 채팅·댓글·팔로잉·미리보기·멀티뷰·확대 등의 style marker가 있었어요. 목록 페이지의 광고 기능 DOM 마커에서 확장 ID `oijgeclpcafhkbaameifdomjononepol`도 읽었어요. 이는 기존 기능 로드의 DOM 증거이며 설치 경로나 새 너비 기능의 실행 증거는 아니에요. 새 손잡이 마커는 적용 전 상태에서 0개였어요.

## 사이드바와 본문

`#sidebar`와 `#layout-body`는 같은 상위 `div._glive_duf89_1`의 자식이에요.

- 펼침: sidebar `aside._container_1b725_2._is_expanded_1b725_12`, fixed/left 0, width 240px, z-index 9999. 내부 첫 `div._wrapper_1b725_48`도 자동으로 width 240px예요.
- 본문: `#layout-body._body_duf89_11._is_expanded_duf89_22`, display flex, box-sizing border-box, padding-left 240px. 2048×996 화면에서 본문 rect x0/w2048, 라이브 내부 콘텐츠 x240/w1808이에요.
- 접힘: 메뉴 버튼 `aria-label="메뉴 확장"`, `aria-expanded="false"`, `aria-controls="navigation"`; sidebar width82px, 본문 padding-left82px. 펼침 버튼 이름은 `메뉴 접기`, expanded true예요.
- 반응형 CSS를 직접 확인했어요: `@media (min-width:1200px)`에서 펼친 본문 padding-left240px. 1199px 이하에서 펼친 사이드바는 z-index20000와 검은 `::before` 배경을 갖는 overlay예요. 이 배치는 본문 padding-left82px를 유지하므로 너비 조절 대상으로 취급하지 않아요.
- 실제 CSS viewport720×608에서 펼친 sidebar240px와 본문 padding82px를 관측했어요. 본문 자체는 native 최소 폭 때문에 950px로 넘쳤어요. 확장이 기존 반응형 전체를 새로 설계하지 않고 커스텀 폭·손잡이를 해제해야 하는 배치예요.
- 목록에서도 같은 가로 관계를 확인했어요. 목록1280×800에서 scrollbar를 제외한 본문 width1268px, padding-left240px예요.

헤더/사이드바의 `transform:translateY(...)`, height와 본문의 min-height/padding-top은 세로 배너 기능과 필터의 영향을 받아요. 목록에서는 inline translate111px와 computed translate60px가 달랐어요. 너비 기능은 이 값이나 전체 style 속성을 바꾸면 안 돼요.

## 라이브 오른쪽 영역

`aside#aside-chatting._container_b8csn_2`는 display flex/column, position relative, flex `0 0 auto`, width353px예요. 부모 `div._wrapper_wj4te_16`은 display flex/row, 자식은 `main`과 해당 aside예요. main은 flex `1 1 0%`, min-width0, overflow auto예요.

| 상태               | 실제 viewport | 부모 x/폭 | main 폭 | 채팅 x/폭 |
| ------------------ | ------------- | --------- | ------- | --------- |
| 일반·사이드바 펼침 | 2048×996      | 240/1808  | 1455    | 1695/353  |
| 일반·사이드바 접힘 | 2048×996      | 82/1966   | 1613    | 1695/353  |
| 일반·사이드바 펼침 | 1280×800      | 240/1040  | 687     | 927/353   |
| 넓은 화면          | 2048×996      | 0/2048    | 1695    | 1695/353  |

넓은 화면에서는 sidebar 노드 자체가 없어지고 채팅의 top은0, 높이는 viewport 전체예요. layout-body의 padding-left 값은 남아 있으나 실제 플레이어 부모가 x0에서 배치되므로 sidebar 부재 상태에서 본문 padding을 강제하면 안 돼요.

`채팅 접기` 버튼으로 접으면 aside는 DOM에 남고 `_is_folded_b8csn_10`와 display none, rect0이 돼요. main이 부모 전체 폭을 사용해요. 네이티브 접힘 해제 버튼으로 원래 상태 복원을 확인했어요.

채팅 내부 헤더·메시지·입력 영역은 외곽353px를 따라갔어요. 기존 숨은 `.bcct-moderator-box`는 absolute/right8px/width344px, z-index2147483646예요. 단순 외곽 폭 축소 시 모아보기 패널의 max-width 보호가 필요한지 확인해야 해요. 새 손잡이를 이 패널 위의 전역 최고 z-index로 띄우면 안 돼요.

## VOD 채팅과 댓글

`aside#vod-aside._aside_z51yg_32`는 width353px, flex `0 0 auto`, position relative, overflow hidden이에요. 부모 `div._player_z51yg_14`는 flex row이며 형제 영상 열 `div._video_z51yg_39`는 flex `1 1 0%`, overflow hidden이에요.

- 1280×800 일반 화면: 영상/채팅 부모 x240/w1028(스크롤바 12px 제외), 영상675px, aside x915/w353px. 영상 높이379.6875px, aside 높이464.6875px이며 native `margin-bottom:-85px`가 있었어요.
- 부모 위 `_wrapper_z51yg_29`와 `section._container_z51yg_1._show_aside_z51yg_17`이 스크롤/높이를 소유해요. 아래 `_area_z51yg_21`와 `_content_z51yg_24`는 전체1028px예요. 너비 기능 때문에 아래 정보 열에 불필요한353px 보정을 더하지 않아요.
- 기존 `#betterchzzk-vod-comment-comment-tab`의 댓글 탭을 클릭해도 동일한 `#vod-aside`와 외곽353px를 사용했어요.
- 넓은 화면: sidebar 없음, 부모 x0/w1268px, 영상915px, aside x915/w353px/h800px예요.
- 일반 화면 복원 때 native 스크롤 위치에 따라 aside top이 음수가 될 수 있어요. 원본 aside 내부에 붙인 손잡이는 부모 clipping/스크롤을 따라야 해요.

채팅 없는 영상의 댓글 전용 aside는 이번 실제 영상에서 관측하지 못했어요. 이 노드는 외부 DOM 추측 대상이 아니라 저장소 `features/vodCommentTabs.js`와 `features/vodComments/view.js`가 생성하는 `#betterchzzk-vod-comment-aside`예요. 해당 소유 코드·테스트로 구조를 확인하고 런타임 회귀를 추가하며, 실제 댓글 전용 영상 확인은 미검증으로 구분해요.

## 구현에 전달할 조건

- 사이드바는 펼침+1200 CSS px 이상+본문과 같은 parent+현재 대응 padding 관계를 확인해 적용해요. 가로 폭과 본문 padding-left만 소유해요. 접힘/overlay에서는 원래 폭·여백으로 돌아가요.
- chat 외곽 width/flex-basis/min/max를 필요한 범위에서 바꾸고 flex 형제 영상에 자연스럽게 공간이 돌아가게 해요. 라이브/VOD 부모 관계를 확인하며 arbitrary aside에는 적용하지 않아요.
- VOD의 overflow hidden 안에서도 손잡이가 잘리지 않도록 왼쪽 안쪽 8px를 사용할 수 있어요. 패널을 재부모화하거나 미디어 상태를 변경할 이유가 없어요.
- 가용 폭은 실제 부모 rect와 sidebar가 차지하는 폭, scrollbar/여백을 사용해요. viewport만 보고 VOD의 scrollbar12px까지 패널에 할당하지 않아요.
- 기본값에는 width 변형을 적용하지 않아요. 현재 target 교체/옵션 OFF/화면 모드 전환에서 원래 CSS로 복원해요.

## 실제 화면 검증의 제한

전체화면 버튼 클릭 뒤 `document.fullscreenElement`는 null이었고 console에 `TypeError: not granted`가 기록됐어요. 전체화면 성공으로 보고하지 않아요. 접근을 우회하거나 네이티브 컴퓨터 도구로 재시도하지 않았어요. 전체화면 진입/이탈은 자동 fixture와 수동 확인 항목으로 남겨요.

라이트 상태의 실제 기하를 측정했어요. 다크, 새 조절 기능의 드래그/취소/복원, 멀티뷰 실제 겹침·미리보기 재배치는 구현 후 검증 대상이에요. 기존 페이지 자체 media 오류도 있었으므로 새 기능 오류와 구분해요.

## 2026-09-30 추가 공개 스타일 확인

사용자 첨부 화면에서 라이브 영상 끝과 채팅 조절 가이드 사이에 작은 틈이 남고, 하단 멤버십 배너는 가이드에 붙어 보였어요. 사용자 화면의 DOM 좌표는 직접 읽지 않았고, 위 라이브 URL의 HTML이 참조하는 [공개 CSS](https://ssl.pstatic.net/static/nng/glive/resource/p/static/css/index-DHEcEx1z.css)를 읽었어요.

- `._container_b8csn_2:not(._is_popup_chat_b8csn_13):before`는 `position:absolute;left:-1px;width:1px;top:0;bottom:0`으로 라이브 채팅 바깥에 원래 구분선을 그려요. 해당 채팅 컨테이너에는 overflow clipping 선언이 없어요.
- 공통 조절 가이드의 `left:0`은 이 바깥 구분선을 덮지 못해요. 라이브 `#aside-chatting`의 확장 가이드만 `left:-1px`로 옮겨 원래 구분선을 포함하도록 보완했어요. 8px 마우스 영역은 채팅 안에 유지해요.
- VOD `._aside_z51yg_32`는 `overflow:hidden`이고 같은 바깥 구분선 규칙이 없어요. VOD·댓글 가이드는 기존 `left:0`을 유지해요.

이는 공개 스타일과 첨부 화면에 근거한 위치 보정이에요. 멤버십 배너가 실제 사용자 화면의 플레이어 폭을 바꿨는지나 수정 후 Chrome 픽셀 배치는 확인하지 않았어요.
