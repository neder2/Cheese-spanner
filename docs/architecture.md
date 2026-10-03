# 치즈 스패너 구조

## 실행 영역과 연결

치즈 스패너는 치지직 시청·탐색을 보완하는 Chrome Manifest V3 확장이에요. 런타임은 패키지에 들어 있는 일반 JavaScript와 IIFE로 연결하며, 파일이 존재한다는 사실만으로 실행되지는 않아요. 정적 진입점은 `manifest.json`, 동적 진입점은 서비스 워커의 등록 코드, 확장 페이지의 진입점은 각 HTML의 script 목록이에요.

| 영역                              | 소유하는 책임                                                                       | 들어오는 것 → 나가는 것                                     |
| --------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 페이지 MAIN world                 | 치지직 history·React props·플레이어 객체 접근, 네이티브 화질·광고·휠 처리           | 제한된 DOM 요청·설정 → 페이지 동작 또는 직렬화한 결과       |
| isolated world                    | 설정 읽기, 기능 UI, DOM 관찰, API 조회, 기능 수명주기                               | 저장된 설정·현재 경로·현재 DOM → 기능별 표시·명령           |
| `background.js`                   | 시청 기록 단일 쓰기 큐, 새 탭 기본 선택·탭별 컴프레서 상태, 광고 스크립트 등록 조정 | 검증한 확장 메시지 → 저장 결과·등록 결과                    |
| `shared/liveStartMonitor.js`      | 서비스 워커 안에서 방송 알림·자동 입장의 독립 큐와 alarm                            | 기기별 채널 설정·라이브 상태 → 중복 방지 상태·알림·탭 동작  |
| `shared/categoryExclusions.js`    | 프로필별 카테고리 제외 검증과 서비스 워커의 독립 저장 큐                            | 전체 방송 문서의 개별 선택 → local 상태 → 열린 목록의 반영  |
| `shared/donationHistoryImport.js` | 사용자가 시작한 과거 후원 조회 작업                                                 | 기록 페이지의 연결 → 로그인 확인·월별 조회 → 기록 쓰기 큐   |
| `options.html`                    | 액션 팝업과 옵션 페이지, 저장 전 편집 상태                                          | 옵션 스키마·저장값 → 사용자 승인에 따른 권한 요청·설정 저장 |
| `history.html`                    | 기록 조회·필터·달력·활동 표시, 삭제·후원 갱신 요청                                  | local 기록 → 화면; 변경은 서비스 워커에 요청                |
| `replay-pending.html`             | 기록에서 다시보기 번호를 찾는 동안의 대기 화면                                      | 기록 페이지가 연 탭 → 조회가 끝나면 해당 다시보기로 이동    |

MAIN world와 isolated world는 JavaScript 전역을 공유하지 않아요. 공유 DOM의 속성과 이벤트만 경계를 건너며, 옵션 객체나 React 객체를 직접 넘기지 않아요. 페이지 측에서 읽을 수 있는 DOM 속성을 확장 전용 비밀 저장소로 취급하지 않아요.

현재 정적 MAIN 파일은 `routeBridgePage`, `livePreviewFastHoverPage`, `chatTimestampPage`, `watchActivityPage`, `autoQualityPage`, `volumeControlsPage`, `volumeWheelPage`예요. `adVideoPage.js`는 여기에 포함되지 않고 저장된 광고 옵션에 맞춰 별도로 동적 등록돼요. 실제 파일 목록과 순서는 manifest·등록 코드를 다시 확인해요.

## 의존 방향

VOD의 영구 이어보기는 네이티브 상세·시청 이벤트의 소유예요. `vodReplayChatFix.js`는 실제 열린 채팅 패널의 제목 누락만 제한적으로 재로드하고, 같은 주소의 복구 위치 한 건을 사이트 sessionStorage로 다음 문서에 넘겨 첫 재생 뒤 소비해요. MAIN 자동 화질은 명시적 URL 시간의 초기 안정화 보정만 수행하며 완료·사용자 취소 뒤 같은 시간을 재적용하지 않아요. 이 경로에 background 기록 writer나 새 네트워크 요청을 연결하지 않아요.

isolated 영역은 `shared/settings.js` → `shared/data.js` → `shared/categoryExclusions.js` → `shared/selectors.js` → `content.js` 순서로 공용 기반을 준비해요. `content.js`는 이미 등록된 `BetterChzzk.utils`를 보존하며 DOM·라우트 기능을 추가해요. 기능의 model·repository·view는 해당 기능의 조립 파일보다 먼저 로드돼요.

