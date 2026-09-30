# 광고 변화 이력과 현재 처리 계약 (2026-09-29)

## 조사 범위와 근거

작업 기준은 branch `1.4.1`, HEAD `ea22dfcdbeb167a75b038e50e9780afaa3aa221a`, manifest/package `1.4.0`이에요. 이 기록은 광고 계약의 공개 코드 근거와 구현·자동 회귀를 연결해요. 기존 변경·미추적 파일을 보존했고 버전 변경·커밋·배포는 하지 않았어요.

2026-09-29에 공개 홈과 홈이 참조하는 두 배포 파일을 HTTP로 다시 읽었어요. 원격 파일은 임시 폴더에 텍스트로만 저장했으며 실행하거나 제품·fixture에 복사하지 않았어요. 로그인 응답, 광고 배정, 실제 Chrome의 React 객체·확장 주입·본영상 진행은 이번에 측정하지 않았어요.

| 대상          | URL                                                                                       | HTTP | UTF-8 응답 텍스트 SHA-256                                          |
| ------------- | ----------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------ |
| 공개 홈       | <https://chzzk.naver.com/>                                                                | 200  | 아래 두 파일 참조를 확인했어요                                     |
| 현재 페이지 P | <https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-BBIPHoDO.js>         | 200  | `F5BCBD91F2E5F11D293BABF66BF6E302F696D6B3F82AC4BD6CF9079B2DACD6EF` |
| 현재 SDK S    | <https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/player-vendor-BYg0wCyN.js> | 200  | `3ADD7EF97995BC4E7052E03C84C18E9FE34D5D6212E4672C6F5F76412C9147BC` |

해시는 09-23 조사와 일치해요. 아래 위치는 해당 해시 파일을 UTF-8로 읽은 JavaScript 문자열의 0부터 시작하는 문자 위치예요. 축약된 변수·클래스 이름과 위치는 근거를 다시 찾기 위한 자료이며 제품의 판별 규칙으로 사용하지 않아요.

근거를 네 종류로 구분해요: 과거 실제 응답·사용자 진단, 이번 공개 배포 코드 정적 확인, 외부 필터 대응 이력, 요구 사항을 검증하기 위한 합성 변형이에요. 과거 대응 날짜를 치지직의 정확한 배포 날짜로 간주하지 않아요. 로컬 최초 커밋 `25d5885`의 2026-05-15도 실제 최초 개발일의 증거는 아니에요.

## 네 처리 경로와 완료 계약

| 경로               | 현재 또는 과거의 연결 근거                                                                                                                                                                             | 판별·보존 경계                                                                                                                                                                     | 네이티브 완료                                                                                                                                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 표시 결정          | P 2711159·3241047 부근의 라이브/VOD 분기는 명시적 `playerAdDisplayResponse`가 있으면 `preRoll/midRoll`, 없으면 구형 `livePlaybackJson.liveId/chatChannelId`를 읽어요                                   | 성공 응답과 필수 boolean을 검사해요. 명시적 형식은 부가 필드를 보존하며 두 값만 끄고, 구형 형식은 이름 충돌 때문에 기존 엄격한 제한을 유지해요                                     | 페이지가 받은 플래그로 광고 정책을 정해요. 응답 변경 자체는 실제 차단 성공의 증거가 아니에요                                                                                                                                        |
| 직접 소스·glad URI | P 3215000 부근에서 VOD 소스에 스케줄 정보·`svc: chzzk_video`를 설정한 뒤 `adsController.srcObject`에 연결해요. S 6156700 부근의 요청에는 `setVideoScheduleInfo`, `handshakeVersion`, `initAd`가 있어요 | 광고 컨트롤러 API, 현재 영상 소유 관계, 라우트와 서비스 일치, 비어 있지 않은 schedule ID를 함께 확인해요. 일반 본영상 소스는 보존해요                                              | S 3959660 부근의 setter는 `_attachSourceObject`에 전달하고, S 3956122 부근의 `initAd`는 소스가 없으면 반환해요. S 4956735·4970091 부근의 재생 경로도 광고 소스 유무를 읽어요                                                        |
| 감싼 라이브 요청   | 과거 09-14 페이지는 `linearAdRequest`를 `NLiveCastAdRequest`로 감쌌어요. 현재 P 2668118은 `playerType: LIVE_PW`만 전달하며 현재 페이지 전체에서 `linearAdRequest` 문자열은 없어요                      | 생성자 상수·prototype·필수 필드 타입을 확인하고 바깥 객체를 유지해요. 현재 소스와 소유 관계를 읽을 때마다 재확인하며 자체 writable/configurable 데이터 필드의 내부 요청만 처리해요 | S 4120203 부근은 내부 요청 초기화를 선택적으로 실행한 뒤 바깥 클라이언트를 만들어요. 내부 요청이 없다는 이유로 바깥 객체를 비우면 안 돼요                                                                                           |
| 독립 라이브 일정   | P 2696149 입장, 2590606 중간은 각각 두 React ref를 `contentVideo/adVideoContainer`로 전달해요. S 256820 부근의 팩토리는 컨테이너를 WeakMap 키로 등록한 뒤 manager를 반환해요                           | SDK API와 등록 키 관계에 더해 아래의 실제 네이티브 컴포넌트 소유 근거를 확인해야 새 ID 확대가 가능해요. VOD 일정 전체로 확대하지 않아요                                            | 일정·항목·필드·순서는 유지하고 적격 항목의 `adSources`만 비워요. S 249799의 모든 소스 완료 판정은 빈 목록에서도 참이며 네이티브 `SCHEDULE_COMPLETE`로 이어져요. P 2697000 부근은 실제 광고 시작이 없었던 완료를 `NO_ADS`로 처리해요 |

