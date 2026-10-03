# 페이지 기능 작업 지침

## 공통 경계

이 디렉터리는 치지직 페이지에서 실행할 기능과 해당 하위 모듈을 소유해요. 파일 존재와 실제 주입은 다르므로 manifest·동적 등록을 먼저 확인해요. 저장 스키마·서비스 워커 메시지 검증·시청 기록 쓰기 큐·옵션 폼 자체를 feature 안으로 가져오지 않아요.

기능은 기존 IIFE·전역 네임스페이스를 사용해요. isolated 기능은 공용 `bindFeatureOptions`, `startPageChangeDetection`, observer·DOM 예약 유틸을 먼저 확인해요. 옵션 OFF·SPA 이탈·대상 교체 시 UI와 observer·listener·timer·RAF·요청을 정리하고, 늦은 응답이 재설치하지 못하게 해요.

MAIN 파일은 isolated의 `BetterChzzk`와 `BetterChzzkSettings`를 읽지 않아요. 페이지 객체를 다루는 파일의 테스트를 통과시키려고 확장 storage·메시지·직접 네트워크 권한을 추가하지 않아요.

## 기능별 소유권

| 파일·묶음                                                            | 소유하는 책임                                               | 침범하지 않는 경계·주요 회귀                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeBridgePage.js`                                                 | history 변경 통지와 확인된 팔로잉 이동 위임                 | 임의 전역 라우터·기능별 재패치를 추가하지 않아요. content-route-utils·extension-pages                                                                                                                                  |
| `autoQuality.js`, `autoQualityPage.js`                               | 설정·라우트 조정과 MAIN의 실제 화질 선택                    | 입장 저화질 개선·선호 화질 저장 시 적용이 목표예요. 초기 playing·선택 Promise와 시청 중 수동 선택을 구분해요. auto-quality-live-choice·page-hooks-integration                                                          |
| `adVideo.js`, `adVideoPage.js`                                       | 저장 옵션 중계와 확인된 광고 응답·소스·스케줄 처리          | 일반 재생정보·암호화 바이트·미확인 형식을 변경하지 않아요. ad-video·ad-video-registration                                                                                                                              |
| `adblockPopup.js`, `qualityInstallGuide.js`                          | 저장 설정 확인 후 네이티브 안내 닫기·일반 화질 시청 선택    | 스크롤 소유권·닫히지 않는 안내를 숨기지 않아요. adblock-popup-close·quality-install-guide                                                                                                                              |
| `adBanner.js`                                                        | 확인된 광고 슬롯의 CSS 숨김                                 | 광고 네트워크·영상 소스를 제어하지 않아요. ad-banner                                                                                                                                                                   |
| `headerButtons.js`, `headerBannerLayout.js`                          | 지정 헤더 버튼 숨김과 실측한 배너 레이아웃 충돌 보정        | 원본 transform·top을 파괴하지 않고 필요한 확장 스타일만 정리해요. header-buttons·header-banner-layout                                                                                                                  |
| `panelResizeModel.js`, `panelResize.js`                              | 양쪽 너비 계산·마우스 경계 조작·가로 스타일·local 선택 보관 | 원본 채팅·사이드바·영상 노드와 재생 상태, 배너의 세로 보정을 소유하지 않아요. panel-resize-model·panel-resize                                                                                                          |
| `skipControl.js`                                                     | 시간 이동 UI·키, 라이브 일시정지 재개 처리                  | 자동 위치 보존 의도는 일시정지→재생에 한정돼요. 현재 타임시프트 가드는 별도 검토 대상이며 조용히 삭제하지 않아요. playback-media-lifecycle·extension-pages                                                             |
| `holdSpeed.js`, `screenShortcuts.js`                                 | 임시 홀드·배속 키와 선택형 네이티브 기본 조작               | Space 홀드가 키를 소유하면 기본 단축키는 양보해요. 자동 실패 감지를 되살리지 않아요. hold-speed·screen-shortcuts                                                                                                       |
| `volumeWheel.js`, `volumeWheelPage.js`                               | 설정 중계와 메인 볼륨 영역의 휠                             | 보조·광고 영상과 일반 페이지 스크롤을 가로채지 않아요. extension-pages                                                                                                                                                 |
| `volumeTooltip.js`                                                   | 볼륨 표시와 독립 오디오 컴프레서                            | 홈·목록에서 미리 등록하지 않고 첫 재생 진입에 기본 선택을 이어받아요. 복원한 탭은 선택을 유지해요. 네이티브 볼륨을 컴프레서 출력과 혼용하지 않고 출처 고지를 유지해요. audio-compressor-state·playback-media-lifecycle |
| `playerZoom.js`                                                      | 커서 중심 확대·이동·복원과 실제 조작 영역 기록              | 영상 부모·재생 위치·기본 버튼 소유권을 바꾸지 않아요. player-zoom·player-zoom-controls                                                                                                                                 |
| `playerButtons.js`, `livePlayerDisplay.js`, `timeMachineLagLabel.js` | 컨트롤 표시·실제 방송 시작 시각·현재 지연 표시              | 숨김으로 PIP를 종료하거나 방송 시작시각과 재생 위치를 혼동하지 않아요. player-buttons·extension-pages                                                                                                                  |
| `streamInfo.js`, `streamInfoModel.js`                                | 열린 패널의 수집·표시와 순수한 최근 60초 관측 계산          | 닫힘·숨김에서 수집을 멈추고 현재 트랙·방송 정체성·결측을 구분해요. stream-info·stream-info-model·stream-info-page                                                                                                      |
| `offlineLiveReload.js`, `channelChatLink.js`                         | 종료 라이브의 재개 감지와 채널의 일반 라이브 링크           | 방송 알림·자동 입장 전체 상태를 소유하지 않아요. offline-live-reload·channel-chat-link                                                                                                                                 |
| `liveStartRegistration.js`                                           | 헤더 채널 검색·등록 선택 UI                                 | 전역 기능 토글·실제 알림·탭 실행을 직접 소유하지 않아요. live-start-registration                                                                                                                                       |
| `liveWatchHistory.js`, `watchActivity.js`, `watchActivityPage.js`    | 실제 시청 세션·현재 본인 활동·읽기 전용 React 데이터 중계   | 기록 저장은 background에 요청해요. 임시 제목·늦은 계정 응답·최소 시청 전 활동을 구분해요. watch-activity·watch-history-store·extension-pages                                                                           |
| `vodBroadcastClock.js`                                               | VOD 재생 위치의 방송시각과 같은 방송 제목 이력 표시         | liveId와 videoNo를 같은 ID로 취급하지 않아요. vod-timeline·playback-media-lifecycle·extension-pages                                                                                                                    |
| `vodReplayChatFix.js`                                                | 열린 VOD 채팅 제목 누락의 1회 복구와 일회용 위치 전달       | 닫힌/없는 패널·미준비 영상을 재로드하지 않아요. 복구 위치를 URL에 남기거나 일반 VOD 기록으로 저장하지 않아요. vod-resume·playback-media-lifecycle·extension-pages                                                      |
| `chatTools.js`, `chatTools/`                                         | 채팅 표시 옵션과 파싱·정체성·패널의 조립                    | 본인 활동의 영구 저장 기능과 별개예요. chat-tools·chat-tools-modules                                                                                                                                                   |
| `chatTimestamp.js`, `chatTimestampPage.js`, `chatWeeklyRanking.js`   | 서버 작성시각 표시·읽기 브리지·주간 랭킹 숨김               | 누락 시각을 현재 시각으로 만들지 않고 메시지·보상 UI를 랭킹으로 숨기지 않아요. chat-timestamp·chat-weekly-ranking                                                                                                      |
| `vodCommentTabs.js`, `vodComments/`                                  | VOD 댓글 데이터·네이티브 위임·확장 화면의 조립              | 치지직 댓글 트리를 옮기거나 잘못된 댓글의 버튼을 누르지 않아요. vod-comment-model/repository/tabs                                                                                                                      |
| `categoryTools.js`, `categoryTools/`                                 | 방송 목록의 검색·필터·배지·제한된 집계                      | UI가 조회 캐시·다음 페이지 예약을 중복 소유하지 않아요. category-tools 계열·dom-scheduling                                                                                                                             |
| `videoSearch.js`, `videoSearch/`                                     | 채널 영상 제목·댓글 검색과 결과 표시                        | 전체 조회 완료·부분 결과·댓글 오류를 구분해요. refactoring-data-modules·navigation-data·extension-pages                                                                                                                |
| `titleTooltip.js`                                                    | 말줄임된 제목의 전체 내용 표시                              | 숨겨진 탐색 문구를 제목에 섞지 않고 옵션·DOM 교체 때 이전 툴팁을 정리해요. extension-pages                                                                                                                             |
| `monthlyBroadcastTime.js`, `monthlyBroadcastTime/`                   | 채널 최근 평균·월간 달력·내 시청 표시                       | VOD로 확인할 수 없는 방송 시간까지 총계로 주장하지 않아요. monthly-broadcast-time·refactoring-data-modules                                                                                                             |
| `sidebarCustomization.js`                                            | 숨김·고정·보충 행·드래그 데이터                             | 원본 행 재부모화·실제 팔로우 변경을 하지 않아요. sidebar-customization                                                                                                                                                 |
| `followingListState.js`, `followingRefresh.js`                       | 접기 선택 기억과 네이티브 새로고침                          | 다른 댓글 새로고침을 누르지 않고 숨은 탭·오프라인 갱신을 구분해요. following-list-state·extension-pages                                                                                                                |
| `followingTitleHistory.js`                                           | 팔로잉 본문의 검증된 현재 방송 제목 이력                    | 사이드바·다른 경로·다른 liveId 제목을 합치지 않아요. following-title-history                                                                                                                                           |
| `followingPreviewTooltip.js`, `livePreviewFastHoverPage.js`          | 확장 미리보기·소리와 네이티브 호버 대기의 제한된 조정       | 네이티브 목록 영상은 사이트 소유예요. 새 창·iframe·원격 재생 코드 대체를 추가하지 않아요. following-preview-tooltip·live-preview-fast-hover-page                                                                       |
| `liveMultiview/`                                                     | 원본 메인과 확장 보조 방송의 구성·재생·배치                 | 메인 채팅·제목·라우터를 별도 가짜 화면으로 대체하지 않아요. live-multiview                                                                                                                                             |
| `rewardAutoCollect.js`                                               | 실측 수령 버튼과 서버가 준 비시청 claim 수령                | WATCH_1_HOUR는 페이지 버튼 경로예요. 구독·로그인·결제를 자동 클릭하지 않아요. reward-auto-collect                                                                                                                      |

표의 테스트 묶음은 `tests/`의 해당 `.test.js` 파일이에요. 사용자 행동과 관측 형식·호출 횟수·정리 경로를 검사하며, 함수 배치·임의 대기시간에 맞추려고 assertion을 느슨하게 만들지 않아요.

광고는 본영상 보존을 우선하고 확인된 광고 계약·현재 소유가 유지되는 새 ID와 부가 필드를 처리해요. 명시적 표시 응답의 두 boolean만 변경하며 구형 exact shape·상한은 별도로 유지해요. 직접 소스는 최초 네이티브 초기화 전까지만 판단하고 이미 진입한 소스를 재설정으로 다시 끊지 않아요. NLiveCast 바깥 객체는 보존하며 검증된 내부 요청만 생략해요. 독립 라이브 일정은 네이티브 등록·현재 채널 props·첫 두 React ref·표시 정보로 소유를 확인하고 `adSources`만 비워 항목·시간·순서·원본·네이티브 완료를 유지해요. 공유 중간 일정은 관측한 다른 manager와 현재 본영상 소유도 확인해요. 별도 광고용 video와 본영상은 혼동하지 않아요. API·소유·경계 미도달은 원본 통과예요. 카운터는 파싱·소스 적용·일정 변환·내부 요청 읽기의 기존 호출 단위를 유지하고 새 ID를 입장 광고로 추정하지 않아요. 자동 완료 모델을 실제 Chrome 재생 성공으로 보고하지 않아요.

라이브 PiP의 주소 밖 일정 예외는 같은 광고 컴포넌트·등록·player의 실제 영상과 PiP 레이아웃·형제 광고 wrapper의 소유가 함께 맞아야 해요. 주소 제한만 삭제하거나 PiP 클래스 하나로 일반 미리보기를 허용하지 않아요. 중간 광고의 miniMode를 PiP 상태로 오인하지 말고, PiP 종료·영상/부모 교체·등록 해제·OFF 및 공유 표시 정보 회귀를 유지해요.

독립 저지연 우선 기능은 제거됐어요. 과거 liveLowLatencyEnabled·lowLatencyEnabled가 남아 있어도 옵션·제어·재시도를 되살리지 않아요. live-low-latency 회귀는 폐기된 설정의 무효화와 기존 화질·관측 보존을 확인하고, auto-quality-live-choice는 원래 자동 화질 경로를 보호해요.

스트림 정보의 MAIN 요청은 기존 화질 파일의 읽기 전용 탐색만 사용해요. 설정·과거 적용 결과를 현재 트랙으로 대신하거나, 진단 때문에 제어 래퍼·재생·seek·배속 변경을 실행하지 않아요. 통계 모델은 입력한 단조 시각과 미디어 스냅샷만 계산하며 DOM·타이머·저장을 소유하지 않아요. 같은 방송의 새 영상은 fresh live-detail의 채널·liveId를 확인한 뒤에만 과거 자료를 유지해요. 확인 실패·다른 방송은 새 측정, 숨김·소스 전환은 그래프 단절, 닫힘은 자료 폐기로 구분해요. 미지원·준비 중을 0으로 표시하거나 지연 감소를 안정성 향상으로 판정하지 않아요.

패널 너비 모델은 DOM·실제 저장소·타이머를 소유하지 않고, 런타임만 기존 옵션·라우트 감지와 패널별 local 저장에 연결해요. 옵션과 너비의 초기 읽기가 끝나기 전에는 설치를 기다려 저장된 OFF나 너비를 잠시 무시하지 않아요. 다른 탭의 선택은 새 문서에서 읽고, SPA·BFCache·OFF/ON은 현재 문서 선택을 유지해요. 기본 상태는 너비를 지정하지 않고, OFF·루트 교체·취소는 확장 소유 marker·변수·이벤트만 정리해요. 원본 style 전체 복원이나 채팅·사이드바 노드 재부모화를 하지 않아요.

너비 핸들은 마우스 드래그·더블클릭으로만 조작하고 키보드 리스너·Tab 진입·강제 focus를 만들지 않아요. hover와 drag 강조는 같은 경계선 하나로 표시하고 다른 UI의 focus 스타일은 건드리지 않아요. 다른 패널 값을 함께 쓰지 않으며 초기화는 이미 기본 상태여도 해당 local 키의 null을 저장해요.

선택 너비와 화면에 제한된 너비를 분리해요. 조작 확정·기본 복원만 저장하고 창 축소·접힘·전체화면·OFF로 선택을 덮어쓰지 않아요. 다른 패널의 현재 표시 폭을 확보하고 저장값은 유지하는지, 저장 실패 뒤 현재 문서에서 조절·복원이 가능한지, 오래된 콜백과 동일 노드의 observer 통지가 중복 손잡이·예약을 만들지 않는지 검사해요. 댓글 전용 영역·배너 스타일·열린 미리보기·멀티뷰·영상 상태 보존은 인접 기능 회귀로 확인해요.

## 현재 실행되지 않는 파일

`adAutoSkip.js`는 개발용이에요. 개발 테스트가 통과해도 옵션·자동 주입·배포 승인을 뜻하지 않아요. 현재 오래된 저장값은 무효이고 배포 구성에서 제외돼요. `updateNotice.js`는 보관된 공지 형식이며 manifest·background의 실행 진입점이 아니에요. 새 기능 요청 없이 기존 공지를 되살리지 않아요.

새 버전 안내는 별도 `updateGuide.js`가 isolated 최상위 문서에서 소유해요. 자동 안내와 수동 다시보기는 같은 내용·20초 타이머·상단 게이지를 사용해요. 다시보기에서 제목에 강제로 초점을 옮겨 타이머를 멈추지 않아요. 1.4.1은 크기 조절·시청기록 백업 두 항목을 한 창에 표시하고 닫기 버튼 하나만 남겨요. 저장 상태와 표시 승인 토큰은 워커에 요청하고 claim의 token만으로 표시하지 않으며 commit 승인을 기다려요. 창 초점 이탈·일시적 탭 숨김에서는 준비 중인 예약만 취소하고 이미 표시한 안내는 보존하며 타이머를 멈춰요. 문서가 보이고 초점을 다시 얻으면 남은 시간만 이어가요. 자동 안내의 늦은 응답은 해당 안내만 정리하고 수동 안내의 타이머를 취소하지 않으며, 게이지 생성 실패가 자동 닫힘을 막지 않아요. 전체화면·SPA·OFF·재주입과 늦은 응답의 소유 UI·예약 정리 경계를 지키고 입력·재생·설정은 자동 조작하지 않아요. 실제 표시 공간이 없으면 소비 전에 기다려요. update-guide-runtime/view/controller와 기존 update-notice 퇴역 경계를 함께 검사해요.

## 화면·정리 검증

수정 전 현재 CHZZK DOM·API·플레이어 형식을 측정해요. 테마 토큰은 실제 값과 기본값을 함께 사용하고, 원본 노드 참조는 실행 직전 데이터 정체성을 재검증해요. 새로고침·SPA·옵션 ON/OFF·루트/행 재마운트·라이트/다크·키보드를 변경 범위에 맞게 확인해요.

`tests/release-safety.test.js`는 주석까지 포함한 금지 경로·world·단일 writer 검사를 유지해요. 기능 내부의 작은 변경은 해당·인접 기능 테스트와 변경 파일 lint·포맷 검사로 마쳐요. 공용 변경은 소비자 테스트까지 넓히고, 설정·저장·권한·발신자 검증·world·로딩 경계·manifest·의존성·검사 설정 변경, 영향 범위가 불명확한 변경이나 릴리스 전에는 전체 test:all·lint·format:check를 실행해요. 테스트는 `--test-concurrency=2`로 제한하고 검사 명령을 순차 실행하며 여러 테스트 묶음을 겹치지 않아요. 선택한 검사 범위와 전체 생략 이유를 남기고, 실제 확장 재로드·주입·미디어 동작 확인 여부는 자동 테스트 결과와 분리해서 보고해요.
