# 아시안게임 방송의 광고 차단 안내와 재생 실패 조사

## 대상과 사용자 제보

- 조사 날짜: 2026-09-19 KST. 작업 브랜치 `1.3.9`, 시작 HEAD `52d7d3536811dc0cde223fdc7a5adac67955571e`.
- 대상: <https://chzzk.naver.com/live/dda025527999c166168474b9620bc8e0>.
- 방송: `아시안게임 TV조선`의 `2026 아이치 나고야 아시안게임 개회식`, 조회 당시 liveId `21193148`.
- 사용자 화면에는 `광고 차단 프로그램을 사용 중이신가요?` 안내와 `확인` 버튼이 있다. 사용자는 일반 방송은 정상이고 이 방송에서만 문제가 나며, 직접 확인을 눌러도 영상이 재생되지 않는다고 설명했다.
- 치즈 스패너의 **동영상 광고 차단** 옵션을 끄고 저장한 뒤 해당 방송을 새로고침해도 재생되지 않았다는 사용자 비교 결과를 받았다. 이 비교만으로 다른 기능이나 함께 설치된 프로그램까지 원인에서 제외할 수는 없다.

## 현재 배포 소스에서 확인한 동작

- [홈페이지](https://chzzk.naver.com/)가 참조한 [index-DdGx9_UO.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-DdGx9_UO.js)는 HTTP 200, Last-Modified `2026-09-16 09:15:02 GMT`, SHA-256 `762468c6f788702c9a35a7929c5122ee692908ffdda63f9ef96bcb90f2f148ec`였다. 이 응답 헤더만으로 사이트 전체의 마지막 업데이트 시점을 판정하지 않는다.
- 광고 차단 안내 `lX`는 공용 모달에 `data-nlog-area="ad_blocking_info_layer"`를 전달한다. `hideCloseButton` 기본값은 true이며, 이 안내는 닫기 버튼을 켜지 않는다. 하단의 `ad_block.confirm` 버튼에 `confirmHandler`를 연결한다.
- [현재 한국어 문자열](https://ssl.pstatic.net/static/nng/glive/locales/pc/strings-ko_kr.json)의 `ad_block.title`, `ad_block.confirm`, 설명·참고 문구는 사용자 화면과 일치한다.
- 라이브의 확인 핸들러는 `e=>{e.isTrusted&&oe(!1)}`, VOD는 `e=>{e.isTrusted&&m(!1)}`다. 일반 DOM `.click()`으로 생성한 이벤트로는 이 조건을 통과하지 못한다. 확인은 팝업 표시 상태만 해제하며 재생 정보를 다시 요청하지 않는다.
- [9월 14일 수정 시각의 이전 배포본](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-GNyFfAPg.js)에도 두 `confirmHandler`의 `isTrusted` 검사가 있다. 이번 제보만으로 오늘 도입한 동작이라고 볼 근거는 없다.
- 라이브 팝업은 상세 정보의 `dab` 값뿐 아니라 `live-playback-json-meta` 요청 처리 중 `TunnelIntegrityError`가 발생할 때도 표시된다. 후자에서는 정상 playbackJson을 설정하는 경로로 진행하지 않는다.
- [vendor-DQYi7KBW.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/vendor-DQYi7KBW.js)의 터널 응답 처리기는 `crypto.subtle.decrypt()` 실패를 `TunnelIntegrityError`로 변환한다. 따라서 광고 차단 안내 문구만으로 사용자의 실패 원인을 특정할 수 없다. 사용자의 실제 요청에서 이 예외가 발생했는지는 아직 수집하지 않았다.
- [player-vendor-BYg0wCyN.js](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-BYg0wCyN.js)의 SHA-256은 `3add7ef97995bc4e7052e03c84c18e9fe34d5d6212e4672c6f5f76412c9147bc`로, 9월 14일 래퍼 조사에 기록한 값과 같다.

## 공개 API 비교

로그인 쿠키와 브라우저 재생 세션을 사용하지 않은 HTTP 조회다. 사용자 브라우저의 요청 결과와 동일하다고 간주하지 않는다. 서명된 미디어 주소와 키 내용은 기록하지 않는다.

| 확인 항목                                                      | 아시안게임 TV조선                  | 비교 일반 방송: 아리사             |
| -------------------------------------------------------------- | ---------------------------------- | ---------------------------------- |
| 채널 ID                                                        | `dda025527999c166168474b9620bc8e0` | `4de764d9dad3b25602284be6db3ac647` |
| `/service/v3/channels/{id}/live-detail`                        | HTTP/code 200                      | HTTP/code 200                      |
| liveId / playbackJson의 meta.liveId                            | `21193148` / `21193149`            | `21188400` / `21188400`            |
| mediaId                                                        | HLS                                | HLS, LLHLS                         |
| media의 aes                                                    | `hls_aes`                          | 해당 필드 없음                     |
| 공개 응답의 영상 높이                                          | 480, 360                           | 1080, 720, 480, 360, 144           |
| 상세 응답의 dab                                                | 필드 없음                          | 필드 없음                          |
| `/service/v1.1/channels/{id}/live-playback-json-meta?tm=false` | HTTP/code 200                      | HTTP/code 200                      |

- 아시안게임 재생 메타 응답의 content 키는 `playbackJson`, `pq`, `tmp`이며 `pq=[]`, `tmp=false`다. playbackJson에도 HLS의 `aes="hls_aes"`가 있다.
- 공개 응답이 안내한 `/service/v1/encryption/lives/21193149/aes_key`를 같은 비로그인 환경에서 요청하면 HTTP 403과 접근 거부 메시지를 받았다. 실제 사용자 세션의 키 요청 실패를 입증하는 자료가 아니다.
- 스트림의 HLS AES 암호화와 앞 절의 터널 응답 복호화는 별개의 처리다. 암호화 스트림이라는 사실이나 비로그인 키 요청 403만으로 팝업의 원인·광고 확장과의 인과관계를 확정하지 않는다.

## 작업 범위와 검증 한계

- 처음에는 확인 버튼형 안내를 자동 닫는 회귀 사례를 임시 작성했다. 사용자에게 직접 확인을 눌러도 재생되지 않는다는 설명을 받은 뒤, 이 수정으로는 재생 실패를 해결할 수 없다고 판단해 이번 작업에서 추가한 테스트만 원복했다. 기존 작업 파일의 내용과 동일한 SHA-256을 확인했다.
- 초기 재생 실패 조사에서는 런타임, manifest, 옵션, 버전, 릴리스 문서를 변경하지 않았다. 아래의 후속 실측으로 치즈 스패너 단독 사용 시 광고 누락 원인을 확인한 뒤 해당 소유권 검사만 수정했다. 기존 광고 차단 옵션을 자동으로 끄거나 팝업만 영구 숨기는 처리는 추가하지 않았다.
- 기존 `tests/adblock-popup-close.test.js` 9개는 통과했다. 이는 기존 닫기 동작의 모형 검증이며, 해당 아시안게임 방송이 재생된다는 검증이 아니다.
- 사용자 지침에 따라 컴퓨터 사용 도구는 사용하지 않았다. 별도의 연결된 브라우저 조사 도구가 없어 실제 확장 주입 상태·콘솔 예외·사용자 세션의 실패 요청·라이트/다크 화면은 측정하지 못했다.
- 사용자는 충돌보다는 치지직이 강화한 차단 로직일 가능성을 제시했다. 특정 중계에 적용되는 재생 검증을 다음 조사 대상으로 삼되, 이를 전체 확장 비활성화 비교 결과나 차단 강화의 확정 근거로 기록하지 않는다.
- [치지직의 공식 안내](https://help.naver.com/service/30044/contents/23806?lang=ko&osType=COMMONOS)는 광고 차단 프로그램 사용 시 시청 제한이 발생할 수 있다고 설명한다. 이번 아시안게임 방송에 새 정책을 적용했는지, 오늘 검증을 강화했는지에 대한 설명은 아니다.
- 현재 배포 코드의 확인 버튼 검사와 터널 복호화 오류 처리는 확인했지만, 사용자의 실패 요청·응답과 실제 예외는 확인하지 못했다. 그 자료 없이 원인이 치즈 스패너, 다른 프로그램, 서버 판정 또는 서비스 오류 중 무엇인지 확정하거나 재생 복구 수정을 완료했다고 보고할 수 없다.

## 후속 비교: 애드가드와 치즈 스패너 단독 사용

- 사용자는 **애드가드를 사용하면 팝업이 뜨고, 애드가드를 끈 뒤 치즈 스패너 광고 차단을 켜면 광고가 재생된다**고 설명했다. 최초의 팝업·재생 실패와 치즈 스패너 단독 사용 시 광고가 남는 현상을 구분한다. 이 결과를 두 확장 사이의 충돌이나 서버의 오늘자 정책 변경으로 확대 해석하지 않는다.
- 치즈 스패너 단독 사용 시 광고 시간·건너뛰기 등이 표시되는 형태라고 확인했다. 광고 UI만으로 별도 광고 영상인지 NLiveCast의 본영상 메타데이터 기반 광고인지 확정하지 않는다.
- 사용자가 개발자도구에서 읽은 `data-betterchzzk-ad-video-status`는 두 번 모두 다음 값이었다. 이는 광고 MAIN 코드가 실행 중이라는 근거이며, 소스 setter에 실제로 연결되어 광고를 처리했다는 근거는 아니다.

```json
{
    "active": true,
    "changedParses": 0,
    "blockedVodSources": 0,
    "blockedLiveSources": 0,
    "blockedLiveSchedules": 0,
    "blockedWrappedLiveRequests": 0,
    "reloadRequired": false
}
```

- 현재 치지직 소스는 `adParameter.tag === "asiangames"`일 때 `LIVE_CHZZK_NDP_SCH_EVENT`를 사용한다. 치즈 스패너의 기존 `isKnownAdSource`에는 이 값이 이미 있으며 일반·이벤트 스케줄 검사가 모두 통과했다. 이벤트 구분값 누락으로 단정할 수 없다.
- 현재 치지직 소스는 방송의 liveId와 재생 메타의 meta.liveId가 다르면 라이브 광고 요청을 `NLiveCastAdRequest`로 감싼다. 앞서 조회한 대상 방송에는 이 차이가 있다. 실제 사용자 탭의 source·controller 구조와 setter 연결 상태는 아직 측정하지 않았다.
- 후속 HLS 텍스트 조회는 master와 첫 variant 모두 HTTP 200이었다. variant에서 `EXT-X-KEY:METHOD=AES-128`, `EXT-X-TARGETDURATION:2`, `nmss-daterange` ID, 2초 `EXTINF` 세 개를 확인했다. 해당 시점 목록에 명시적인 광고 구간 표시는 없었으며, 이를 전체 방송의 광고 삽입 방식에 대한 증거로 사용하지 않는다. 영상 세그먼트와 암호화 키는 받지 않았다.
- 기존 광고 처리·등록 테스트 `node --test tests/ad-video.test.js tests/ad-video-registration.test.js` 24개가 통과했다. 현 탭의 차단 성공을 검증한 결과는 아니다.
- 사용자 탭에서 source 타입, 스케줄·서비스 식별값, `_init` 필드, videoSlot 연결 상태와 기존 setter 패치 여부를 읽는 일회성 진단 코드를 임시 폴더에 준비했다. 최초 진단의 `contains(videoSlot)` 호출이 객체를 Node로 가정해 실패했고, 이를 수정한 뒤 아래 결과를 받았다. 진단 코드는 네트워크·재생·설정 변경을 하지 않으며 내부 요청 접근자를 실행하지 않는다.

## 실제 광고 소스와 수정 원인

사용자가 재생 중인 탭에서 보내 준 값은 다음과 같다.

- `sourceSetterPatched=true`: 광고 소스 setter에 치즈 스패너 처리가 연결되어 있다.
- `sourceSystem="ncast.advertisement"`, `_init` 필드는 `playerType`, `uiElements`, `disableTrackingCors`, `linearAdRequest` 네 개이고 `playerType="LIVE_PW"`다.
- 내부 스케줄은 `LIVE_CHZZK_NDP_SCH_EVENT`, 서비스는 `chzzk_live`지만 `innerRequestGuarded=false`다. 실제 광고의 `adSystem`은 `NDP Video`, `adPlacementType`은 `pre`였다.
- `videoSlot`은 Node가 아닌 객체이며 `_videoElement`, `shadowRoot` 필드를 가진다. `videoSlot.isConnected=true`, `contentVideoElement===videoSlot`이고 `shadowRoot`는 현재 `.chzzk_player` 안에 있다.
- 배포 SDK의 미디어 어댑터 생성자에서도 `_videoElement`에 실제 video를 보관하고 이를 감싼 div를 `shadowRoot`에 저장하는 구조를 확인했다. 공개 `video` getter는 `_videoElement`를 반환한다. 내부 플레이어는 이 어댑터를 광고 컨트롤러의 두 영상 인자로 전달한다.

기존 `hasChzzkPlayerSlot()`은 `videoSlot instanceof Element`인 경우에만 부모를 따라 올라갔다. 실측한 어댑터는 이 조건이 false여서 광고 구분값과 소스 setter가 모두 맞아도 내부 요청 처리를 설치하지 않았다.

수정 후에는 기존 Element형 슬롯을 유지하면서 확인된 객체형 어댑터만 실제 영상으로 해석한다. `contentVideoElement`와 슬롯의 동일성, 자체 데이터 필드인 `_videoElement`·`shadowRoot`, HTMLVideoElement 타입, root의 영상 포함 여부, 공개 `video` getter와의 동일성을 확인한다. 실제 영상이 연결되어 있고 기존 `.chzzk_player` 소유 경로에 속해야 한다. 분리·재사용 시에도 현재 영상을 다시 확인한다.

본영상 어댑터와 바깥 NLiveCast 객체·메서드는 유지하고 기존 내부 광고 요청 처리만 정상 적용한다. 새 네트워크 요청, observer, 타이머, 권한 또는 전역 패치는 추가하지 않았다. 애드가드 사용 시 발생하는 재생 실패를 해결한 변경은 아니다.

객체형 슬롯의 광고 차단 및 수명주기 회귀 사례 두 개는 수정 전 실패, 수정 후 통과했다. 다른 영상·root·소유자, 미확인 접근자와 분리된 노드는 그대로 통과하는 보호 검사를 추가했다. 같은 소유권 검사를 사용하는 `glad:` 경로도 객체형 슬롯에서 광고 팩토리 실행만 차단하고 미디어 URL을 유지하는지 확인했다.

- 관련 광고·등록 검사 28개 통과.
- `npm.cmd run test:all` 858개 통과.
- `npm.cmd run lint`, `npm.cmd run format:check`, `git diff --check` 통과.
- README 최신 변경 요약과 1.3.9 개발 중 릴리스 내역에 사용자 동작 차이를 반영했다. 버전·권한·개인정보 처리에는 변경이 없다.
- 실제 브라우저에서 수정본 확장 재로드와 대상 방송 새로고침을 직접 수행하지는 못했다. 사용자에게 재로드 후 광고 없는 본영상 재생과 `blockedWrappedLiveRequests` 값을 확인해 달라고 요청했다.
- 사용자는 재로드·새로고침 요청 후 **광고가 차단됐다고 확인**했고, `active=true`, `blockedWrappedLiveRequests=1`, `reloadRequired=false`인 실제 탭의 상태값을 전달했다. 다른 처리 카운터는 0이었다. 수정 전 같은 항목이 0이고 `innerRequestGuarded=false`였던 상태와 비교해, 누락됐던 내부 광고 요청 처리가 적용된 것을 확인했다.
- 이 결과는 사용자의 해당 아시안게임 방송 실측이다. 별도 중간 광고 발생, 장시간 재생, 다른 방송과 라이트·다크 화면 전체를 이번 작업에서 직접 검증한 결과로 확대하지 않는다.
