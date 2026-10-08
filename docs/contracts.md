# 치즈 스패너 치지직 연동 계약

## 접근 범위

외부 서버에 제공하는 공개 API나 다른 확장이 호출하는 API는 없어요. 치지직 페이지, 네이버 API, Chrome 확장 메시지 사이에서 사용하는 입출력을 구분해요. 아래 API·DOM 형식은 저장소가 현재 처리하는 계약이며 네이버의 장기 호환 보장이 아니에요. 기존 계약은 2026-09-28 코드 확인과 fixture 기준이고, 이날 실제 서비스 응답을 다시 측정한 결과는 아니에요. 카테고리 제외는 2026-10-01 최종 코드 확인과 2026-09-30 인증정보 없는 HTTP 확인 기준이며 실제 Chrome 동작은 미검증이에요.

일반 JSON 조회는 기존 로그인 세션을 포함한 요청을 사용해요. 공용 `fetchJson`의 기본 타임아웃은 12초지만 소비자가 다른 값을 줄 수 있어요. HTTP 실패는 `HTTP <상태>` 오류, JSON 해석 실패는 파싱 오류로 전달돼요. 내부 타임아웃과 외부 취소가 모두 AbortError일 수 있으므로 취소 이유는 호출자의 signal과 함께 판단해요. 응답의 `code/content` 검증은 API 소비자별로 달라요. HTTP 성공만으로 모든 API의 내용까지 정상이라고 단정하지 않아요.

## 외부 데이터 입력

| 입력·호출                                                                                                                      | 사용하는 응답                                                                                               | 실패·변형의 처리                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET `api.chzzk.naver.com/service/v2/channels/{id}/live-detail`, v3 동형 경로                                                   | `channel`, `liveId`, `status`, `liveTitle`, `openDate`, `livePlaybackJson` 등 소비 기능에 필요한 필드       | 채널·현재 요청 정체성 불일치는 현재 화면에 반영하지 않아요. 알림은 code 200·일치 채널·OPEN/CLOSE·유효한 liveId를 요구해요                                                |
| GET `/service/v1/channels/{id}`                                                                                                | 채널 ID·이름·프로필, 팔로워 조회에 필요한 채널 정보                                                         | 잘못된 ID·빈 이름·조회 실패를 성공 등록으로 만들지 않아요                                                                                                                |
| GET `/service/v1/search/channels`와 검색 파라미터                                                                              | 입력 검색어에 해당하는 채널 결과                                                                            | 이전 입력·닫힌 패널·이전 경로의 늦은 결과는 폐기해요                                                                                                                     |
| GET `/service/v1/channels/{id}/videos`와 page·size                                                                             | 영상 목록·페이지 종료 정보, videoNo·제목·길이·날짜                                                          | 상한·기간 경계·마지막 페이지를 구분하고 불완전 조회를 완성된 인덱스로 캐시하지 않아요                                                                                    |
| GET `/service/v2/videos/{videoNo}`                                                                                             | 방송 시작·종료·길이와 연결된 이전 VOD 정보                                                                  | 연결 순환·조회 상한을 제한해요. 보조 상세 실패와 외부 취소를 나눠요                                                                                                      |
| GET `/service/v1/lives`, `/service/v2/categories/{type}/{id}/lives` 또는 `/videos`, `/service/v1/categories/{type}/{id}/clips` | `liveId`, `concurrentUserCount`, `publishDateAt`, `readCount`, `clipUID` 등 경로별 다음 커서와 목록         | 커서의 0과 누락을 구분해요. 잘못된 경로 인코딩·조회 실패·동일 경로의 새 세대 요청을 처리해요                                                                             |
| GET `/service/v1/channels/followings/live`, `/followings?page=0&size=…&sortType=FOLLOW`, 배지 assets 조회                      | 팔로잉 순서·라이브 여부·현재 채널·배지                                                                      | 현재 목록에 대응하지 않는 저장 ID만으로 가짜 보충 채널을 만들지 않아요                                                                                                   |
| GET `/service/v1/live/{liveId}/auto-play-info`                                                                                 | 실제 미리보기 재생 정보                                                                                     | 미리보기용 정보가 재생 불가해도 유효한 live-detail 소스를 무조건 버리지 않아요                                                                                           |
| GET `apis.naver.com/nng_main/nng_comment_api/v1/type/{objectType}/id/{objectId}/comments`                                      | 댓글·BEST·답글·`page.next` 및 현재 확인된 페이지 정보                                                       | 잘못된 페이지 형식은 빈 결과가 아닌 오류예요. `page.next`가 없는 관측 형식에서는 offset과 실제 행 수로 이어가요                                                          |
| GET `comm-api.game.naver.com/nng_main/v1/user/getUserStatus`                                                                   | code 200, `content.loggedIn`, `content.userIdHash`                                                          | 미로그인·무효 ID·조회 실패면 본인 활동 수집·후원 가져오기를 확정하지 않아요. 열린 치지직 탭의 CORS·로그인 환경을 사용하며 별도 host 권한이 선언된 것으로 착각하지 않아요 |
| GET `api.chzzk.naver.com/commercial/v1/product/purchase/history?page=…&size=…&searchYear=…&searchMonth=…`                      | `donationType: CHAT`, `purchaseDate`, `channelId`, `channelName`, `payAmount`, `donationText`와 페이지 정보 | 본문이 없는 일반 후원은 빈 본문으로 유지해요. 날짜·수량·페이지 변화·계정 불일치·한도 초과면 완료 스냅샷을 저장하지 않아요                                                |
| GET `/service/v1/channels/{id}/log-power`, PUT `/claims/{claimId}`                                                             | 서버가 제공한 `content.claims`, claimType·claimId와 수령 응답                                               | WATCH_1_HOUR는 이 API 수령 경로에서 제외해요. 다른 채널·비활성화 후 응답은 수령으로 이어지지 않아요                                                                      |

