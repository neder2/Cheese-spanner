# 라이브 입장 광고 20회 실측 — 2026-11-08

## 결과

설치된 일반 Chrome **156.0.8078.81**에서 일반 라이브 두 곳에 각각 10회, 총 **20회 새 문서로 입장**했어요. 16:42:06~16:47:35 KST 동안 진행했고 회차별 최소 15초, 합계 304.34초를 관찰했어요. 광고 영상 재생과 광고 안내 UI는 **0/20회**, 입장 광고 일정 처리와 1080p 본방송 진행은 **20/20회**였어요.

그 뒤 같은 Chrome·시험 프로필·일반 방송 주소에서 동영상 광고 차단을 끄고 등록 해제를 확인한 별도 비교 1회를 실행했어요. 길이 30.037초의 실제 720p 광고가 약 0.0055→14.3253초 진행했고 같은 관측 코드가 이를 잡았어요. 이 비교는 ON 20회에 포함하지 않아요. 이번 조건에서 사용자 신고의 간헐적 누락은 재현하지 못했으며, 모든 광고·환경에서 문제가 없다는 판정은 아니에요.

## 환경과 준비

- 요청: 사용자가 Chrome에서 입장 광고가 간헐적으로 나온다고 설명하며 20회 측정을 요청했어요. 신고 방송 주소는 제공되지 않아 앞서 본방송 진행을 확인한 두 일반 라이브를 사용했어요.
- 브라우저: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, 실제 연결의 `browser.version()`도 **156.0.8078.81**이에요. 창을 표시한 상태로 수행했고 소리만 실행 옵션으로 음소거했어요.
- 프로필: 별도 새 비로그인 프로필이에요. 사용자 Chrome의 기존 프로필·설정·확장·로그인 상태는 변경하지 않았어요. 다른 광고 차단 확장은 넣지 않았어요.
- 코드: branch `1.4.7`, HEAD `4bef5e0a22a70461a945df4eb4140bb24379cc07`와 당시 미커밋 변경을 포함한 런타임을 임시 폴더에 복사해 고정했어요. 실행 중 원본이 바뀌어 측정 코드가 섞이지 않게 했고, 광고·등록·설정 관련 6개 파일은 종료 때 원본과 SHA-256이 같았어요. manifest·package의 실제 버전은 **1.4.6**이며 바꾸지 않았어요.
- 주입: 별도 시험 브라우저에서 공식 Chrome 개발자 프로토콜의 `Extensions.loadUnpacked`로 스냅샷을 로드했어요. 확장 ID `epikijncjcjchiflbjkanabbfkpbahdb`, 저장 옵션 `adVideoEnabled:true`, `betterchzzk-ad-video`의 MAIN/document_start 등록과 페이지 확장 ID·상태 마커를 대조했어요. 사용자 브라우저의 확장 관리 설정을 조작하지 않았어요.
- 사이트: 마지막 비교 문서가 로드한 공개 진입 번들은 `index-BcgE118t.js`였어요.
- 초기 비교: 먼저 시작한 Chrome for Testing 155.0.8059.12 측정은 설치된 Chrome과 버전이 달라 완료 17회 뒤 중단했어요. 그다음 진행 중이던 회차는 완료 자료로 세지 않았어요. 이 자료를 아래 일반 Chrome 20회와 합치지 않아요. [초기 비교 상태](../../output/playwright/ad-entry-20-2026-11-08/environment.json)에 구분했어요.

## 측정 방법