서비스 워커는 settings·data·categoryExclusions·donationHistory·watchHistoryStore·adVideoRegistration·liveStart·liveStartMonitor·donationHistoryImport를 로드해요. `shared/` 전체가 워커용이라는 뜻은 아니에요. selectors·vodTimeline처럼 페이지 컨텍스트에 의존하는 파일을 디렉터리 단위로 일괄 로드하지 않아요.

백업에서는 `shared/watchHistoryBackup.js`가 파일 변환·검증을, `shared/watchHistoryBackupMerge.js`가 병합 결과와 제한된 삭제 복원 계산을, `shared/watchHistoryBackupController.js`가 신뢰 문서·확인 토큰·요청 조정을 담당해요. 서비스 워커는 기록 store 뒤에 이 세 파일을 순서대로 로드하고, 기존 기록 큐에 읽기·미리보기·저장을 직렬로 연결해요. store의 늦은 ID 연결도 같은 복원 범위 계산을 사용해요.

기록 페이지의 `historyBackup.js`는 파일 선택·다운로드·미리보기만 소유해요. HTML은 data·donationHistory·watchHistoryBackup·historyBackup·history 순서로 로드하고 history가 기존 조회 함수를 연결해요. 백업 UI와 기록 UI 모두 실제 저장은 background에 요청해요. 옵션 페이지에는 안내와 진입 링크만 있어요.

| 기능 경계      | 내부 역할 분리                                                                                                            | 바깥과의 연결                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 재생·화질      | `autoQuality.js`가 설정·라우트를 조정하고 `autoQualityPage.js`가 실제 플레이어를 제어해요                                 | DOM 브리지로 요청·결과를 교환해요                                                    |
| 채팅 모아보기  | parser는 현재 행을 읽고, messageStore는 정체성·원문·수집 상태를 관리하며, panel은 표시·선택·읽음을 관리해요               | `chatTools.js`가 옵션과 루트 교체를 조립해요                                         |
| 패널 너비      | `panelResizeModel.js`는 선택값 검증·가용 폭 계산, `panelResize.js`는 양쪽 경계·DOM 적용·local 너비 보관을 소유해요        | isolated에서 공용 설정·라우트 감지를 사용하며 채팅·팔로잉 기능과 독립적으로 연결해요 |
| VOD 댓글       | model은 정규화, repository는 VOD·정렬별 요청, nativeAdapter는 원본 댓글 조작 위임, view는 확장 DOM을 소유해요             | `vodCommentTabs.js`가 라우트·mount를 조정해요                                        |
| 방송 목록      | filterModel은 범위·제외 판정, repository는 목록·팔로워·이름 조회, searchController는 탐색 예약을 소유해요                 | `categoryTools.js`가 네이티브 카드와 결과 UI를 연결해요                              |
| 다시보기 검색  | model은 검색·진행률 계산, repository는 채널 인덱스·댓글 조회를 소유해요                                                   | `videoSearch.js`가 원본 카드와 결과 표시를 관리해요                                  |
| 방송 시간 통계 | model은 KST 달력·방송 계산, repository는 페이지·상세 조회를 소유해요                                                      | `monthlyBroadcastTime.js`가 채널 위젯을 관리해요                                     |
| 멀티뷰         | model은 구성·딜레이 계산, playback은 미디어, layoutControls는 배치, settingsPanel은 설정 UI, view는 DOM 생성기를 소유해요 | runtime이 네이티브 메인과 확장 보조 영상을 조립해요                                  |
| 시청·활동 기록 | liveWatchHistory는 세션 추적, watchActivity는 현재 계정의 새 활동 수집, watchHistoryStore는 변경 계산을 맡아요            | 저장은 background만 수행하고 history는 조회·명령만 해요                              |
| 팔로잉         | 고정·숨김, 접기 기억, 새로고침, 제목 이력, 미리보기는 별도 기능이에요                                                     | 원본 목록을 공유해도 상태와 저장 책임은 합치지 않아요                                |

멀티뷰의 메인은 치지직이 소유하는 플레이어와 라우터를 계속 사용해요. 보조 영상과 확장 소유 미리보기는 패키지의 hls.js를 사용해요. 일반 재생 조작이 보조 영상을 메인으로 오인하지 않도록 공용 메인 영상 판별을 사용해요.

## 대표 흐름