첫 두 행 이후 origin이 생략된 `/service/…` 경로는 `https://api.chzzk.naver.com`이에요. 댓글 요청은 objectId, objectType, limit, offset, orderType, 선택적 originalLoungeId를 사용하고 PC/web 헤더와 확장 local에 보관한 무작위 deviceId를 전달해요. 로그인 자격 증명과 deviceId는 같은 것이 아니에요.

### 카테고리 이름 검색과 라이브 식별

이름 검색은 GET `https://api.chzzk.naver.com/manage/v1/auto-complete/categories?keyword=<검색어>&size=50`을 사용해요. 앞뒤 공백을 뺀 검색어를 URL 인코딩하며 입력은 최대 100 UTF-16 code unit이에요. 빈 입력은 요청하지 않아요. 정상 응답은 `code:200`, 배열 `content.results`이고 각 항목의 `categoryType`, `categoryId`, `categoryValue`를 사용해요. 최대 50개의 유효한 후보를 받고 같은 유형·ID 쌍은 중복 제거해요. 같은 이름의 서로 다른 유형·ID는 별개 결과예요.

검색 후보의 GET `/service/v1/categories/{type}/{id}/info`에서 정확히 일치하는 유형·ID와 음수가 아닌 안전 정수 `concurrentUserCount`를 확인해 카테고리 전체 동시 시청자 수 내림차순으로 정렬해요. 확인된 0명 후보만 제외하며 저장된 제외 목록은 변경하지 않아요. 미조회·실패·정체성 불일치는 수치 미확인으로 끝에 표시하고 동률은 검색 API 순서를 유지해요. 상세 조회는 최대 4개 동시 실행·각 3초·전체 5초 범위이고, 정상 수치는 최대 200개·5분 메모리 캐시에 보관해요. 미확인 수치가 있는 검색은 완료 캐시로 남기지 않아요. 이름 검색과 상세 조회에 같은 취소 신호를 연결해요. 2026-10-03 실제 Chrome 상세 응답에서 `GAME/MapleStory`의 `openLiveCount:49`, `concurrentUserCount:1218`을 확인했어요. 순간 집계이며 고정 수치가 아니에요.

HTTP·JSON 실패, code 불일치, results 누락·잘못된 형식은 검색 오류예요. 비어 있는 results는 정상 빈 결과이고, 비어 있지 않은 results에 유효한 항목이 하나도 없으면 오류로 처리해요. 입력 변경·추가 패널 닫기·페이지 이동·OFF 뒤 응답은 현재 검색에 반영하지 않아요. 내부 타임아웃은 검색 실패로 표시하고 결과 없음으로 바꾸지 않아요. 요청에는 검색어·size만 넣고 선택한 제외 목록 전체는 보내지 않아요.

전체 라이브 목록의 카테고리 정체성은 `/service/v1/lives` 항목의 `categoryType`·`liveCategory`이며 표시 이름은 `liveCategoryValue`예요. 원본 카드의 카테고리 링크는 같은 출처의 `/category/{type}/{id}/lives` 또는 끝 슬래시가 있는 형태를 해석하고 경로 조각을 디코딩해요. 현재 원본 링크가 없거나 여러 링크의 정체성이 충돌하면 이름·태그·제목이나 오래된 API 값으로 대신 판정하지 않아요. 메타데이터 후보와 확장이 추가한 카드는 비어 있지 않은 id·channelId 일치와 양의 안전 정수 liveId를 요구하고 현재 결합을 다시 확인해요. liveId 결측·0·음수·소수·안전 범위 초과는 카테고리 제외에서 통과시키며 원본의 현재 링크 판정과 독립이에요. 추가 카드 템플릿의 옛 카테고리 링크는 현재 유형·ID로 바꿔요.

2026-09-30 인증정보 없는 HTTP 요청에서 검색어 `마리모`는 `GAME`·`Marimo_League`·`마리모 리그`를 반환했고, GET `/service/v1/categories/GAME/Marimo_League/info`의 `openLiveCount`는 0이었어요. 공식 공개 코드도 링크에 categoryType·liveCategory를 그대로 사용했어요. 이 근거는 방송이 없는 검색 결과와 대문자 유형의 입력 계약을 뒷받침하며 실제 Chrome의 요청·원본 카드 DOM 성공을 증명하지 않아요.

이미지·미디어의 URL은 HTTPS와 용도별 허용 호스트로 검증해요. 현재 공용 허용 목록에는 pstatic 하위 호스트, 이미지용 `livecloud-thumb.akamaized.net`, 미디어용 `ex-nlive-streaming.navercdn.com`이 있어요. URL 검증 통과가 선택 권한·CORS·브라우저 재생 성공까지 보장하지는 않아요.

멀티뷰는 OPEN 상세의 `livePlaybackJson.media`에서 확인된 LLHLS, 다음으로 HLS 소스를 선택해요. 재생 JSON 오류·지원 소스 없음·종료 방송은 실패 상태예요. 미리보기는 live-detail·auto-play-info의 실제 소스를 검증하며 네이티브 목록 미리보기와 확장 소유 미리보기의 제어 경로를 구분해요. 원격 JS·WASM을 재생 응답으로 받아 실행하지 않아요.

## DOM·페이지 객체 입력