1. 쌍베와 브이챠의 일반 `/live/{channelId}` 주소를 번갈아 새 문서로 열었어요. 같은 프로필을 유지해 첫 로드와 이후 캐시가 있는 로드를 포함했고, 쿠키·캐시를 매회 지우지 않았어요. `/simple`, 채팅 팝업, 라이브 간 SPA 이동을 20회에 섞지 않았어요.
2. 문서 시작 때 읽기 전용 관측을 설치해 설정·진단 속성 변경과 video의 `loadeddata`·`playing`·`error` 이벤트를 기록했어요. 네트워크 응답이나 플레이어 함수·스케줄·재생 위치는 관측 코드로 바꾸지 않았어요.
3. 약 200ms마다 광고 wrapper·광고 UI·video의 소유 위치, 표시 상태, 준비 상태, 일시정지 여부, 영상 크기와 현재 시간을 읽었어요. 실제 표본은 **1481개**, 표본 간격 중앙값 **206ms**, 최대 **681ms**였어요. 표본 사이의 짧은 재생도 확인할 수 있도록 재생 이벤트를 별도로 보관했어요.
4. `#preAdPlayerWrapper`, `#midAdPlayerWrapper`, IMA/GV 광고 컨테이너 또는 네이티브 광고 구간의 표시된 video가 실제 재생하면 광고 노출로 분류해요. 로딩용 빈 광고 wrapper만 생긴 것은 광고 영상 재생으로 세지 않았어요. `광고 페이지 보기`·`초 후 재생`·`SKIP` 문구도 별도로 검사했어요.
5. 매회 최소 15초 관찰하고, 끝부분에서 같은 본영상의 시간이 1초 이상 전진하는지 확인했어요. 차단 상태·현재 확장 ID·처리 횟수도 매회 확인했어요. 광고와 본방송 모두 확인되지 않는 경우는 최대 30초까지 관찰하도록 했지만 이번 ON 20회에는 해당하지 않았어요.
6. 회차별 전체 표본·이벤트·진단 변화와 마지막 화면을 저장했어요. 광고를 발견한 비교 시험에서는 광고가 재생되는 순간의 화면도 따로 저장했어요. 관측 중 SKIP·채팅·후원 버튼을 누르지 않았어요.

## 회차별 결과

`입장 일정`은 `blockedLivePreRollSchedules`예요. 1회는 검증된 입장 일정의 광고 소스가 비워진 호출 1회를 뜻하며, 서버가 실제 배정한 소재 수나 성공률을 의미하지 않아요. `본방송 시작`은 문서 시작 후 표시된 본영상의 재생을 처음 표본에서 확인한 시점이에요.

| 회차 | 방송   | 광고 영상 | 입장 일정 | 본방송 시작 | 종료 구간 진행 | 마지막 본영상 | 근거                                                                                                                                                                 |
| ---- | ------ | --------- | --------- | ----------- | -------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | 쌍베   | 관측 없음 | 1회       | 4.113초     | +2.892초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-01.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-01-final.png) |
| 2    | 브이챠 | 관측 없음 | 1회       | 1.905초     | +2.877초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-02.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-02-final.png) |
| 3    | 쌍베   | 관측 없음 | 1회       | 1.977초     | +2.878초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-03.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-03-final.png) |
| 4    | 브이챠 | 관측 없음 | 1회       | 1.564초     | +2.897초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-04.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-04-final.png) |
| 5    | 쌍베   | 관측 없음 | 1회       | 1.567초     | +2.965초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-05.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-05-final.png) |
| 6    | 브이챠 | 관측 없음 | 1회       | 1.406초     | +2.886초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-06.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-06-final.png) |
| 7    | 쌍베   | 관측 없음 | 1회       | 1.407초     | +2.870초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-07.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-07-final.png) |
| 8    | 브이챠 | 관측 없음 | 1회       | 1.597초     | +2.896초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-08.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-08-final.png) |
| 9    | 쌍베   | 관측 없음 | 1회       | 1.383초     | +2.886초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-09.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-09-final.png) |
| 10   | 브이챠 | 관측 없음 | 1회       | 1.814초     | +2.877초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-10.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-10-final.png) |
| 11   | 쌍베   | 관측 없음 | 1회       | 1.578초     | +2.873초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-11.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-11-final.png) |
| 12   | 브이챠 | 관측 없음 | 1회       | 2.275초     | +2.879초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-12.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-12-final.png) |
| 13   | 쌍베   | 관측 없음 | 1회       | 1.567초     | +2.881초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-13.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-13-final.png) |
| 14   | 브이챠 | 관측 없음 | 1회       | 1.372초     | +2.882초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-14.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-14-final.png) |
| 15   | 쌍베   | 관측 없음 | 1회       | 1.352초     | +2.894초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-15.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-15-final.png) |
| 16   | 브이챠 | 관측 없음 | 1회       | 1.608초     | +2.885초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-16.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-16-final.png) |
| 17   | 쌍베   | 관측 없음 | 1회       | 1.571초     | +2.878초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-17.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-17-final.png) |
| 18   | 브이챠 | 관측 없음 | 1회       | 1.375초     | +2.890초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-18.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-18-final.png) |
| 19   | 쌍베   | 관측 없음 | 1회       | 1.367초     | +2.898초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-19.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-19-final.png) |
| 20   | 브이챠 | 관측 없음 | 1회       | 1.554초     | +2.877초       | 1080p·재생 중 | [기록](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-20.json) · [화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-20-final.png) |