현재 라이브 페이지에서 직접 라이브 소스 또는 내부 요청이 있는 래퍼가 실행된다고 단정하지 않아요. 해당 계약은 과거 페이지와 동일한 현재 SDK에 남아 있어 지원하는 경로이며, 현재 기본 페이지의 입장 광고 경로는 별도 일정이에요. 완료 이벤트 코드 확인과 실제 본영상 진행 확인은 별개예요.

## 직접 소스의 소유 관계와 연결 시점

S 4948749 부근의 CorePlayer는 미디어 어댑터를 만들고 이를 `player`에 보관한 뒤 같은 객체를 광고 컨트롤러의 두 영상 인자로 전달해요. 광고 컨트롤러는 이를 `videoSlot/contentVideoElement`로 보관해요. S 4268629 부근의 어댑터 공개 `video` getter는 `_videoElement`를 반환해요. 이 구조는 09-19 사용자 진단의 `_videoElement`, Element형 `shadowRoot`, 공개 getter 동일성 결과와 일치해요.

현재 구현한 판별은 다음과 같아요.

- 요소형은 현재 문서의 실제 영상 슬롯에서 제한된 부모/host 경로를 따라 `.chzzk_player` 소유를 확인해요. 일반 페이지의 같은 모양 소스는 허용하지 않아요.
- 어댑터형은 `controller.contentVideoElement === controller.videoSlot`, 자체 데이터 필드 `_videoElement/shadowRoot`, 실제 HTMLVideoElement, root의 video 포함 관계, 공개 `video`와 실제 video의 동일성을 함께 확인해요. video 교체·분리·재부착 때 다시 읽어요.
- 스케줄 정보는 자체 데이터의 필수 타입을 확인하고 `svc`와 현재 `/live/` 또는 `/video/` 경로가 일치해야 해요. `setVideoScheduleInfo` 하나만으로 일반 객체를 광고로 승인하지 않으며 확인된 `handshakeVersion/initAd` 계약도 함께 사용해요.
- 알려진 NLiveCast 래퍼는 직접 요청보다 먼저 구분해요. 직접 요청과 비슷한 부가 필드가 생겨도 바깥 객체 전체를 차단하지 않아요.

속성 정의 시점과 setter 호출 시점을 구분해야 해요. SDK의 prototype 속성 정의는 영상이 없는 초기 시점에도 발생해요. 이때 연결 상태로 래퍼 설치 자체를 거절하면 나중의 정상 호출을 영구 누락해요. 실제 소유 판정은 호출 시점에 해요.