| 대상            | 입력 정체성·조건                                                                                                                                            | 출력·실패                                                                                                                              |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 재생 컨트롤     | 현재 메인 video와 같은 플레이어에 속한 pzp 컨트롤                                                                                                           | 확인된 버튼·트랙만 제어해요. 없거나 교체된 객체를 과거 참조로 제어하지 않아요                                                          |
| 라이브·VOD 채팅 | live의 `aside#aside-chatting`, VOD의 `aside#vod-aside`와 log·message 구조                                                                                   | 현재 작성자·역할·본문·작성 시각을 읽어요. 메시지 정체성 없는 행 재사용을 새 데이터로 확정하지 않아요                                   |
| React 메시지    | 해당 행의 `__reactProps$*` 아래 관측된 `children.props.chatMessage`                                                                                         | timestamp는 검증한 epoch, 본인 활동은 일치 작성자·NORMAL·지원 종류만 전달해요. 객체·콜백 전체를 넘기지 않아요                          |
| 사이드바 이동   | 현재 사이드바의 링크와 React Router navigator                                                                                                               | 처리 가능한 이동만 위임하고 원래 React 노드를 임의로 옮기지 않아요                                                                     |
| 패널 너비       | 펼친 `#sidebar`와 같은 부모의 `#layout-body`, 일반 live/video에서 영상 형제와 가로로 나란한 `#aside-chatting`·`#vod-aside`·`#betterchzzk-vod-comment-aside` | 현재 대응 여백·표시 영역이 확인될 때만 가로 너비와 경계를 적용해요. 접힘·겹침·화면 밖 배치·다른 전체화면 요소 밖에서는 지정을 해제해요 |
| 헤더·배너·목록  | `#header`, `#sidebar`, `#layout-body`와 관측한 역할·클래스·인접 관계                                                                                        | 정확한 대상에만 표시·보정을 적용해요. 단어·넓은 클래스 조각만으로 관련 없는 요소를 숨기지 않아요                                       |
| 테마            | 실제 루트 테마와 Surface·Content·Border 토큰 또는 확인한 computed style                                                                                     | 테마·노드 교체 시 갱신하고 토큰이 없는 환경에는 정적 기본값을 사용해요                                                                 |

셀렉터 배열은 먼저 일치한 체인을 사용하는 계약이에요. CSS의 쉼표 목록으로 합치면 문서 순서 선택으로 바뀔 수 있어요. 모든 셀렉터가 공용 레지스트리에 있는 것은 아니므로 각 기능의 로컬 입력도 함께 확인해요.

## 네이티브 VOD 이어보기

2026-10-01 공식 공개 `index-VdvK-ysl.js`를 실행하지 않고 읽어 확인했어요. 네이티브 첫 play는 명시적 `currentTime`을 우선하며, 없으면 상세의 `watchTimeline`을 사용해요. 남은 길이가 10초 이하이거나 영상 길이 밖인 watchTimeline은 0으로 돌아가요. POST `/polling/v1/watch-event/video`의 `payload.positionAt`은 위치 입력이고 GET `/service/v3/videos/{videoNo}`의 `watchTimeline`은 복원 입력이에요. 실제 로그인된 요청 payload·다음 응답·첫 이벤트 순서는 이번 브라우저 도구로 수집하지 않았어요.

채팅 자동 복구의 새로고침·위치 전달 경로는 제거됐어요. 이전 문서가 남긴 `betterchzzk:vod-chat-resume`·`betterchzzk:vod-chat-reload:` 값은 현재 런타임에서 읽거나 적용하지 않아요. 이를 지우기 위한 별도 사이트 저장소 정리 스크립트는 추가하지 않아요.

## 광고 판단·소스·일정 계약

2026-09-29의 공개 배포 코드 정적 확인과 최소 자동 모델에 연결한 계약이에요. 실제 Chrome의 광고 배정·React 객체·본영상 진행은 이번에 측정하지 않았어요. MAIN의 전역 진입은 `JSON.parse`, `Object.defineProperty`, `WeakMap.prototype.set` 세 곳이에요.

- 표시 판단은 `/live/`·`/video/`에서 `code: 200`, `message: null`과 두 boolean을 요구해요. 명시적 `content.playerAdDisplayResponse`는 입력 문자열 65,536 UTF-16 code unit 이하에서 `preRoll/midRoll`만 false로 바꾸고 `postRoll`·`media`·기타 필드를 보존해요. 구형은 2,048 이하이며 content의 유일한 키 `livePlaybackJson` 안에 `liveId/chatChannelId` 두 boolean만 있어야 해요. 명시적 형태가 있으면 잘못돼도 구형으로 대체하지 않아요. reviver·오류·일반 재생 정보는 원본 동작을 유지해요.
- 직접 소스는 광고 컨트롤러 API, `setVideoScheduleInfo/handshakeVersion/initAd`, 자체 데이터의 비어 있지 않은 `adScheduleId`, 현재 경로와 `chzzk_live/chzzk_video` 일치, 연결된 CHZZK 영상 소유를 함께 확인해요. 어댑터는 실제 video·root·공개 getter의 동일성을 재확인해요. 연결 전 후보는 컨트롤러의 최초 네이티브 `initAd` 진입 전에 한 번 판단하고, 원본 초기화에 들어간 소스는 다시 비우지 않아요. 확인된 `glad:` URI도 현재 광고 컨트롤러 소유를 요구해요.
- NLiveCast는 직접 소스형 필드보다 먼저 구분해 바깥 객체를 유지해요. 확인된 생성자 상수·prototype·필수 초기화 필드와 현재 소유가 맞을 때 자체 writable/configurable 데이터 `linearAdRequest`의 검증된 내부 요청만 생략해요. 추가 필드는 허용하며 내부 요청이 없으면 바깥 초기화는 그대로 진행해요.
- 독립 라이브 일정은 네이티브 WeakMap 등록·manager API, 현재 채널 props·양수 안전 정수 `liveId`, 같은 React 컴포넌트 첫 두 ref의 광고용 video/container, 현재 표시 정보와 연결 상태를 확인해요. 비어 있지 않은 문자열 `adUnitId`와 배열 `adSources`를 가진 항목에서 소스만 비우고 항목·순서·시간·원본은 보존해요. 현재 등록·소유가 불명확하면 알려진 ID도 원본 통과예요.
- 공유 표시 정보의 중간 일정은 위 컴포넌트 소유와 별도로 `props.player.adsController/viewSlot`, 그 슬롯에서 관측한 다른 manager, 현재 공유 정보의 객체 동일성과 본영상 소유를 모두 요구해요. 별도 광고용 video와 본영상 어댑터는 서로 다른 책임이에요. 등록·video·props·라우트가 바뀌면 호출 때 다시 확인해요.