설정 저장은 편집값 정규화 → 필요한 선택 권한 요청 → `chrome.storage.sync` 저장 → 변경 구독 → 각 기능의 적용·정리로 이어져요. 권한이 거부되거나 저장이 실패한 상태를 저장 완료로 표시하지 않아요. 광고 옵션은 서비스 워커의 등록 조정 결과까지 확인하며, 새 문서의 초기 주입이 필요한 상태를 구분해요.

패널 너비는 새 문서의 확장 local 읽기 → 현재 문서 선택과 DOM 가용 공간 → 순수 모델의 표시 너비 계산 → 기존 패널·본문의 가로 스타일 적용으로 이어져요. 마우스 조작을 확정하거나 더블클릭으로 초기화할 때 해당 패널의 독립 local 키만 갱신해요. 너비 변경을 다른 문서에 구독시키지 않고 같은 문서의 복귀·옵션 재활성화는 메모리 선택을 사용해요. 기능 ON/OFF는 기존 옵션 구독을 사용하고, 너비 처리에는 MAIN 브리지·서비스 워커·시청 기록 저장 경로가 참여하지 않아요.

라이브 기록은 현재 채널과 실제 영상 진행 확인 → 누적 절대값 세션 스냅샷 → 확장 메시지 → 발신자·스키마 검증 → 쓰기 큐에서 최신 local 기록 읽기 → 병합·저장 → 결과 응답 순서예요. 시청 기록 페이지는 저장소 변경을 읽고 다시 표시해요. 늦은 스냅샷이 삭제한 기록을 되살리지 않도록 삭제 시점과 세션 정체성도 같은 저장 경계를 통과해요.

카테고리 제외는 전체 방송 필터 메뉴의 이름 검색 → 실제 결과 선택 → 검증한 확장 메시지 → 독립 워커 큐의 최신 local 읽기·개별 변경·저장 → 성공 상태와 저장소 변경 구독 순서예요. 열린 전체 방송 문서는 같은 프로필 선택을 반영하고 유형·ID로 카드 표시를 판정해요. 검색어·결과 캐시는 문서 메모리에만 두며 선택 목록의 지속 보관과 분리해요. MAIN 브리지·시청 기록 writer·전체 방송 집계에는 선택 변경을 연결하지 않아요.

페이지 이동은 MAIN의 route bridge → 공용 라우트 감지 → 기능별 이전 작업 취소·UI 정리 → 새 경로에 필요한 작업 시작으로 이어져요. React가 루트나 행을 교체하는 경우는 URL 이동과 별도로 처리해요.

## 외부 의존

치지직·네이버 API는 라이브 상세, 채널·영상·댓글·검색·보상·본인 후원 정보를 제공해요. 치지직 DOM과 React의 비공개 속성은 플레이어 제어·행 식별·원본 동작 위임에 사용돼요. CDN은 이미지와 HLS 미디어를 제공하며 실행 코드는 확장 안에 있어요. 별도 개발자 서버나 외부 분석 수집 경로는 없어요.

Chrome은 저장소, 확장 메시지, 스크립트 등록, 선택 권한, 알림, alarm과 탭 동작을 제공해요. Node 도구는 검증·패키징에만 사용하고 사용자 브라우저의 런타임 의존성으로 넣지 않아요.

## 새 기능 안내의 연결

shared/updateGuide.js는 패키지에 포함된 버전별 제목·설명·목적지를 제공해요. background에서 사용하는 shared/updateGuideController.js가 독립 큐로 최신 local 상태와 일시적인 문서 토큰을 관리하고, features/updateGuide.js가 isolated에서 표시 가능 상태와 20초 알림을 소유해요. 시청 기록 writer와 재생 MAIN 경로에는 연결하지 않아요.

상위 버전 설치 이벤트 → 현재 버전 자료와 옵션 확인 → 대기 상태 저장 → 보이는 콘텐츠 문서의 예약 → 소비 저장과 승인 응답 → 작은 알림 표시 순서예요. 소비 저장보다 먼저 UI를 공개하지 않아요. 오래된 공지 정리는 별도의 퇴역 키만 대상으로 유지해요.

shared/updateGuideView.js는 치지직과 옵션의 비모달 카드를 공용으로 렌더링해요. optionsUpdateGuide.js는 사용자가 누른 다시보기를 현재 팝업의 치지직 탭 또는 자신의 문서에 연결해요. options.js의 제한된 목적지 탐색은 기존 탭·그룹·검색 기능을 사용해 설정을 보여주며 저장 로직을 실행하지 않아요.