S 2492879 부근의 `upgrade`는 새 플레이어를 구성한 다음 기존 DOM을 교체해요. 생성 중에는 분리된 트리가 존재해요. 현재 명시적 VOD 광고 소스 할당은 P 3213718의 `upgrade`가 반환한 뒤 별도 React effect에서 실행되고, 현재 라이브 바깥 요청도 같은 순서예요. 다만 이번 정적 확인으로 모든 SDK 소비자의 setter가 항상 연결 후 호출된다고 보장할 수는 없어요. 실제 브라우저에서 분리 상태의 광고 setter 호출을 새로 관측한 것은 아니에요.

연결 전 후보가 필요할 때의 다음 지점은 광고 컨트롤러의 기존 `initAd` 최초 진입 전이에요. 네이티브 함수의 첫 소스 검사보다 먼저 현재 소스·슬롯·라우트·설정을 다시 확인한 경우에만 원래 setter의 null 경로를 사용해요. `srcObject` getter만 바꿔서는 `initAd` 내부의 `_srcObject` 직접 읽기를 막을 수 없어요. 연결이 확인되지 않았거나 다른 소스로 바뀌면 원본 호출을 통과해요. 지연 적용은 반환·예외·OFF·중복·나중 wrapper와 함께 자동 검사했으며 폴링이나 전체 DOM 검색을 추가하지 않았어요. 이미 네이티브 초기화에 진입한 소스는 재할당·연결 복구로 다시 비우지 않아요.

## 독립 일정의 소유권: 공개 SDK 정보만으로는 부족해요

S 253800 부근의 manager는 생성 인자를 비공개 `#a.videoAdScheduleProps`에 보관해요. `customParam.svc`, `adScheduleParam`, `baseElementId`도 여기에 들어가요. 공개 `getAdDisplayContainerInfo()`는 컨테이너·영상·광고 플레이어 타입을 가진 표시 객체를 반환하며 서비스·채널·방송 정체성을 반환하지 않아요. `setAdvertiseParam`은 쓰기 API이므로 읽기 판별에 호출하지 않아요.

manager 클래스 자체는 해당 SDK의 export 목록에 없어요. 팩토리 클래스는 ESM으로 export되지만 현재 치지직 페이지는 import한 생성자를 지역 변수로 사용해요. 이번 확인 범위에서 전역으로 신뢰할 수 있는 manager 생성자 참조는 찾지 못했어요. 따라서 `constructor.name`, 함수 문자열, prototype 메서드 이름, 같은 문서의 두 요소만으로 SDK·CHZZK 소유를 확정하면 안 돼요. 공개 `findAdScheduleManager(container)`도 신뢰할 수 있는 팩토리 인스턴스를 별도로 확보하지 못하면 부트스트랩 근거가 되지 못해요.

`.chzzk_player.contains(container)`를 모든 일정에 요구해도 안 돼요. P 2679500·2694100 부근에서 중간 광고 컴포넌트는 본영상 `.chzzk_player`와 형제로 렌더링돼요. P 2714902 부근의 입장 광고는 바깥 라이브 wrapper에 먼저 렌더링되며, 본영상 컴포넌트는 별도 조건을 만족해야 렌더링돼요. 입장 광고 시점에는 `.chzzk_player` 자체가 없을 수 있어요. 두 광고용 contentVideo는 본영상과 다른 요소예요.

### 정적 코드로 확인한 컴포넌트 소유 연결

| 항목               | 입장 광고                                                | 중간 광고                                                               |
| ------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------- |
| 컴포넌트 근거 위치 | P 2695224 부근                                           | P 2585628 부근                                                          |
| 입력 props         | `channelId`, `liveId`, `adParameter`, 완료/시작 callback | `channelId`, `liveId`, `adParameter`, `player`, 중간 광고 상태/callback |
| 첫 번째 hook       | 영상용 `useRef(null)`                                    | 영상용 `useRef(null)`                                                   |
| 두 번째 hook       | 광고 컨테이너용 `useRef(null)`                           | 광고 컨테이너용 `useRef(null)`                                          |
| JSX 소유           | 같은 wrapper의 `video`와 `div`에 각각 위 ref를 전달      | 같은 wrapper의 `video`와 `div`에 각각 위 ref를 전달                     |
| manager 생성       | 두 ref.current를 `contentVideo/adVideoContainer`로 전달  | 두 ref.current를 `contentVideo/adVideoContainer`로 전달                 |
| 서비스 전달        | `svc: chzzk_live` 뒤에 `adParameter`를 펼쳐 전달         | `svc: chzzk_live` 뒤에 현재 `adParameter` ref를 펼쳐 전달               |