라이브 PiP로 같은 본영상을 계속 재생하며 홈·목록 등으로 이동한 경우에는 현재 주소 대신 검증된 플레이어 연결로 독립 중간 일정을 판단해요. 광고 컴포넌트의 두 ref·유효한 채널/liveId·서비스와 원래 등록에 더해, `props.player.adsController`의 실제 영상이 `.chzzk_player.type_live.pip_mode`에 속하고 본영상 레이아웃과 광고 wrapper가 같은 부모여야 해요. 적용 직전 영상·컨트롤러·배치·PiP 상태를 다시 확인해요. 다른 라이브 주소와 채널이 충돌하거나 관계를 확인할 수 없으면 통과해요. 이 예외는 홈 JSON·직접 소스·목록 미리보기의 처리 범위를 넓히지 않아요.

등록은 관측한 원래 WeakMap의 현재 값이 같은 manager인 경우에만 유효해요. 다른 map의 같은 컨테이너 키 쓰기는 영향을 주지 않고, 원래 등록의 삭제·교체는 독립·공유 일정 모두 원본 통과로 처리해요. 동일한 광고 컴포넌트를 가리키는 React owner/alternate의 소유·채널·방송·서비스가 불일치하거나 읽을 수 없으면 과거의 유효한 후보만 골라 승인하지 않아요. 적용 직전에도 제한된 후보와 연결 관계를 다시 확인해요.

원래 receiver·인자·반환값·동일 Promise·예외와 뒤에 설치된 wrapper를 보존해요. 옵션 미확정·OFF에서 늦게 호출돼도 원본을 통과시키며 OFF 뒤 같은 문서에서 재활성화하려면 새 문서가 필요해요. 지원 API·등록·소유 경계에 도달하지 않는 파서/전달 경로는 현재 미지원이에요. 네트워크·암호화·바이트·스타일 API나 계정 응답을 바꾸는 경로는 현재 구현에 없어요.

기존 상태 속성은 `active`, `reloadRequired`와 6개 처리 카운터로 유지해요. `changedParses`는 변경된 파싱 호출당, `blockedVodSources/blockedLiveSources`는 null 해제가 정상 반환한 호출당, `blockedLiveSchedules`는 일정 변환 호출당, `blockedLivePreRollSchedules`는 그중 기존 확인 입장 ID가 포함된 호출당, `blockedWrappedLiveRequests`는 내부 요청을 생략한 읽기당 증가해요. 한 일정의 여러 항목을 따로 세지 않고 새 ID를 입장 광고로 추정하지 않아요. 일정 카운터는 원래 load 직전 증가하므로 네이티브 load 예외나 실제 차단 성공 횟수와 같지 않아요.

## 패널 너비 저장 형식

확장 local 저장소의 `betterchzzk:panel-resize:sidebar-width:v1`과 `betterchzzk:panel-resize:chat-width:v1`은 각각 `null` 또는 1~8192 범위의 유한한 정수 CSS px을 저장해요. `null`은 확장 너비 지정을 해제한다는 뜻이며, 실제 표시 너비는 현재 화면의 가용 공간으로 제한해요. 숫자 문자열은 변환하지 않고 누락·잘못된 값은 해당 영역만 기본으로 읽어요. 읽기만으로 저장값을 고치지 않아요.

두 키를 독립적으로 쓰며 드래그 확정과 더블클릭 기본 복원만 저장해요. 초기화는 현재 표시가 이미 기본이어도 해당 키에 null을 써요. 접힘·창 크기 변경·기능 OFF·취소는 저장값을 덮지 않아요. 새 문서에서 저장값을 읽고, 다른 문서 변경을 즉시 반영하는 이벤트·확장 메시지·구독은 사용하지 않아요. 같은 문서의 BFCache 복귀와 옵션 재활성화는 메모리 선택을 유지해요.

접근 오류나 API 부재에서는 현재 문서의 메모리로 조절을 이어가고, 읽기 실패를 기본값으로 덮어쓰거나 실패한 쓰기를 자동 재시도하지 않아요. 다음 명시 조절은 다시 저장할 수 있어요. 이전 개발용 sessionStorage 키 `betterchzzk:panel-resize:v1`은 읽기·쓰기·삭제·자동 이전하지 않아요.

## 두 실행 영역의 교환

이벤트·속성은 공유 화면의 통신 수단이며 공개된 외부 확장 API가 아니에요. 이벤트 대상·현재 경로·형식·현재 요청을 검증해요. 아래 채팅 요청은 대상 노드에서 동기적으로 요청하고 값을 읽는 형태예요.

