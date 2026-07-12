# Third-Party Notices

Better Chzzk에는 아래 오픈소스 프로젝트에서 파생된 코드가 포함되어 있습니다.

## hls.js

- 출처: https://github.com/video-dev/hls.js
- 버전: 1.6.16
- 라이선스: Apache License 2.0 (Copyright (c) 2017 Dailymotion)
- 사용 범위: `vendor/hls.light.min.js` — 팔로잉·방송 목록의 확장 소유 라이브 미리보기 재생
- 원본 LICENSE 및 추가 저작권 고지: [`vendor/hls.js.LICENSE`](vendor/hls.js.LICENSE)

## cheese-knife

- 출처: https://github.com/jebibot/cheese-knife
- 라이선스: MIT License (Copyright (c) 2023- jebibot)
- 사용 범위:
    - `features/volumeTooltip.js`의 오디오 컴프레서 — 버튼 UI 구성, 아이콘 SVG,
      Web Audio 그래프(DynamicsCompressor + Gain) 구성이 cheese-knife의 구현에서
      파생되었으며 Better Chzzk에 맞게 수정되었습니다.
    - `features/chatTimestampPage.js`의 채팅 시각 추출 — DOM 행의 React props에서
      `chatMessage.time`을 읽는 방식이 cheese-knife의 구현을 참고해 작성되었습니다.

### MIT License

MIT License

Copyright (c) 2023- jebibot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