이 관계는 ID 이름과 무관하며 현재 제한된 React 소유 검사의 근거예요. `features/autoQualityPage.js`에도 실제 host의 `__reactFiber$`에서 제한된 부모·alternate·hook 관계를 읽어 소유권을 확인하는 기존 패턴이 있어요. 광고 판별은 첫 두 hook의 정확한 두 ref 관계를 사용하며 전체 hook 목록이나 페이지를 검색하지 않아요.

현재 소유 판별은 다음 관계를 모두 요구해요. 아래의 생성 ref와 공개 정보 직접 일치 경로에 더해, 뒤에서 설명하는 공유 표시 정보 경로를 별도로 지원해요.

1. 옵션·라이브 경로·원래 manager receiver·SDK 메서드·WeakMap 등록 컨테이너와 공개 표시 객체의 동일성이 맞아요. 두 요소는 현재 문서에 연결되어 있고 같은 실제 wrapper의 직접 자식이에요.
2. 컨테이너에 붙은 자체 `__reactFiber$` 데이터 값의 `stateNode`가 해당 컨테이너예요. 영상 host의 stateNode와 같은 wrapper·ref도 함께 확인해 다른 컴포넌트의 ref 조합을 거절해요.
3. 제한된 `return` 및 필요한 `alternate` 관계 안의 하나의 컴포넌트에서 첫 두 hook의 자체 `memoizedState.current`가 각각 `info.contentVideo`, `container`와 정확히 일치해요. 서로 다른 컴포넌트의 hook을 합치지 않아요. 첫 두 ref 순서가 바뀌면 원본 통과예요.
4. 같은 컴포넌트의 자체 데이터 props에 있는 `channelId`가 현재 `/live/<channelId>`와 일치하고 `liveId`는 양수 안전 정수예요. 이름·DOM ID·함수 문자열로 컴포넌트를 식별하지 않아요.
5. `adParameter`는 service override에 영향을 줘요. 자체 `svc`가 없거나 `chzzk_live`여야 하고, 접근자·다른 서비스·불확실한 객체는 새 ID 확대 근거로 사용하지 않아요. 중간 광고의 adParameter ref는 매 렌더의 입력을 받으므로 props/ref를 임의로 오래 캐시하지 않아요.
6. 원래 load 직전에 등록 요소·공개 표시 정보·두 ref·라우트·props를 다시 확인해요. 후보가 모호하거나 정보 읽기가 실패하면 원본을 전달해요. manager가 React state에 반영되기 전 호출되므로 `useState(manager)` 일치만을 필수로 요구하지 않아요.

이것은 공개 JSX와 기존 프로젝트의 React 접근 패턴에 근거한 제한된 소유 판별이에요. 실제 Chrome의 현재 fiber 부착·alternate 상태를 이번에 관측한 것은 아니에요. 최소 모델에서 누락·접근자·다른 채널·다른 컴포넌트·ref 교체·분리·모호한 후보의 원본 통과를 확인했어요. 해당 관계를 읽을 수 없는 환경은 알려진 ID도 자동 승인하지 않아요. 기존 ID와 새 ID의 허용·거절은 서로 다른 자동 회귀로 연결했어요.

동일한 ref를 가진 owner/alternate에서 한쪽 서비스·채널·방송 정보가 잘못됐다고 그 후보만 건너뛰면 과거 정보가 현재 소유를 대신 승인할 수 있어요. 현재 판별은 같은 컴포넌트의 후보가 모순되거나 읽을 수 없으면 원본을 통과시키며, 적용 직전에도 후보 전체와 제한된 부모 연결의 현재성을 확인해요.