| 요청·입력                                                                                                  | 결과·출력                                                            | 실패 조건                                                                                                |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| window `betterchzzk:routechange`, detail `{href, source}`                                                  | 공용 감지 후 `betterchzzk:routechange:detected`                      | 같은 href는 중복 라우트 변경으로 처리하지 않아요                                                         |
| `data-betterchzzk-auto-quality-state`의 `{enabled, quality}` + window `betterchzzk:auto-quality:state`     | MAIN의 활성·선호 화질 상태                                           | 잘못된 입력은 검증된 기본값·비활성 경로로 처리해요                                                       |
| `data-betterchzzk-auto-quality-request`의 `{requestId, quality}` + window `betterchzzk:auto-quality:apply` | result 속성에 같은 requestId와 status·reason, 필요 시 `waitForEvent` | 응답 ID 불일치·handler 없음은 성공이 아니에요. pending·blocked·selected·already와 이벤트 대기를 구분해요 |
| `data-betterchzzk-ad-video-state`의 `1` 또는 `0` + document `betterchzzk:ad-video:state`                   | 동적 광고 훅의 활성 상태·진단 속성                                   | 저장 옵션이 읽히기 전에는 응답을 변경하지 않아요. 재활성화에 새 문서가 필요할 수 있어요                  |
| `data-betterchzzk-volume-wheel-options`의 `{enabled, step}` + window `betterchzzk:volume-wheel-options`    | 현재 메인 볼륨 영역의 휠 처리                                        | 재생 경로·대상 밖에서는 원래 이벤트를 유지해요                                                           |
| message container의 `betterchzzk:chat-timestamp-source-request`                                            | `data-bcmt-source-time`의 유효한 밀리초 시각                         | 원본 시각이 없거나 범위가 잘못되면 속성을 지워요. ready 이벤트로 로드 순서 차이를 처리해요               |
| 채팅 행의 `data-bcwa-user` + `betterchzzk:watch-activity-source`                                           | `data-bcwa-source`에 `{id, at, kind, text, amount}`                  | 작성자·상태·시각·지원 활동 종류가 다르면 결과를 남기지 않아요. 읽은 임시 속성은 제거해요                 |
| 현재 팔로잉 보충 링크의 `betterchzzk:following-navigate`                                                   | 페이지 라우터가 처리한 경우 이벤트 취소로 응답해요                   | 오래된 행·지원되지 않는 이동은 처리 성공으로 표시하지 않아요                                             |

자동 화질 state는 기존 enabled·quality만 전달해요. 폐기한 lowLatencyEnabled 입력과 liveLowLatencyEnabled 저장값은 제어를 활성화하지 않아요. 독립 저지연 결과와 멀티뷰 메인 딜레이 전달 속성은 더 이상 발행하지 않아요. 기존 화질 요청·응답과 읽기 전용 스트림 정보 계약은 유지해요.

### 현재 스트림 정보 읽기

isolated는 현재 메인 video의 `data-bcsi-request`에 `{version:1, requestId}`를 쓰고 같은 video에서 `betterchzzk:stream-info:read` 이벤트를 발생시켜요. requestId는 길이 1–128의 문자열이며 다른 요청 필드를 받지 않아요. MAIN은 document capture 리스너에서 현재 메인·소유권·라이브 경로를 확인하고 같은 video의 `data-bcsi-result`에 동기로 응답해요. 잘못된 요청이나 다른 video에는 응답하지 않아요.

결과 필드는 `{version, requestId, route, status, reason, mode, trackId, sourceToken, trackWidth, trackHeight, onLive}`예요. version은 1, route는 pathname, status는 `ready | unavailable`이에요. ready의 reason은 `ok`이고, unavailable의 reason은 `unsupported-route | player-missing | ambiguous-player | track-missing | player-changed`예요. mode는 `low-latency | standard | unknown`이며 저지연은 확인된 `low-latency`·`low-latency-p2p`, 일반은 `main`·`p2p` 종류에만 대응해요.

trackId는 확인된 문자열 또는 null, 크기는 유효한 양수 숫자 또는 null, onLive는 확인한 boolean 또는 null이에요. sourceToken은 메인·provider·소스를 구분하는 페이지 내 임시 문자열이며 원격 미디어 URL이나 React 객체를 넘기지 않아요. unavailable에서는 mode가 unknown이고 나머지 트랙·소스·크기·onLive는 모두 null이에요. 읽는 동안 소유권이 바뀌면 player-changed로 처리하고, 같은 pane을 공유해도 서로 다른 소유 플레이어가 있으면 모호한 결과예요.

isolated는 version·requestId·route·값 형식을 확인한 뒤 두 임시 속성을 지워요. 응답이 없거나 잘못되면 현재 방식은 확인 불가예요. 과거 `data-betterchzzk-low-latency-result`를 현재 선택의 근거로 사용하지 않아요. 이 조회는 제어 래퍼 설치·선택·재생·seek·배속 변경을 실행하지 않고, 자동 화질 설정이 꺼져도 작동해요. DOM 이벤트에는 확장 저장소·탭·네트워크 같은 특권 명령을 연결하지 않아요.

패널의 기존 v3 live-detail 조회에서는 OPEN 상태, 요청과 같은 `channel.channelId`, 양수 safe integer liveId로 방송 정체성을 확인해요. 메인·소스 전환 뒤 새 응답으로 동일 방송을 확인해야 최근 자료를 합칠 수 있어요. 경로·대상·소스가 바뀐 요청의 응답은 버리고 현재 전환의 조회로 이어가며 별도 반복 메타데이터 조회를 추가하지 않아요.

## 확장 내부 명령

