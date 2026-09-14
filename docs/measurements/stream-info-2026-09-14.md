# 스트림 정보 측정과 구현 범위

- 측정일: 2026-09-14 (KST)
- 대상: https://chzzk.naver.com/live/feb20a676694b1163fed010da0848303
- DOM: 메인 영상은 `video.webplayer-internal-video`, 플레이어는 `.pzp-pc`이며 computed position은 relative였다. 오른쪽 컨트롤은 `.pzp-pc__bottom-buttons-right`였다.
- 현재 영상의 DOM 미디어 속성에서 1920×1080, currentTime 1302.619179, seekable 끝 1306.494525833334를 확인했다. 이 두 시점의 차이는 촬영 시점부터의 종단 지연을 의미하지 않는다.
- API: `https://api.chzzk.naver.com/service/v3/channels/feb20a676694b1163fed010da0848303/live-detail`
- `content.livePlaybackJson`의 `media[].encodingTrack[]`에서 `videoWidth`, `videoHeight`, `videoBitRate`, `videoFrameRate`, `audioBitRate`를 확인했다. 1080p는 1920×1080 / videoBitRate 8192000, 720p는 1280×720 / 3000000이었다. 런타임에는 수치를 하드코딩하지 않는다.
- 같은 해상도에 여러 media 항목이 존재한다. 동일 해상도의 유효 비트레이트가 하나로 일치할 때만 표시하며 서로 다른 값은 선택하지 않는다. 실제 다운로드 속도나 순간 비트레이트로 표시하지 않는다.
- 브라우저 DOM 읽기 결과에서는 디코딩 바이트 카운터와 playback quality 메서드 결과를 얻지 못했다. 프레임 통계는 런타임에서 표준 `getVideoPlaybackQuality` 지원을 확인하고, 미지원이면 측정 불가로 표시한다.
- 다른 확장이 삽입한 `cheese-stream-stats-button`이 이미 있었다. 이를 수정하거나 데이터 공급원으로 사용하지 않고 Better Chzzk 전용 ID와 접근 가능한 이름을 사용했다.

## 검증 범위

페이드 타이밍 후속 실측(2026-09-14, 같은 라이브 URL): 네이티브 재생/PIP/설정/전체화면 버튼은 `.pzp-button`의 `opacity 0.2s ease-in`을 사용했다. 스트림 정보와 멀티뷰는 별도 `opacity .2s`로 ease를 사용했고, 스킵 pill은 120ms ease로 덮어썼다. 해당 override를 제거해 네이티브 CSS의 duration/timing-function 및 focus/active 상태별 전환을 그대로 받도록 했다. 네이티브 볼륨 wrapper와 컴프레서 wrapper는 둘 다 `opacity 0.2s ease`로 이미 동일하여 수정하지 않았다. 스킵·빨리 감기는 복사한 네이티브 클래스가 페이드를 소유하는 경로에서 computed opacity 임계값 복제를 중단했다. inline opacity를 고정하면 controls가 켜진 직후의 전환 시작값 0을 다음 동기화까지 붙잡을 수 있기 때문이다. DOM remount 등 기존 정리 경계는 유지한다.

버튼 숨김 후속 실측(2026-09-14, 같은 라이브 URL): `.pzp-pc--controls`가 없는 재생 상태에서 확장 버튼은 opacity 1이었다. 현재 치지직 CSS는 `.pzp-pc__setting-button`에 기본 opacity 0, `.pzp-pc.pzp-pc--controls` 아래에서는 opacity 1과 0.2초 전환을 적용한다. 확장 버튼은 일반 버튼 클래스만 갖고 있어 개별 숨김 대상에서 빠져 있었다. 별도 타이머나 observer 없이 전용 ID에 동일한 컨트롤 상태 기반 CSS를 적용하고, 숨겨진 버튼의 포인터 입력도 막았다. 키보드 focus-visible에서는 접근할 수 있도록 표시한다. 기본 버튼의 `.pzp-ui-icon`/`.pzp-ui-icon__svg` 구조와 36×36 viewBox를 사용한 자체 SVG로 문자 아이콘을 교체했다. JSDOM에서 라이트·다크 루트 각각 컨트롤 표시·숨김·dialog 상태를 검증했다. 수정 후 실제 확장 주입과 시각 검증은 기존 확장 관리 탭 접근 제한으로 미완료다.

후속 UI 변경: 누적 드롭 행을 제거하고 영상 비트레이트를 bps/1000으로 변환해 kbps로 표시한다(8192000 → 8,192 kbps). FPS 계산에서 드롭된 프레임을 빼는 기존 방식은 유지한다. 프레임 행 이름은 FPS로 줄였다.

하드웨어 가속은 WebGL 렌더러 기반 추정으로 개선했다. [치즈 플래터 src/audioMixer.js](https://github.com/lirpa62/Chzzk-Platter/blob/main/src/audioMixer.js)의 getGpuAccelInfo/gpuAccelLabel은 WEBGL_debug_renderer_info의 렌더러 이름에서 소프트웨어 렌더러를 구분한다. 로컬 Downloads의 `치지직 allinone 확장프로그램 (1.5.1 버전).zip`을 실행·설치하지 않고 읽었으며, popup.js는 failIfMajorPerformanceCaveat 옵션과 SwiftShader/llvmpipe 이름으로 켜짐(H/W)·꺼짐(S/W)을 표시한다. assets/content.ts.js에도 동일한 경고 판별이 있다.

API 사용 방식을 참고하고 프로젝트 수명주기에 맞게 별도 구현했다. 패널을 열 때만 한 번 조회하고 finally에서 WEBGL_lose_context로 정리한다. WebGL 미지원, 정보 제한, 빈 렌더러, 오류는 꺼짐으로 단정하지 않고 확인 불가로 표시한다. GPU로 추정되는 렌더러는 사용 중, 알려진 소프트웨어 렌더러는 미사용 (소프트웨어)로 표시한다. 이름은 저장하거나 전송하지 않는다. 영상 디코더의 실제 가속 여부나 Chrome 설정값 자체를 읽은 것은 아니며 UI에도 WebGL 기준임을 설명한다. 신규 권한·원격 실행 코드는 없다.

JSDOM 테스트로 패널이 닫힌 동안 측정·조회가 없는지, 통계 계산과 해상도 변경, 충돌하는 비트레이트 처리, API 실패, 취소 후 늦은 응답, 화면 이동, 컨트롤 재마운트, 옵션 비활성화, 탭 숨김과 pagehide/pageshow 정리를 검증한다. 재생 위치나 일시정지 상태는 변경하지 않는다.

Chrome 브라우저 도구가 확장 관리 탭 접근을 차단했다. 우회하지 않았으며 실제 확장 재로드·주입, 라이브/VOD에서 패널 표시, 라이트·다크 테마, 전체화면·좁은 화면과 옵션 팝업의 시각 검증은 미완료다. 직접 확장을 다시 로드하고 치지직 탭을 새로고침한 뒤, 하단 오른쪽 ⓘ 버튼 및 설정의 스트림 정보 버튼 토글을 확인해야 한다.