SDK S 256720의 `pa.delete(e)`는 manager의 `destroy()`가 생성 당시 `adVideoContainer` 등록을 삭제하는 경로예요. 관측 때의 컨테이너·manager 관계만 저장하면 이 해제를 놓쳐요. 현재 구현은 원래 등록 WeakMap과 manager를 함께 확인하고, 해당 map의 현재 값이 바뀌거나 삭제되면 독립·공유 일정 모두 원본을 통과시켜요. 다른 WeakMap에 같은 DOM 키를 쓰는 것은 이 등록을 변경하지 않아요. 기존 get을 읽어 확인할 뿐 get/delete에 전역 훅을 설치하지 않아요.

이 현재성 경계는 다음 추가 회귀로 확인해요. 네 검사는 보완 전 모두 실패했고, 보완 후 광고·등록·화질 연동 3파일 58개 검사에서 통과했어요.

- `schedule ownership rejects conflicting or unreadable alternate candidates in either order`
- `schedule ownership accepts equivalent alternates but rechecks every candidate before applying`
- `schedule registration follows its original WeakMap and ignores unrelated map writes`
- `shared display ownership expires when its original registry is deleted or replaced`

## 과거 이력 H01~H16과 검증 연결

아래 외부 이력은 과거 대응의 출처이며 이번에 과거 사이트를 재현한 결과가 아니에요. 현행 배포 코드와 연결되는 네 경로는 위에서 정적으로 다시 확인했어요. 검사명은 `tests/ad-video.test.js`의 실제 테스트명이며 광고·등록·화질 연동 3파일 58개 검사에서 모두 통과했어요. 표의 ‘완료’는 최소 네이티브 계약 모델의 완료예요. 모든 행의 이번 실제 Chrome 검증은 미실시예요.