- 모든 회차의 최종 상태는 `active:true`, `reloadRequired:false`였어요. 입장 일정 처리 전 활성화를 확인했고, 첫 활성화는 문서 시작 후 28~234ms, 입장 일정 처리는 444~2301ms였어요.
- 광고 UI 표본과 광고 video의 재생 이벤트는 0건, 탐색 오류와 페이지 예외도 0건이었어요. 광고 코드의 6개 카운터 중 이번 ON 입장에서는 일정·입장 일정만 각각 1회였어요. JSON 변환 카운터가 0이라는 이유로 광고 코드가 실행되지 않았다고 해석하지 않아요.
- 본방송 첫 재생 표본은 1.352~4.113초, 중앙값 1.567초였어요. 화면이 재생 중인 것에 더해 마지막 약 3초 구간의 시간 전진을 매회 확인했어요.

## 차단 OFF 비교

- 주소: [쌍베 일반 라이브](https://chzzk.naver.com/live/dcd75ef0f2c664e3270de18696ad43bf).
- 저장값 `adVideoEnabled:false`와 동적 등록 빈 배열을 확인한 뒤 새 문서로 입장했어요.
- 광고 영상 재생을 70개 표본에서 확인했어요. 길이 30.037초, 1280×720 광고가 약 0.0055→14.3253초 진행했고 `15초 후 SKIP`·`광고 페이지 보기` 안내도 관측했어요. 이 길이나 해상도를 차단 판별 조건으로 사용한 것은 아니에요.
- [비교 원자료](../../output/playwright/ad-entry-20-chrome156-2026-11-08/control-off.json) · [실제 광고 화면](../../output/playwright/ad-entry-20-chrome156-2026-11-08/trial-control-off-ad.png).
- 시험 프로필의 ON 저장값과 MAIN/document_start 등록을 복원한 다음 만든 시험 브라우저만 닫았어요. [종료 환경](../../output/playwright/ad-entry-20-chrome156-2026-11-08/final-environment.json)에 복원 결과가 있어요.

## 판정과 남은 범위

확인한 일반 Chrome·비로그인·동일 코드·두 일반 라이브의 새 문서 입장 20회에서는 간헐적 광고 노출이 재현되지 않았어요. ON 20회 모두 입장 일정 처리와 본방송 진행을 확인했고, OFF 비교에서는 실제 광고를 같은 방법으로 감지했어요. 이것을 사용자 로그인 프로필, 다른 차단기와의 조합, 오래 열어 둔 문서·SPA 이동·모든 방송·실제 중간 광고의 보장으로 확대하지 않아요.

앞서 확인한 `/simple` 경로 누락은 별도 문제로 남아 있어요. 이번 요청은 일반 Chrome 반복 측정이므로 실행 코드를 수정하지 않았고, `/simple` 보완을 사용자 신고의 원인 해결로 보고하지 않아요. 일반 주소에서 다시 노출될 때는 그 문서의 실제 확장 ID·저장 옵션·`active/reloadRequired`·처리 횟수와 재생 중인 광고 wrapper를 함께 확인해야 다음 원인을 구분할 수 있어요.

실행 코드 변경이 없어 단위 테스트·전체 lint는 반복하지 않았어요. 이 기록과 `docs/tracking/findings.md`의 포맷·추가 문구·근거 링크를 확인했어요. 사용자 데이터나 기존 변경을 되돌리지 않았고 커밋·push·버전·릴리스 작업은 하지 않았어요.

[환경·소스 해시](../../output/playwright/ad-entry-20-chrome156-2026-11-08/environment.json) · [집계](../../output/playwright/ad-entry-20-chrome156-2026-11-08/aggregate.json) · [회차 요약](../../output/playwright/ad-entry-20-chrome156-2026-11-08/summary.json)