Chrome runtime이 제공하는 sender 정보를 사용하고 요청 본문의 자칭 출처를 신뢰하지 않아요. 성공 응답을 받기 전 UI를 저장 완료로 확정하지 않아요. storage API 오류는 콜백 안에서 소비하고 요청자에게 실패로 전달해요.

### 카테고리 제외

요청은 `{type:"betterchzzk:category-exclusions",version:1,operation}`이며 최상위 필드는 이 세 개만 허용해요. operation은 아래 형식만 받고, 전체 배열 교체·전체 초기화 명령은 없어요.

| 동작      | operation 입력                                                  |
| --------- | --------------------------------------------------------------- |
| 읽기      | `{kind:"get"}`                                                  |
| 추가      | `{kind:"add",category:{categoryType,categoryId,categoryValue}}` |
| 개별 해제 | `{kind:"remove",categoryType,categoryId}`                       |

유형은 1~32 UTF-16 code unit의 `[A-Z][A-Z0-9_]*` 문자열이고 ID·표시 이름은 각각 1~200 UTF-16 code unit이에요. 제어 문자·공백만 있는 값은 거부하며 ID `.`·`..`도 거부해요. ID와 이름을 임의로 자르거나 ID의 대소문자를 바꾸지 않아요. 저장 상태의 카테고리 항목과 추가 category에는 세 카테고리 필드만 허용해요. 태그 제외는 같은 형식의 `{categoryType:"CHEESE_SPANNER_TAG",categoryId:<정규화 태그>,categoryValue:<표시 태그>}`예요. ID는 앞의 `#` 제거·연속 공백 축약·NFC·소문자 변환을 거친 1~100자 값이고, 카드의 태그도 같은 정규화로 전체 일치만 비교해요. 원본 카드 태그는 같은 출처 링크의 `tags` query 값이에요. 이 예약 유형은 치지직 검색 결과에서 받지 않아요.

같은 확장 ID, 음이 아닌 안전한 정수 tab.id, frameId 0과 치지직 발신 출처를 요구해요. SPA 이동 전 문서 URL인 sender.url과 Chrome이 제공하는 현재 sender.tab.url을 구분하고, 현재 탭 URL이 정확한 `https://chzzk.naver.com/lives`인지 검사해요. 현재 탭 URL이 없거나 잘못되면 거절해요. 끝 슬래시·query·hash는 허용하고 다른 경로·하위 프레임·다른 출처·자격 증명·명시한 포트는 거부해요. 본문이 주장하는 출처·탭 ID는 허용 근거가 아니에요.

성공은 `{ok:true,state:{version:1,revision,categories}}`, 실패는 `{ok:false,error:"<코드>"}`예요. local 키 `betterchzzkCategoryExclusionsV1`에 같은 state를 보관하며 state에는 version·revision·categories만 허용해요. revision은 음이 아닌 안전한 정수이고 categories는 중복 없는 최대 100개의 카테고리 배열이에요. 키가 실제로 없을 때만 revision 0·빈 배열을 읽기 기본값으로 사용하며 읽기 자체는 저장하지 않아요.

| 오류 코드              | 거부·실패 조건                                                           |
| ---------------------- | ------------------------------------------------------------------------ |
| `untrusted-sender`     | 발신 확장·탭·프레임·URL을 승인하지 못했어요.                             |
| `unsupported-version`  | 요청 version이 1이 아니에요.                                             |
| `invalid-request`      | 요청·operation·category의 허용 필드나 값 형식이 아니에요.                |
| `storage-unavailable`  | local 읽기·쓰기 API를 사용할 수 없어요.                                  |
| `storage-read-failed`  | 읽기 콜백 오류·예외·잘못된 콜백 결과로 상태를 읽지 못했어요.             |
| `invalid-stored-state` | 존재하는 저장값이 버전·필드·형식·상한·중복 검사를 통과하지 못했어요.     |
| `limit-reached`        | 이미 100개여서 새 유형·ID를 추가할 수 없어요.                            |
| `storage-write-failed` | 저장 콜백 오류·예외가 생겼거나 실제 변경의 revision을 더 올릴 수 없어요. |

워커의 독립 큐가 수신 순서대로 최신 local 값을 읽어 개별 추가·해제를 적용해요. 같은 항목 추가·없는 항목 해제는 저장·revision 증가 없는 성공이고 기존 이름·순서를 바꾸지 않아요. 실제 변경은 저장 콜백 성공 뒤 증가한 revision을 응답해요. 손상·읽기·쓰기·상한 오류에서는 기존 값을 보존해요. 콘텐츠는 확인된 최초 옵션 완료 뒤 활성 전체 방송에서 구독해요. 새 구독의 첫 정상 읽기·변경을 현재 기준으로 받은 뒤 같은 구독의 오래된 revision은 무시해요. 실제 키 삭제는 이전 요청 세대를 무효화하고 빈 상태로 반영해요. 손상 변경 알림은 마지막 정상 상태를 보존하면서 이전 읽기·변경·대기를 무효화해 늦은 콜백이 오류 안내를 지우지 못하게 해요. 이전 구독의 성공·실패·finally도 현재 UI를 바꾸지 못해요.

시청 기록 메시지는 `{type: "betterchzzk:watch-history-mutation", version: 1, operation}`이에요. 세션·활동에는 recordId, 채널 메타데이터 entry, 식별자·입장/종료 시각·누적 시청량·시간대를 가진 session, 선택적 activities를 보내요. 세션 시각은 밀리초이고 watchedSeconds는 초예요. 성공은 `{ok:true,result}`, 버전·출처·스키마·저장 오류는 `{ok:false,error}`예요.