| ID  | 시점·근거 종류·출처                                                                                                                                                                                                | 전달 경로·계약                       | 기대 동작과 보존 대상               | 실제 자동 회귀 / 관측 층                                                                                                                                                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H01 | 2024-04-03 외부 [계정 필터](https://github.com/List-KR/List-KR/commit/2062fc3357077a33cb5a115205c55faa66c7de90)                                                                                                    | 일반 계정 응답                       | `adFree`와 구독 정보 보존           | `inputs outside every supported boundary and account, waterfall, network and byte APIs stay native` / 원본 통과·API 동일성                                                                                                                                                                                                          |
| H02 | 2024-04-12 외부 [호환성 대응](https://github.com/List-KR/List-KR/commit/bf0576fa3399ed8e3063f8c35a4cad990e47d8fc)                                                                                                  | 바깥 SDK·PiP·채팅                    | 광고 내부 외의 객체·반환·예외 보존  | `source application preserves setter return identity and counts only a returned native assignment`, `schedule application preserves each native Promise, call and processing counter` / 반환·예외·호출 단위; 실제 PiP·채팅 미검증                                                                                                   |
| H03 | 2024-12-20 외부 [XHR 대응](https://github.com/List-KR/List-KR/commit/b136d10a69470bd4b0fd57aaa93d650ed108f180)                                                                                                     | `/gfp`, `/call`, `/vas` 요청         | 요청 API 보존                       | `inputs outside every supported boundary and account, waterfall, network and byte APIs stay native` / XHR·fetch 동일성, 네트워크 전송 미실행                                                                                                                                                                                        |
| H04 | 2025-05-20 외부 [fetch 대응](https://github.com/AdguardTeam/AdguardFilters/commit/7b0af220ce0e5552bc31c5d31d0614b8345971b9)                                                                                        | JSON 우회 후 SDK 도달 또는 미도달    | 확인된 광고 경계만 처리             | `JSON-bypassed inputs are handled only when they reach an owned source or schedule boundary`, `inputs outside every supported boundary and account, waterfall, network and byte APIs stay native` / 경계 도달·판별·완료 모델·미도달 통과                                                                                            |
| H05 | 2025-09-26 외부 [표시 결정](https://github.com/List-KR/List-KR/commit/9943810f995302028861eb88628935769a88be25)                                                                                                    | 명시적 표시 응답                     | 두 플래그만 변경·일반 필드 보존     | `explicit decisions accept additive fields and exact UTF-16 limits while legacy stays narrow`, `explicit ad decisions preserve unknown fields, invalid flags, and reviver behavior` / 판별·변환·상한·원본 오류                                                                                                                      |
| H06 | 2025-10~11 외부 [일정·목록 분리](https://github.com/List-KR/List-KR/commit/bdef1e65ad69c4179654fc5ab1f3a7c7adb75100)                                                                                               | SDK `adBreaks/adSources`, 원시 `ads` | 소유가 확인된 일정만 처리           | `new independent schedule IDs use native component refs instead of DOM names`, `inputs outside every supported boundary and account, waterfall, network and byte APIs stay native` / 일정 판별·원시 목록 보존                                                                                                                       |
| H07 | 2026-06-29 외부 [표시·OPTIONS 대응](https://github.com/List-KR/List-KR/commit/44bc67c18230c764a2669cb1d6cfe237db517d43)                                                                                            | 차단 감지                            | 스타일 조회·요청 API 보존           | `inputs outside every supported boundary and account, waterfall, network and byte APIs stay native` / getComputedStyle·XHR 동일성; 실제 차단 감지 미검증                                                                                                                                                                            |
| H08 | 2026-08-20~25 외부 [조사](https://github.com/uBlockOrigin/uAssets/issues/34177), [대응](https://github.com/List-KR/List-KR/commit/66a5ff7babaa9b53bca9b22146bf254c31c03bd4)                                        | 터널·암호화·별도 파서                | 암호화·바이트 API 보존              | `inputs outside every supported boundary and account, waterfall, network and byte APIs stay native`, `JSON-bypassed inputs are handled only when they reach an owned source or schedule boundary` / crypto·Uint8Array 동일성·도달 경계 구분                                                                                         |
| H09 | 2026-08-28~31 외부 [일정](https://github.com/FilteringDev/crackle/commit/94217dfc1c523ba26d97be62b787bc9f23300dc5), [VOD](https://github.com/FilteringDev/crackle/commit/74b32af42b1cf7aefc0484028594299f0af5f468) | 일정 전체와 소스 목록의 구별         | 일정 항목·순서·메타데이터 보존      | `an outer request without an inner request coexists with independent entry and mid-roll managers`, `live pre-roll and mid-roll use SDK ownership and known units independently of DOM names` / 동결 원본·항목 보존·완료 모델                                                                                                        |
| H10 | 2026-09-08 과거 응답 [기록](../ad-blocking-verification.md), 기존 `ad-seoraksan-live.json`                                                                                                                         | 구형 두 boolean                      | 정확한 구형 제한 유지               | `measured ad decision changes only the two boolean flags and preserves response metadata`, `real playback data, unmeasured shapes, errors, revivers, and unrelated routes pass through` / 과거 응답 fixture·변환·일반 재생 보존                                                                                                     |
| H11 | 2026-09-11 배포 코드 [기록](ad-decision-2026-09-11.md)                                                                                                                                                             | 표시 결정·직접 소스·glad·중간 일정   | 네이티브 준비 이전 소스 차단        | `VOD ad sources never reach preparation while main video setters remain untouched`, `native glad URI assignments are stopped before the source factory and do not affect media URLs`, `live mid-roll keeps native schedule completion with no creative preparation` / 소스 경계·준비 미호출·완료 모델                               |
| H12 | 2026-09-14 배포 코드 [기록](wrapped-live-ad-request-2026-09-14.md)                                                                                                                                                 | NLiveCast 바깥/내부 분리             | 바깥 객체 유지·내부 요청만 생략     | `wrapped sources keep outer identity with additive fields and direct-source lookalikes`, `wrapped live filtering passes through unmeasured wrappers, sources, containers and property shapes` / 부가 필드·검증된 내부 요청·원본 통과                                                                                                |
| H13 | 2026-09-19 사용자 진단+배포 코드 [기록](asian-games-playback-2026-09-19.md)                                                                                                                                        | 객체형 videoSlot                     | 실제 영상/root/getter 소유 일치     | `object video slot ownership follows native video replacement, detachment, routes and options`, `shared schedules recheck the current adapter video while entry ownership remains independent` / 어댑터·video 교체·독립 소유                                                                                                        |
| H14 | 2026-09-23 전후 배포 비교 [기록](live-pre-roll-2026-09-23.md)                                                                                                                                                      | 내부 요청 없는 래퍼+독립 입장/중간   | 래퍼 보존·두 manager 독립 처리      | `an outer request without an inner request coexists with independent entry and mid-roll managers`, `mid-roll sharing requires the observed manager and current content player ownership` / 공존·공유·별도 광고용 video·완료 모델                                                                                                    |
| H15 | 이번 계약의 합성 변형                                                                                                                                                                                              | 새 ID·추가 필드·DOM 이름 변화        | 필수 의미·현재 소유가 같으면 처리   | `new direct schedule IDs require ad APIs, matching service and connected CHZZK ownership`, `new independent schedule IDs use native component refs instead of DOM names`, `schedule ownership rejects unrelated, cross-channel, stale and accessor-based refs` / 새 ID 허용·거절·혼합 일정·입장 추정 없음                           |
| H16 | 이번 계약의 합성 변형                                                                                                                                                                                              | 메서드·필수 타입·등록 방식 변경      | 확인 불가와 경계 미도달은 원본 통과 | `unconfirmed settings and late OFF calls preserve all later wrappers and native source initialization`, `a deferred source that entered native init cannot be rearmed during or after initialization`, `replaced registrations and ambiguous component owners do not authorize schedules` / 늦은 호출·재진입 금지·wrapper·등록 교체 |

2025-03-04의 공개 규칙 삭제는 legal request로 표시된 유지보수 이력이므로 기술 변화로 포함하지 않아요. 배너·추적 전용 변화도 이번 영상 재생 경로와 구분해요.

## 공유 표시 정보와 초기화 시점의 보존

중간 광고의 공개 표시 정보는 생성 당시 두 ref와 다를 수 있어요. P 2591749~2591963은 현재 `props.player.adsController.viewSlot`으로 기존 manager를 찾고 그 공개 표시 정보를 중간 manager의 `setAdDisplayContainerInfo`에 전달한 뒤 로드해요. S 254587의 setter는 공개 정보만 교체하며 비공개 생성 props의 원래 video/container는 유지해요.

따라서 두 ref와 원래 등록 컨테이너는 컴포넌트의 실제 소유권을 확인하는 근거로 별도 유지해요. 공개 정보가 다른 경우에는 현재 `props.player → adsController → viewSlot`, 기존 WeakMap 등록 경계에서 그 키로 실제 관측한 다른 manager, 그 manager의 현재 공개 정보와 중간 manager 정보의 객체 동일성, 연결된 본영상 슬롯 소유권을 모두 확인해야 해요. 공유 정보의 `contentVideo`는 raw video 또는 어댑터일 수 있어요(S 6143115·6156500 부근). 이름이 같거나 모양만 같은 공유 객체는 허용하지 않아요. 필요한 등록 정보는 약한 참조로만 보관하며 다른 manager로 교체된 등록을 현재 정보로 다시 확인해요.

직접 소스의 지연 적용은 최초 초기화 전으로 한정해요. S 3955987의 `initAd`는 비동기이고 S 3959000~3961200의 null setter는 기존 client를 중지할 수 있어요. 지연 후보는 **해당 소스의 네이티브 initAd 최초 진입 이전**에만 처리할 수 있어요. 최초 진입 때 소유가 불명확해 원본을 통과했다면 후보는 종료해요. 초기화 중·완료 뒤·연결 복구·같은 객체 재할당으로 다시 허용하면 안 돼요. 새 소스 객체와 같은 객체 반복 설정을 구분하고 기존 반환 Promise·예외·OFF·후속 wrapper를 보존해야 해요. 이 근거는 정적 코드 계약이며 실제 Chrome 실행 결과는 아니에요.

- 공개 홈·현재 페이지·SDK 재조회 HTTP 200, 두 파일 해시가 준비 기록과 일치했어요. 최초 일반 샌드박스 요청은 소켓 접근 오류였고 네트워크가 허용된 읽기에서 확인했어요.
- 원격 코드를 실행하지 않는 로컬 텍스트 검사로 16개 계약 표식과 두 해시를 확인했어요. 첫 두 ref·manager 인자·선택적 내부 요청·null 소스·빈 소스 완료 등은 정적 근거이며 종단 간 실행 검사가 아니에요.
- 신규 fixture 파일은 만들지 않았어요. 과거 실제 응답 fixture를 유지하고 함수·DOM·React 수명은 테스트 안의 최소 합성 모델로 검사했어요. SDK 원문·HAR·개인 식별/추적 정보는 제품·테스트에 넣지 않았어요.
- 실제 테스트 결과는 경계 도달, 판별 허용/거절, 변환, 네이티브 완료 모델, 실제 본영상 진행을 나눠 기록해야 해요. 앞 단계 확인만으로 뒤 단계를 완료 처리하지 않아요.
- 실제 Chrome 검증과 새 ID의 현장 차단 효과는 미완료예요. 이 조사로 모든 미래 광고 경로·차단 감지·본영상에 합쳐진 광고 지원을 주장하지 않아요.

## 자동 검증 결과와 남은 관측

2026-09-29 최종 작업본에서 아래 명령을 순차 실행했어요. 테스트 동시 실행은 2개로 제한했고 입력은 기존 과거 응답 fixture와 최소 JSDOM 계약 모델이에요.

| 검사                                                                                                                               | 결과                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `node --test --test-concurrency=2 tests/ad-video.test.js tests/ad-video-registration.test.js tests/page-hooks-integration.test.js` | 58개 통과, 종료 코드 0                          |
| `npm.cmd run test:all -- --test-concurrency=2`                                                                                     | 1,278개 통과, 실패·취소·건너뜀 0개, 종료 코드 0 |
| `npm.cmd run lint`                                                                                                                 | 최종 오류·경고 0개, 종료 코드 0                 |
| `npm.cmd run format:check`                                                                                                         | 전체 통과, 종료 코드 0                          |
| `git diff --check`                                                                                                                 | 통과, 종료 코드 0                               |

최초 전체 lint에서 발견한 보존용 작업 사본의 검사 대상 혼입과 테스트의 미사용 변수 경고는 정식 제품·테스트 검사 범위를 유지하며 정리했어요. 이후 현재 소유 정보 충돌과 실제 등록 삭제를 재현한 네 검사를 추가하고 실행 코드를 보완한 뒤, 관련 58개와 전체 1,278개 검사를 다시 통과했어요. 최종 lint·포맷·diff 결과는 위 표와 같아요. H01~H16의 실제 테스트명과 로컬 근거 링크도 모두 연결됨을 확인했어요.

이 결과는 지원 경계 도달·판별·변환·네이티브 완료 모델까지예요. 실제 Chrome에서는 확장 재로드·광고 배정, ON/OFF, 라이브 입장·중간·VOD, SPA·영상 교체, PiP·화질·일시정지·다른 차단기 조합과 본영상 시간 진행이 아직 미검증이에요. 사용자 재요청 전에는 브라우저·컴퓨터 제어를 사용하지 않았어요. 실제 화면과 본영상 진행을 확인하기 전에는 릴리스 준비 완료나 현장 차단 성공으로 보고하지 않아요.

## 후속 실제 Chrome 확인

위의 미검증 표기는 구현 직후 정적·자동 검사 단계의 상태예요. 같은 날 23:24~23:42 KST에 사용자의 명시적인 요청으로 실제 Chrome을 확인했어요. 두 라이브에서 입장 일정 처리 뒤 본영상 진행, 두 VOD에서 새 문서의 소스 처리 뒤 본영상 진행, 라이브 간 이동·일시정지·VOD 정지 중 탐색 및 ON/OFF·ON 복원을 확인했어요. 처리 카운터를 광고 배정 수나 차단율로 해석하지 않았어요.

VOD 간 화면 이동의 빈 플레이어와 720p 선택 후 1080p 유지 현상은 원인 미확정으로 남겼어요. 실제 중간 광고 배정·표시되지 않는 PiP·새 ID 현장 사례·다른 차단기 조합은 확인하지 않았어요. 이전 자동 검사를 실제 브라우저의 전체 통과로 승격하거나 릴리스 준비 완료로 보고하지 않아요.
