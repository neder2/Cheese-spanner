# 다시보기 채팅 타임스탬프 실측 — 2026-09-16

## 대상과 근거

- 화면: <https://chzzk.naver.com/video/15210930>
- 현재 페이지가 로드한 치지직 코드: <https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-GNyFfAPg.js>
- 응답: <https://api.chzzk.naver.com/service/v1/videos/15210930/chats?playerMessageTime=60000&previousVideoChatSize=50>
- 브라우저 도구로 다시보기 페이지의 채팅이 로드된 상태에서 DOM을 읽었다. 코드와 API는 공개 응답을 조회했으며 확장에 다운로드·실행 코드를 추가하지 않았다.

## 확인한 구조

- 채팅 영역은 `aside#vod-aside [role='log']`이며, 관측된 클래스는 `_content_189hq_63`, `_list_189hq_70`, `_item_189hq_85`다.
- 일반 메시지는 `_container_w9pvh_1 > _chatting_message_w9pvh_21` 안에 `_nickname_w9pvh_33` 버튼(`aria-haspopup="true"`)과 `_text_w9pvh_1` 본문을 둔다. 런타임은 CSS 모듈 해시를 고정하지 않는다.
- 현재 치지직 코드의 다시보기 일반 메시지 렌더링은 행 `div`의 단일 자식 컴포넌트에 `chatMessage`를 전달한다. 따라서 기존 MAIN-world 브리지의 `children.props.chatMessage.time` 읽기 계약을 재사용한다.
- 다시보기 응답을 메시지로 변환할 때 `messageTime`은 `time`으로, `playerMessageTime`은 동명 필드로 전달된다. 작성 시각은 전자이며 재생 위치와 구분한다.
- API 응답 코드 200, 이전 메시지 50개와 이후 메시지 200개를 확인했다. 예시 수치만 보존하고 닉네임·본문·사용자 식별자는 보존하지 않았다.

| messageTime   | playerMessageTime | messageTypeCode |
| ------------- | ----------------- | --------------- |
| 1789450718032 | 24032             | 1               |
| 1789450718892 | 24892             | 1               |
| 1789450754114 | 60114             | 1               |
| 1789450754626 | 60626             | 1               |

## 구현 범위와 검증

- `vodChatTimestampEnabled`는 기본 꺼짐인 독립 옵션이다. 기존 라이브 저장 키는 유지한다.
- 라이브와 같은 현지 `HH:MM` 형식과 시맨틱 색상 CSS를 사용한다. 유효한 서버 작성 시각이 없는 메시지에 현재 시각이나 영상 경과 시간을 대신 표시하지 않는다.
- 관측한 다시보기 DOM·props 구조를 테스트 fixture로 보존하고, 옵션 즉시 반영, 새 행만 처리, 행 재사용, 잘못된 시각 정리, 채팅 DOM 재마운트와 SPA 이동을 검증한다.
- 관련 테스트 26개와 전체 `npm.cmd run test:all` 797개가 통과했다. `npm.cmd run lint`, `npm.cmd run format:check`, `git diff --check`도 통과했다.
- 실제 `options.html`·JS·CSS를 로컬 HTTP에서 열어 360×700 화면의 라이트·다크 모드를 확인했다. 새 문구와 토글이 겹치지 않고 가로 넘침이 없으며, Tab으로 다시보기 옵션에 진입해 Space로 변경할 수 있었다. 이 확인은 설정 화면의 배치·키보드 동작 검증이며 실제 확장 저장·주입 검증과 구분한다.
- 브라우저 도구의 읽기 전용 DOM 컨텍스트에서는 React expando를 직접 확인할 수 없어 위 props 연결은 현재 배포 코드로 확인했다.
- 브라우저 도구가 `chrome://extensions/` 접근을 보안 정책으로 차단했다. 확장 재로드와 실제 업데이트 코드 주입 확인은 수행하지 못했다.
- 직접 확인 절차: 확장 관리에서 치즈 스패너를 다시 로드하고 다시보기 탭을 새로고침한 뒤, **채팅 도구 → 채팅 표시 → 다시보기 채팅 타임스탬프 표시**를 켜고 **옵션 저장**을 누른다. 닉네임 왼쪽의 작성 시각, 재생 위치 이동 후 표시, 끄고 저장할 때 즉시 제거, 라이트·다크 모드와 라이브 옵션의 독립 동작을 확인한다.