지원 operation은 세션 스냅샷 갱신, 활동 추가, 임시→live 기록 ID 연결, 다시보기 번호 저장, 선택 삭제, 전체 삭제, 후원 가져온 내역 초기화예요. 활동 추가는 검증된 `live:` 기록을 요구하고, 삭제는 대상 ID와 cutoffAt을 함께 보내요. 과거 후원 월 교체는 서비스 워커의 조회 작업 전용이며 일반 발신자의 직접 요청은 거부돼요.

컴프레서 읽기는 `{type:"betterchzzk:audio-compressor-state", kind:"get"}`, 쓰기는 `{type:"betterchzzk:audio-compressor-state", kind:"set", state:{active:true, volume:0.75}}` 형식이에요. state의 active는 boolean, volume은 0 이상 1 이하의 유한 숫자예요. set의 명시 저장 시 소수 둘째 자리로 반올림하며, 유효한 기존 값의 승계·get 스냅샷은 그대로 보존해요. 같은 확장의 최상위 치지직 sender 탭만 허용하고 본문의 tabId로 대상을 바꿀 수 없어요. get은 기존 탭 선택을 우선하며 없으면 마지막 기본 선택의 스냅샷을 그 탭에 저장해요. 페이지 소비자는 옵션 준비·기능 활성화·첫 재생 경로 진입 뒤 get을 시작하며 홈·목록에서는 등록하지 않아요. 진행 중인 첫 조회는 반복 경로 동기화에서 공유해요. set은 발신 탭 선택과 앞으로 등록될 탭의 기본 선택을 함께 저장해요. 결과는 `{ok:true,state:{active,volume}}` 또는 `{ok:false,error}`이고 필요한 저장이 성공한 뒤에만 성공 응답해요. 최초 기본 선택은 남아 있는 마지막 유효 탭 선택이며 아무 선택도 없으면 비활성·볼륨 1이에요. 다른 열린 탭에 변경을 전파하지 않아요.

방송 등록은 `{type:"betterchzzk:live-start:channels", kind, channel}`을 사용해요. 옵션 페이지는 add·update·remove·개별 선택을, 치지직 최상위 콘텐츠는 set-notify·set-auto-open·remove를 요청할 수 있어요. 채널 ID와 notify/autoOpen boolean을 검증하고 최대 32개를 보관해요. 결과는 `{ok:true,channels}` 또는 `{ok:false,error}`예요.

광고 등록 동기화 `{type:"betterchzzk:ad-video:sync"}`는 options.html에서만 요청해요. 등록 조정 후 `{ok:true,enabled}`, 출처·등록 오류는 `{ok:false}`예요.

후원 조회 port 이름은 `betterchzzk:donation-history-import`이고 history.html만 연결해요. 요청은 `start` 또는 `cancel`이에요. 진행·저장·완료·오류를 구분해 전달하고, 동시에 다른 조회가 있거나 미로그인·계정 변경·불완전 데이터이면 error를 보내요. 저장 진입 전 연결 해제·취소는 조회를 중단하며, 이미 저장 중인 결과까지 취소됐다고 약속하지 않아요. 완료는 저장 결과가 확인된 뒤에만 보내요.

## 시청·내 채팅 파일 백업

파일 표식은 `kind: "cheese-spanner.watch-history-backup"`, `formatVersion: 1`이에요. `extensionVersion`, 밀리초 생성 시각 `createdAt`, `records`, `recordAliases`를 포함해요. 각 방송은 표시 메타데이터와 `watch`(원본 세션·구간·일별/전체 합계·과거 세션 확인 정보), `chat`(일반 채팅 메시지·날짜별 횟수·정리 시점)을 가져요. 상세가 없는 과거 합계는 `sessionDetails: null`로 빈 상세 배열과 구별해요. 후원·설정·삭제 장벽은 파일에 넣지 않아요.

정확한 필드와 검증은 `shared/watchHistoryBackup.js`가 소유해요. 파일은 UTF-8 JSON, 현재 상한은 16 MiB예요. 별도 종류·미지원 버전·알 수 없는 필드·손상·개수/길이 초과·식별 충돌·위험 URL은 거부해요. 지원 구형 저장값의 다시보기 번호·세션 시각·방송 링크는 내보낼 때 현재 표현으로 옮겨요. 파일 입력을 조용히 절삭해서 유효한 자료로 만들지 않아요.

| 위치                          | 형식 1의 필드                                                                                                                                                                       |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 최상위                        | `kind`, `formatVersion`, `extensionVersion`, `createdAt`, `records`, `recordAliases`                                                                                                |
| `records[]`                   | `id`, `channelId`, `liveId`, `channelName`, `title`, `titleHistory`, `liveOpenDate`, `liveUrl`, `thumbnailUrl`, `replayVideoNo`, `firstWatchedAt`, `lastWatchedAt`, `watch`, `chat` |
| `titleHistory[]`              | `title`, `firstSeenAt`, `lastSeenAt`                                                                                                                                                |
| `watch`                       | `watchedSeconds`, `dailySeconds`, `sessions`, `sessionDetails`, `retiredSessionCheckpoints`, `retiredSessionStartedAtBarrier`                                                       |
| `sessionDetails[]`            | `id`, `title`, `enteredAt`, `leftAt`, `watchedSeconds`, `dailySeconds`, `watchedRanges`, `closed`                                                                                   |
| `watchedRanges[]`             | `startAt`, `endAt`                                                                                                                                                                  |
| `retiredSessionCheckpoints[]` | `id`, `title`, `enteredAt`, `leftAt`, `watchedSeconds`, `dailySeconds`, `closed`, `checkpointedAt`                                                                                  |
| `chat`                        | `messages`, `dailyCounts`, `cutoffAt`                                                                                                                                               |
| `messages[]`                  | `id`, `at`, `text`, 선택 필드 `sessionStartedAt`                                                                                                                                    |
| `recordAliases[]`             | `sourceRecordId`, `targetRecordId`, `migratedAt`                                                                                                                                    |

`dailySeconds`는 KST `YYYY-MM-DD`→시청 초, `dailyCounts`는 같은 날짜→일반 채팅 횟수예요. 수치와 시각은 음이 아닌 안전한 정수이고, 실제 세션·메시지·생성 시각은 양의 밀리초 Unix 값이에요. 미측정 메타데이터 시각은 0, 없는 표시값은 빈 문자열, 없는 목록은 빈 배열을 사용해요. `closed`는 boolean이에요. 메시지에는 후원 종류·금액이 없으며 일반 채팅 ID와 시각이 일치해야 해요. 별칭은 파일에 포함된 정식 방송과 같은 채널의 임시 ID를 연결해요. `backupRestore` 같은 대상 저장소의 복원 상태는 이 파일 형식에 들어가지 않아요.

백업 요청은 `{type:"betterchzzk:watch-history-backup",version:1,action}`이에요. `export`는 추가 입력 없이 `{status:"exported",backup}`을 반환해요. `preview`는 `backup`을 받아 `{status:"preview",confirmationToken,summary,items}`를 반환해요. `import`는 같은 `backup`과 `confirmationToken`을 받아 `{status:"applied"|"unchanged",summary,items}` 또는 다시 확인할 `{status:"reconfirm",confirmationToken,summary,items}`를 반환해요.

응답 외피는 `{ok:true,result}` 또는 `{ok:false,error:{code,message}}`예요. 오류 코드는 `UNTRUSTED_SENDER`, `INVALID_REQUEST`, `INVALID_FILE`, `UNSUPPORTED_VERSION`, `LIMIT_EXCEEDED`, `STORAGE_READ_FAILED`, `STORAGE_WRITE_FAILED`예요. 읽기·저장 오류와 응답을 확인하지 못한 상태를 UI에서 구별해요.

`summary`에는 `exportedAt`, `periodStartAt`, `periodEndAt`, `records`, `storedChats`, `totalChats`, `added`, `updated`, `unchanged`, `skipped`, `restored`가 있어요. 빈 기간은 null, 복원 개수는 추가·갱신 개수와 겹칠 수 있어요. `items`에는 파일 방송별 `recordId`, `title`, `channelName`, `disposition`, `restoresDeleted`, `reason`을 전달해요. disposition은 `added|updated|unchanged|skipped`, reason은 `null|ambiguous-history|identity-conflict`예요.

조회와 변경은 같은 기록 큐에서 순서를 맞춰요. 파일 선택·미리보기는 쓰지 않아요. 같은 파일 반복 적용은 중복 누적되지 않고, 정확한 병합이 불가능한 기존 방송은 전체를 보존하며 건너뛰어요. 새 삭제·충돌 등 확인 의미가 바뀌거나 토큰이 없으면 재확인해요. 일반 시청 증가만으로 확인을 반복 요구하지 않으며 저장할 때 최신 값을 보존해요.

## 새 기능 안내 메시지

패키지 자료는 설치 버전과 문자열로 정확히 일치해야 해요. 첫 자료는 1.4.1이며 버전별 title·summary·cards를 포함해요. cards는 id·title·summary·instructions·target·settingsTarget을 가지며 목적지는 panels, history, stream으로 한정해요. cards가 비어 있으면 요약만 표시해요.

요청은 type=betterchzzk:update-guide, protocol=1, action, guideVersion을 사용해요. claim/commit/release에는 문서마다 생성한 clientId를 넣어요. claim은 ok:true, show:false와 예약 성공 시 token을 반환하고 commit/release는 같은 token을 받아요. 실제 표시 권한은 commit의 ok:true, show:true뿐이에요. 오류는 ok:false, show:false이며 자유 URL·선택자나 다른 탭 ID를 받지 않아요.

예약은 탭·documentId에 결합하고 documentId가 없으면 검증한 탭·frame·URL·clientId에 결합해요. 30초 만료, 옵션 변경, 문서 변경, 워커 재시작으로 낡은 예약을 승인하지 않아요. local 키 betterchzzk:update-guide-state에는 schemaVersion:1, version, status 한 건을 저장하며 status는 pending, seen, suppressed예요. 읽기 오류·손상 상태는 자동 표시를 중단해요.

open-settings의 target은 panels, history, stream, categories뿐이고 확장 options.html의 #update-guide- 목적지로 연결해요. 옵션 페이지에서 보내는 replay는 현재 활성 치지직 최상위 프레임만 대상으로 하며 응답은 ok:boolean이에요. 콘텐츠는 같은 확장의 options.html 문서에서 온 요청만 받아요. 기존 옵션 발신자 검증도 허용한 네 목적지 hash와 정확한 확장 protocol·hostname·pathname을 확인하며 임의 query·다른 hash·하위 프레임은 허용하지 않아요.

### 채널 영상 검색의 원본 페이지 묶음

2026-10-03 실제 `#videos-PANEL`에서 영상 grid와 형제인 컨테이너 안의 `ol > li > button` 숫자 페이지 묶음을 확인했어요. 클래스는 `_container_1ihlx_1`, `_list_1ihlx_35`, `_button_1ihlx_8` 형태였고 pagination 이름·다음/이전 버튼이 없었어요. 구현은 해시 대신 현재 grid 형제·숫자 목록 구조를 확인해 검색 결과 표시 중에만 원본 묶음을 숨겨요. [실측·복원 검증](measurements/vod-search-pagination-2026-10-03.md)을 참고해요.
