/** 운영자 패널의 DOM, 닉네임 필터, 선택·스크롤과 노출 기반 읽음 판정을 소유한다.
 * isolated world. 의존: chatTools.parser, utils.normSpace / injectStyleOnce.
 * createPanel은 수집 기록을 render로 받고 onRead / onNavigate로 사용자 동작을 전달한다.
 * 원본 채팅 binding과 수집 상태를 수정하지 않으며 remove에서 observer·RAF·listener를 해제한다.
 */
(() => {
    "use strict";
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const namespace = (root.chatTools = root.chatTools || {});
    const { normSpace, injectStyleOnce } = root.utils;
    const {
        MODERATOR_HIGHLIGHT_ATTR,
        MODERATOR_HIGHLIGHT_COLOR,
        MODERATOR_BOX_ATTR,
        MODERATOR_TRIGGER_ATTR,
        MODERATOR_ACTION_GROUP_ATTR,
        CHAT_TIMESTAMP_VALUE_RE,
        isOwnUi,
        getAttr,
        getClassText,
        getVisibleText,
        roleLabel,
        resolveMutationElement,
    } = namespace.parser;
    const STYLE_ID = "betterchzzk-chat-tools-style";

    const MODERATOR_ROW_ATTR = "data-bcct-moderator-row";

    const MODERATOR_PANEL_HOST_ATTR = "data-bcct-moderator-panel-host";

    const MODERATOR_TITLE = "방송자/채팅 운영자 채팅";

    const CHAT_TITLE_RE = /chat|\uCC44\uD305/i;

    const CHAT_INPUT_RE = /input|textarea|editor|composer|write|\uC785\uB825/i;

    const PINNED_NOTICE_RE = /pin|pinned|fixed|sticky|notice|announcement|announce|\uACE0\uC815|\uACF5\uC9C0/i;

    const STYLE_TEXT = `
[${MODERATOR_HIGHLIGHT_ATTR}="1"]{
  --bcct-highlight-tint:color-mix(in srgb, var(${MODERATOR_HIGHLIGHT_COLOR}, currentColor) 85%, #000);
  background-color:color-mix(in srgb, var(--bcct-highlight-tint) 10%, transparent)!important;
  border-radius:4px;
  box-shadow:0 0 0 1px color-mix(in srgb, var(--bcct-highlight-tint) 32%, transparent);
}
/* 2026-09-05 치지직의 루트 theme_dark 클래스·data-theme 기준. 본문색과 행 크기는 유지한다. */
html:is(.theme_dark, [data-theme="theme_dark"]) [${MODERATOR_HIGHLIGHT_ATTR}="1"]{
  --bcct-highlight-tint:color-mix(in srgb, var(${MODERATOR_HIGHLIGHT_COLOR}, currentColor) 85%, #fff);
  background-color:color-mix(in srgb, var(--bcct-highlight-tint) 12%, transparent)!important;
  box-shadow:0 0 0 1px color-mix(in srgb, var(--bcct-highlight-tint) 40%, transparent);
}
[data-bcct-blind-masked="1"]{
  display:none!important;
}
.bcct-blind-reveal{
  color:inherit;
  font:inherit;
  opacity:.72;
  text-decoration:line-through;
  word-break:break-word;
}
.bcct-blind-reveal:hover{
  opacity:1;
  text-decoration:none;
}
.bcct-moderator-panel-host{
  position:relative!important;
}
.bcct-moderator-trigger{
  position:relative;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:0 0 auto;
  width:30px;
  height:30px;
  margin:0 2px 0 0;
  padding:0;
  border:0;
  border-radius:8px;
  background:transparent;
  color:#69737f;
  cursor:pointer;
  font:inherit;
  transition:background-color .12s ease,color .12s ease;
}
.bcct-moderator-trigger:hover,
.bcct-moderator-trigger[aria-expanded="true"]{
  background:rgba(0,0,0,0.05);
  color:#00c471;
}
.bcct-moderator-trigger svg{
  width:19px;
  height:19px;
  display:block;
  pointer-events:none;
}
.bcct-moderator-trigger[data-bcct-popup="1"]{
  position:absolute;
  left:8px;
  right:auto;
  top:50%;
  margin:0;
  transform:translateY(-50%);
}
.bcct-moderator-box[data-bcct-popup="1"]{
  left:8px;
  right:auto;
}
.bcct-moderator-trigger__count{
  position:absolute;
  top:0;
  right:0;
  display:flex;
  align-items:center;
  justify-content:center;
  min-width:13px;
  height:13px;
  padding:0 3px;
  border:2px solid #fff;
  border-radius:999px;
  background:#00c471;
  color:#fff;
  font-size:9px;
  font-weight:800;
  line-height:1;
  box-sizing:border-box;
}
.bcct-moderator-trigger__count[data-empty="1"]{
  display:none;
}
.bcct-moderator-trigger[data-unread="1"]{
  background:rgba(0,196,113,.14);
  color:#00a86b;
  box-shadow:inset 0 0 0 1px rgba(0,196,113,.4);
}
.bcct-moderator-actions{
  display:inline-flex!important;
  align-items:center!important;
  justify-content:center!important;
  gap:0!important;
  flex:0 0 auto!important;
  height:36px!important;
  align-self:center!important;
  margin-left:auto;
  line-height:0!important;
  transform:translateY(2px);
}
.bcct-moderator-actions > button{
  display:inline-flex!important;
  align-items:center!important;
  justify-content:center!important;
  align-self:center!important;
  margin-top:0!important;
  margin-bottom:0!important;
}
.bcct-moderator-box{
  display:flex;
  flex-direction:column;
  position:absolute;
  top:42px;
  right:8px;
  z-index:2147483646;
  width:min(344px, calc(100vw - 24px));
  max-height:min(420px, calc(100vh - 120px));
  border:1px solid rgba(0,0,0,0.1);
  border-radius:8px;
  background:#fff;
  color:#151619;
  box-shadow:0 10px 28px rgba(15,18,22,0.14);
  font-family:inherit;
  overflow:hidden;
}
.bcct-moderator-box[data-open="0"]{
  display:none;
}
.bcct-moderator-box__header{
  flex:none;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  border:0;
  padding:10px 12px;
  border-bottom:1px solid #eef1f4;
  background:#fff;
  font:inherit;
  font-size:14px;
  font-weight:700;
}
.bcct-moderator-box__heading{
  display:flex;
  align-items:center;
  gap:5px;
  min-width:0;
}
.bcct-moderator-box__title{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.bcct-moderator-box__count{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  min-width:18px;
  height:18px;
  padding:0 6px;
  border-radius:999px;
  background:#e9fff5;
  color:#00a86b;
  font-size:12px;
  font-weight:800;
  line-height:1;
  box-sizing:border-box;
}
.bcct-moderator-box__close{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  width:28px;
  height:28px;
  flex:0 0 auto;
  border:0;
  border-radius:8px;
  background:transparent;
  color:#8a94a1;
  cursor:pointer;
  font-size:16px;
  font-weight:600;
  line-height:1;
  padding:0;
  transition:background-color .12s ease,color .12s ease;
}
.bcct-moderator-box__close:hover{
  background:#f1f3f5;
  color:#151619;
}
.bcct-moderator-box__list{
  display:flex;
  flex-direction:column;
  max-height:276px;
  overflow:auto;
  overscroll-behavior:contain;
  min-height:0;
}
.bcct-moderator-authors{
  display:flex;
  flex:none;
  flex-wrap:wrap;
  gap:6px;
  max-height:84px;
  overflow:auto;
  padding:8px 12px;
  border-bottom:1px solid rgba(128,128,128,.2);
}
.bcct-moderator-author,
.bcct-moderator-bottom{
  border:1px solid rgba(128,128,128,.35);
  border-radius:6px;
  background:transparent;
  color:inherit;
  font:inherit;
  font-size:12px;
  cursor:pointer;
  padding:4px 7px;
}
.bcct-moderator-author{
  display:inline-flex;
  align-items:center;
  gap:5px;
  max-width:100%;
}
.bcct-moderator-bottom{
  display:inline-flex;
  align-items:center;
  justify-content:center;
  flex:none;
  width:28px;
  height:28px;
  padding:0;
}
.bcct-moderator-bottom svg{
  width:16px;
  height:16px;
  pointer-events:none;
}
.bcct-moderator-author__name{
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
}
.bcct-moderator-author[aria-pressed="true"]{
  background:rgba(0,196,113,.16);
  border-color:#00a86b;
}
.bcct-moderator-author__unread{
  flex:none;
  padding:0 4px;
  border-radius:4px;
  background:rgba(0,196,113,.18);
  font-weight:700;
}
.bcct-moderator-summary{
  display:flex;
  flex:none;
  align-items:center;
  justify-content:space-between;
  gap:6px;
  padding:6px 12px;
  font-size:12px;
  min-height:28px;
}
.bcct-moderator-bottom[hidden],
.bcct-moderator-row[hidden],
.bcct-moderator-author__unread[hidden]{
  display:none!important;
}
.bcct-moderator-row{
  display:block;
  width:100%;
  border:0;
  border-bottom:1px solid #f1f3f5;
  background:transparent;
  color:inherit;
  cursor:text;
  flex:none;
  box-sizing:border-box;
  -webkit-user-select:text;
  user-select:text;
  font:inherit;
  padding:7px 12px;
  text-align:left;
  transition:background-color .12s ease;
}
.bcct-moderator-row:hover{
  background:#f4fbf8;
}
.bcct-moderator-row[data-unread="1"]{
  box-shadow:inset 3px 0 #00a86b;
}
.bcct-moderator-row:focus-visible,
.bcct-moderator-author:focus-visible,
.bcct-moderator-bottom:focus-visible{
  outline:2px solid #00a86b;
  outline-offset:-2px;
}
.bcct-moderator-row:last-child{
  border-bottom:0;
}
.bcct-moderator-row__meta{
  display:inline;
  margin-right:6px;
  color:#00a86b;
  font-size:12px;
  font-weight:700;
  line-height:18px;
}
.bcct-moderator-row__time{
  display:inline;
  margin-right:4px;
  color:var(--sem-color-content-neutral-cool-base,var(--Content-Neutral-Cool-Base,#9da5b6));
  font-size:12px;
  font-weight:400;
  font-variant-numeric:tabular-nums;
  line-height:18px;
  white-space:nowrap;
}
.bcct-moderator-row__badge{
  display:inline-block;
  width:18px;
  height:18px;
  margin-right:4px;
  vertical-align:-4px;
}
.bcct-moderator-row__text{
  display:inline;
  color:#25282d;
  font-size:13px;
  line-height:18px;
  white-space:normal;
  word-break:break-word;
}
.bcct-moderator-box__empty{
  padding:18px 12px;
  color:#8a94a1;
  font-size:12px;
  line-height:18px;
  text-align:center;
}
@media (max-width:420px){
  .bcct-moderator-box{
    right:4px;
    width:calc(100vw - 16px);
  }
}
html[dark] .bcct-moderator-box,
body[theme="dark"] .bcct-moderator-box,
[class*="dark"] .bcct-moderator-box{
  border-color:rgba(255,255,255,0.14);
  background:#1f2125;
  color:#f1f3f5;
}
html[dark] .bcct-moderator-trigger,
body[theme="dark"] .bcct-moderator-trigger,
[class*="dark"] .bcct-moderator-trigger{
  color:#c9cdd3;
}
html[dark] .bcct-moderator-trigger:hover,
html[dark] .bcct-moderator-trigger[aria-expanded="true"],
body[theme="dark"] .bcct-moderator-trigger:hover,
body[theme="dark"] .bcct-moderator-trigger[aria-expanded="true"],
[class*="dark"] .bcct-moderator-trigger:hover,
[class*="dark"] .bcct-moderator-trigger[aria-expanded="true"]{
  background:rgba(255,255,255,0.1);
  color:#00c471;
}
html[dark] .bcct-moderator-trigger__count,
body[theme="dark"] .bcct-moderator-trigger__count,
[class*="dark"] .bcct-moderator-trigger__count{
  border-color:#1f2125;
}
html[dark] .bcct-moderator-box__header,
body[theme="dark"] .bcct-moderator-box__header,
[class*="dark"] .bcct-moderator-box__header{
  border-bottom-color:rgba(255,255,255,0.1);
  background:#1f2125;
}
html[dark] .bcct-moderator-box__count,
body[theme="dark"] .bcct-moderator-box__count,
[class*="dark"] .bcct-moderator-box__count{
  background:rgba(0,196,113,0.15);
  color:#00c471;
}
html[dark] .bcct-moderator-box__close,
body[theme="dark"] .bcct-moderator-box__close,
[class*="dark"] .bcct-moderator-box__close{
  color:#c9cdd3;
}
html[dark] .bcct-moderator-box__close:hover,
body[theme="dark"] .bcct-moderator-box__close:hover,
[class*="dark"] .bcct-moderator-box__close:hover{
  background:rgba(255,255,255,0.09);
  color:#f1f3f5;
}
html[dark] .bcct-moderator-row,
body[theme="dark"] .bcct-moderator-row,
[class*="dark"] .bcct-moderator-row{
  border-bottom-color:rgba(255,255,255,0.08);
}
html[dark] .bcct-moderator-row:hover,
body[theme="dark"] .bcct-moderator-row:hover,
[class*="dark"] .bcct-moderator-row:hover{
  background:rgba(0,196,113,0.12);
}
html[dark] .bcct-moderator-row__text,
body[theme="dark"] .bcct-moderator-row__text,
[class*="dark"] .bcct-moderator-row__text{
  color:#f1f3f5;
}
html[dark] .bcct-moderator-box__empty,
body[theme="dark"] .bcct-moderator-box__empty,
[class*="dark"] .bcct-moderator-box__empty{
  color:#9aa3ad;
}
`;

    namespace.createPanel = function createPanel({ onNavigate, onRead, onRequestSync }) {
        let chatRoot = null;
        let moderatorMessages = [];
        let showChatTimestamp = false;
        let moderatorBox = null;
        let moderatorList = null;
        let moderatorCount = null;
        let moderatorToggle = null;
        let moderatorTriggerCount = null;
        let moderatorAuthors = null;
        let moderatorSummary = null;
        let moderatorBottomButton = null;
        let moderatorAuthorFilter = "";
        let moderatorReadFrame = null;
        let moderatorResizeObserver = null;
        let moderatorActivityRenderKey = "";
        const moderatorRenderedRows = new Map();
        let moderatorPanelHost = null;
        let moderatorHeader = null;
        let moderatorMenuButton = null;
        let moderatorMenuButtonConfirmed = false;
        let moderatorAnchorObserver = null;
        let moderatorAnchorRoot = null;
        let moderatorAnchorDirty = false;
        let moderatorPanelOpen = false;

        function getModeratorRenderKey(message) {
            const badgeKey = (Array.isArray(message.badges) ? message.badges : [])
                .map((badge) => `${badge?.src}|${badge?.alt}`)
                .join(",");
            const timestamp = isChatTimestampEnabled() ? message.timestamp : "";
            return [message.id, message.role, message.author, message.text, badgeKey, message.authorColor, timestamp]
                .map((value) => String(value || ""))
                .join("\u001f");
        }

        function buildModeratorRow(message) {
            const row = document.createElement("div");
            row.setAttribute("role", "button");
            row.tabIndex = 0;
            row.className = "bcct-moderator-row";
            row.setAttribute(MODERATOR_ROW_ATTR, message.id);
            row.title = "클릭하면 원본 채팅으로 이동 · 드래그해서 복사";

            const meta = document.createElement("span");
            meta.className = "bcct-moderator-row__meta";

            const author = document.createElement("span");
            author.className = "bcct-moderator-row__author";
            author.textContent = message.author || roleLabel(message.role);
            const authorColor = normSpace(message.authorColor || "");
            if (authorColor) author.style.color = authorColor;

            // 치지직 본 채팅창처럼 그 행에 있던 뱃지 아이콘(역할/구독/후원 등)을
            // 순서대로 붙이고, 뱃지가 하나도 없을 때만 역할 라벨 텍스트로 표시한다.
            const badges = (Array.isArray(message.badges) ? message.badges : []).filter((badge) =>
                /^https:\/\//.test(normSpace(badge?.src))
            );
            if (badges.length) {
                for (const badge of badges.slice(0, 8)) {
                    const icon = document.createElement("img");
                    icon.className = "bcct-moderator-row__badge";
                    icon.src = normSpace(badge.src);
                    icon.alt = normSpace(badge.alt) || roleLabel(message.role);
                    icon.width = 18;
                    icon.height = 18;
                    icon.draggable = false;
                    meta.appendChild(icon);
                }
                meta.appendChild(author);
            } else if (message.author) {
                meta.append(`${roleLabel(message.role)} · `, author);
            } else {
                meta.textContent = roleLabel(message.role);
            }

            const text = document.createElement("span");
            text.className = "bcct-moderator-row__text";
            text.textContent = message.text;

            if (isChatTimestampEnabled() && CHAT_TIMESTAMP_VALUE_RE.test(message.timestamp || "")) {
                const timestamp = document.createElement("span");
                timestamp.className = "bcct-moderator-row__time";
                timestamp.textContent = message.timestamp;
                row.appendChild(timestamp);
            }
            row.append(meta, " ", text);
            row.addEventListener("click", () => {
                if (!hasModeratorTextSelection()) onNavigate(message.id, message.recordId);
            });
            row.addEventListener("keydown", (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                onNavigate(message.id, message.recordId);
            });
            return row;
        }

        function hasModeratorTextSelection() {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !moderatorList) return false;
            for (let index = 0; index < selection.rangeCount; index += 1) {
                if (selection.getRangeAt(index).intersectsNode(moderatorList)) return true;
            }
            return false;
        }

        function getModeratorAuthorKey(message) {
            // 현재 DOM에서 확인한 닉네임으로만 묶는다. 이름 없는 행을 같은 사용자로 추정하지 않는다.
            return message.author ? `name:${message.author}` : `message:${message.id}`;
        }

        function getModeratorActors() {
            const actors = new Map();
            for (const message of moderatorMessages) {
                const key = getModeratorAuthorKey(message);
                let actor = actors.get(key);
                if (!actor) {
                    actor = { name: message.author || roleLabel(message.role), total: 0, unread: 0 };
                    actors.set(key, actor);
                }
                actor.total += 1;
                if (message.unread) actor.unread += 1;
            }
            return actors;
        }

        function syncModeratorText(element, text) {
            if (element && element.textContent !== text) element.textContent = text;
        }

        function renderModeratorActivity(actors = getModeratorActors()) {
            if (!moderatorAuthors || !moderatorToggle) return;
            const renderKey = JSON.stringify([
                moderatorAuthorFilter,
                moderatorMessages.map((message) => [message.id, message.author, message.role, message.unread]),
            ]);
            if (moderatorActivityRenderKey === renderKey) return;
            moderatorActivityRenderKey = renderKey;
            const unread = moderatorMessages.filter((message) => message.unread).length;
            syncModeratorText(moderatorCount, `${moderatorMessages.length}`);
            syncModeratorText(moderatorTriggerCount, `${unread}`);
            moderatorTriggerCount.dataset.empty = unread ? "0" : "1";
            moderatorToggle.dataset.unread = unread ? "1" : "0";
            const entries = new Map([["", { name: "전체", total: moderatorMessages.length, unread }], ...actors]);
            const buttons = new Map(
                Array.from(moderatorAuthors.children, (button) => [button.dataset.authorKey, button])
            );
            for (const [key, button] of buttons) {
                if (!entries.has(key)) button.remove();
            }
            for (const [key, actor] of entries) {
                let button = buttons.get(key);
                if (!button) {
                    button = document.createElement("button");
                    button.type = "button";
                    button.className = "bcct-moderator-author";
                    button.dataset.authorKey = key;
                    const name = document.createElement("span");
                    name.className = "bcct-moderator-author__name";
                    const badge = document.createElement("span");
                    badge.className = "bcct-moderator-author__unread";
                    badge.setAttribute("aria-hidden", "true");
                    button.append(name, badge);
                    button.addEventListener("click", () => {
                        moderatorAuthorFilter = key;
                        renderModeratorList();
                        scrollModeratorListToBottom();
                        scheduleModeratorReadCheck();
                    });
                    moderatorAuthors.appendChild(button);
                }
                syncModeratorText(button.firstElementChild, actor.name);
                syncModeratorText(button.lastElementChild, `새 ${actor.unread}`);
                if (button.lastElementChild.hidden !== !actor.unread) button.lastElementChild.hidden = !actor.unread;
                const pressed = String(moderatorAuthorFilter === key);
                if (button.getAttribute("aria-pressed") !== pressed) button.setAttribute("aria-pressed", pressed);
                const label = `${actor.name}, 보관 ${actor.total}개, 미확인 ${actor.unread}개`;
                if (button.getAttribute("aria-label") !== label) button.setAttribute("aria-label", label);
                if (button.title !== label) button.title = label;
            }
            const visibleUnread = moderatorMessages.filter(
                (message) =>
                    message.unread &&
                    (!moderatorAuthorFilter || getModeratorAuthorKey(message) === moderatorAuthorFilter)
            ).length;
            syncModeratorText(moderatorSummary, visibleUnread ? `미확인 채팅 ${visibleUnread}개` : "새 채팅 없음");
            for (const { row, message } of moderatorRenderedRows.values()) {
                const value = message.unread ? "1" : "0";
                if (row.dataset.unread !== value) row.dataset.unread = value;
            }
            setModeratorPanelOpen(moderatorPanelOpen);
        }

        function scheduleModeratorReadCheck() {
            if (!moderatorPanelOpen || !moderatorList || moderatorReadFrame !== null) return;
            moderatorReadFrame = requestAnimationFrame(markVisibleModeratorMessagesRead);
        }

        function onModeratorAncestorScroll(event) {
            // 목록 밖의 스크롤로 패널이 화면 안에 들어와도 읽음 위치를 다시 확인한다.
            // 원본 채팅 목록처럼 패널을 포함하지 않는 스크롤은 수집 목록을 검사하지 않는다.
            if (moderatorPanelOpen && event.target instanceof Node && event.target.contains(moderatorList)) {
                scheduleModeratorReadCheck();
            }
        }

        function markVisibleModeratorMessagesRead() {
            moderatorReadFrame = null;
            if (!moderatorPanelOpen || !moderatorList?.isConnected || document.visibilityState === "hidden") return;
            syncModeratorBottomButton();
            const bounds = moderatorList.getBoundingClientRect();
            const top = Math.max(0, bounds.top);
            const bottom = Math.min(window.innerHeight, bounds.bottom);
            const left = Math.max(0, bounds.left);
            const right = Math.min(window.innerWidth, bounds.right);
            if (bottom <= top || right <= left) return;
            const readIds = [];
            for (const { row, message } of moderatorRenderedRows.values()) {
                if (!message.unread || row.hidden) continue;
                const rect = row.getBoundingClientRect();
                if (rect.height <= 0 || rect.right <= left || rect.left >= right) continue;
                const visibleHeight = Math.min(bottom, rect.bottom) - Math.max(top, rect.top);
                // 긴 메시지는 목록 높이를 기준으로, 그 외에는 행의 절반 이상이 보여야 확인 처리한다.
                if (visibleHeight < Math.min(rect.height, bottom - top) / 2) continue;
                readIds.push(message.id);
            }
            if (readIds.length) onRead(readIds);
        }

        function syncModeratorBottomButton() {
            if (!moderatorBottomButton || !moderatorList) return;
            const hidden = !moderatorPanelOpen || moderatorList.clientHeight <= 0 || isModeratorListNearBottom(2);
            if (moderatorBottomButton.hidden !== hidden) moderatorBottomButton.hidden = hidden;
        }

        function updateModeratorRowAppearance(row, message) {
            // 백필은 본문/닉네임 텍스트 노드를 교체하지 않아 드래그 선택을 유지한다.
            const fresh = buildModeratorRow(message);
            const author = row.querySelector(".bcct-moderator-row__author");
            if (author && message.authorColor) author.style.color = message.authorColor;
            const meta = row.querySelector(".bcct-moderator-row__meta");
            if (meta && !meta.querySelector("img") && fresh.querySelector(".bcct-moderator-row__badge")) {
                for (const node of Array.from(meta.childNodes)) {
                    if (node.nodeType === Node.TEXT_NODE) node.remove();
                }
                for (const badge of fresh.querySelectorAll(".bcct-moderator-row__badge")) {
                    meta.insertBefore(badge, author?.parentNode === meta ? author : null);
                }
            }
            const nextTime = fresh.querySelector(".bcct-moderator-row__time");
            const time = row.querySelector(".bcct-moderator-row__time");
            if (time && nextTime) syncModeratorText(time, nextTime.textContent);
            else if (nextTime) row.prepend(nextTime);
            else time?.remove();
        }

        function renderModeratorList() {
            if (!moderatorList || !moderatorCount || !moderatorTriggerCount) return;
            const actors = getModeratorActors();
            if (moderatorAuthorFilter && !actors.has(moderatorAuthorFilter)) moderatorAuthorFilter = "";
            const stickToBottom = moderatorPanelOpen && !hasModeratorTextSelection() && isModeratorListNearBottom();
            // 같은 네이티브 ID로 다시 만들어진 수집 기록도 별도 행이다. 외형 백필은
            // 같은 기록에서만 반영해 본문 선택을 보존하고, 교체된 기록은 새 DOM을 만든다.
            const nextMessages = new Set(moderatorMessages.map((message) => message.recordId));
            for (const [id, entry] of moderatorRenderedRows) {
                if (nextMessages.has(entry.message.recordId)) continue;
                entry.row.remove();
                moderatorRenderedRows.delete(id);
            }
            let changed = false;
            for (const message of moderatorMessages) {
                const key = getModeratorRenderKey(message);
                let entry = moderatorRenderedRows.get(message.id);
                if (!entry) {
                    entry = { row: buildModeratorRow(message), message, key };
                    moderatorRenderedRows.set(message.id, entry);
                    moderatorList.appendChild(entry.row);
                    changed = true;
                } else if (entry.key !== key) {
                    updateModeratorRowAppearance(entry.row, message);
                    entry.key = key;
                }
                entry.message = message;
                const hidden = Boolean(
                    moderatorAuthorFilter && getModeratorAuthorKey(message) !== moderatorAuthorFilter
                );
                if (entry.row.hidden !== hidden) {
                    entry.row.hidden = hidden;
                    changed = true;
                }
            }
            let empty = moderatorList.querySelector(".bcct-moderator-box__empty");
            if (!moderatorMessages.length && !empty) {
                empty = document.createElement("div");
                empty.className = "bcct-moderator-box__empty";
                empty.textContent = "아직 수집된 메시지가 없습니다.";
                moderatorList.appendChild(empty);
            } else if (moderatorMessages.length) empty?.remove();
            renderModeratorActivity(actors);
            if (changed && stickToBottom) scrollModeratorListToBottom();
            scheduleModeratorReadCheck();
        }

        function isModeratorListNearBottom(threshold = 40) {
            if (!moderatorList) return false;
            const distance = moderatorList.scrollHeight - moderatorList.scrollTop - moderatorList.clientHeight;
            return distance <= threshold;
        }

        function scrollModeratorListToBottom() {
            if (!moderatorList) return;
            moderatorList.scrollTop = moderatorList.scrollHeight;
            syncModeratorBottomButton();
            scheduleModeratorReadCheck();
        }

        function setModeratorPanelOpen(open) {
            const wasOpen = moderatorPanelOpen;
            moderatorPanelOpen = open;
            if (!moderatorBox || !moderatorToggle) return;
            const openValue = open ? "1" : "0";
            const expandedValue = open ? "true" : "false";
            const unread = moderatorMessages.filter((message) => message.unread).length;
            const label = `${MODERATOR_TITLE} ${moderatorMessages.length}개, 미확인 ${unread}개 ${open ? "닫기" : "열기"}`;
            if (moderatorBox.dataset.open !== openValue) moderatorBox.dataset.open = openValue;
            if (moderatorToggle.getAttribute("aria-expanded") !== expandedValue) {
                moderatorToggle.setAttribute("aria-expanded", expandedValue);
            }
            if (moderatorToggle.getAttribute("aria-label") !== label) moderatorToggle.setAttribute("aria-label", label);
            // 패널이 새로 열릴 때(닫힘→열림)만 최신 메시지가 보이도록 맨 아래로 내린다.
            // display:none 인 동안에는 scrollHeight 가 0 이라 dataset.open="1" 로 표시된
            // 뒤에 실행해야 한다.
            if (open && !wasOpen) scrollModeratorListToBottom();
            if (open && !wasOpen) scheduleModeratorReadCheck();
            syncModeratorBottomButton();
            if (!open && moderatorReadFrame !== null) {
                cancelAnimationFrame(moderatorReadFrame);
                moderatorReadFrame = null;
            }
        }

        function removeModeratorBox() {
            if (moderatorReadFrame !== null) cancelAnimationFrame(moderatorReadFrame);
            moderatorReadFrame = null;
            moderatorResizeObserver?.disconnect();
            moderatorResizeObserver = null;
            document.removeEventListener("scroll", onModeratorAncestorScroll, true);
            moderatorActivityRenderKey = "";
            document.removeEventListener("visibilitychange", scheduleModeratorReadCheck);
            window.removeEventListener("resize", scheduleModeratorReadCheck);
            if (moderatorAnchorObserver) {
                moderatorAnchorObserver.disconnect();
                moderatorAnchorObserver = null;
            }
            moderatorAnchorRoot = null;
            moderatorAnchorDirty = false;
            document.removeEventListener("keydown", onModeratorDocumentKeydown, true);
            const actionGroup = moderatorToggle?.closest?.(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
            if (moderatorBox) {
                moderatorBox.remove();
                moderatorBox = null;
                moderatorList = null;
                moderatorCount = null;
            }
            moderatorRenderedRows.clear();
            moderatorAuthors = null;
            moderatorSummary = null;
            moderatorBottomButton = null;
            if (moderatorToggle) {
                moderatorToggle.remove();
                moderatorToggle = null;
                moderatorTriggerCount = null;
            }
            if (actionGroup?.parentElement) {
                while (actionGroup.firstChild) {
                    actionGroup.parentElement.insertBefore(actionGroup.firstChild, actionGroup);
                }
                actionGroup.remove();
            }
            for (const host of Array.from(document.querySelectorAll(`[${MODERATOR_PANEL_HOST_ATTR}]`))) {
                host.removeAttribute(MODERATOR_PANEL_HOST_ATTR);
            }
            moderatorPanelHost = null;
            moderatorHeader = null;
            moderatorMenuButton = null;
            moderatorMenuButtonConfirmed = false;
        }

        function onModeratorDocumentKeydown(event) {
            if (event.key === "Escape" && moderatorPanelOpen) {
                setModeratorPanelOpen(false);
            }
        }

        function createModeratorIcon() {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2");
            svg.setAttribute("stroke-linecap", "round");
            svg.setAttribute("stroke-linejoin", "round");
            svg.setAttribute("aria-hidden", "true");

            const bubble = document.createElementNS("http://www.w3.org/2000/svg", "path");
            bubble.setAttribute(
                "d",
                "M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.6-.8L3 20l1.1-4.1A8.1 8.1 0 0 1 3 11.5 8.6 8.6 0 0 1 12 3a8.6 8.6 0 0 1 9 8.5Z"
            );

            const line1 = document.createElementNS("http://www.w3.org/2000/svg", "path");
            line1.setAttribute("d", "M8 10h8");

            const line2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
            line2.setAttribute("d", "M8 14h5");

            svg.append(bubble, line1, line2);
            return svg;
        }

        function buttonText(button) {
            return normSpace(
                [
                    getAttr(button, "aria-label"),
                    getAttr(button, "title"),
                    getAttr(button, "data-testid"),
                    getClassText(button),
                    getVisibleText(button),
                ].join(" ")
            );
        }

        function hasMenuButtonSignal(button) {
            if (!(button instanceof HTMLButtonElement)) return false;
            const text = buttonText(button);
            if (/더보기|메뉴|설정|more|menu|option|setting|ellipsis/i.test(text)) return true;
            return /^[\s⋮⋯…·•・]+$/.test(getVisibleText(button));
        }

        function isMenuButton(button) {
            return button instanceof HTMLButtonElement && !isOwnUi(button) && hasMenuButtonSignal(button);
        }

        function findChatPanelRoot(rootEl) {
            const nativePanel = rootEl.closest("aside#aside-chatting");
            if (nativePanel) return nativePanel;
            let current = rootEl.parentElement || rootEl;
            for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
                if (!(current instanceof Element) || current === document.body) break;
                const marker = `${getClassText(current)} ${getAttr(current, "role")} ${getAttr(current, "aria-label")}`;
                if (/chat|chatting|채팅|live_chatting/i.test(marker)) return current;
            }
            return rootEl.parentElement || rootEl;
        }

        function isPinnedNoticeElement(element) {
            let current = element;
            for (let depth = 0; current instanceof Element && depth < 4; depth += 1, current = current.parentElement) {
                const marker = [
                    getClassText(current),
                    getAttr(current, "role"),
                    getAttr(current, "aria-label"),
                    getAttr(current, "title"),
                    getAttr(current, "data-testid"),
                ].join(" ");
                if (PINNED_NOTICE_RE.test(marker)) return true;
            }
            return false;
        }

        function isChatInputElement(element) {
            let current = element;
            for (let depth = 0; current instanceof Element && depth < 4; depth += 1, current = current.parentElement) {
                const marker = [
                    getClassText(current),
                    getAttr(current, "role"),
                    getAttr(current, "aria-label"),
                    getAttr(current, "title"),
                    getAttr(current, "data-testid"),
                ].join(" ");
                if (CHAT_INPUT_RE.test(marker)) return true;
            }
            return false;
        }

        function isChatHeaderCandidate(candidate, rootEl) {
            return (
                candidate instanceof Element &&
                !candidate.contains(rootEl) &&
                !isOwnUi(candidate) &&
                !isPinnedNoticeElement(candidate) &&
                !isChatInputElement(candidate)
            );
        }

        function findChatHeader(rootEl) {
            const panelRoot = findChatPanelRoot(rootEl);
            const candidates = [
                ...Array.from(
                    panelRoot.querySelectorAll(
                        "header,[class*='header'],[class*='Header'],[class*='toolbar'],[class*='Toolbar']"
                    )
                ),
                ...Array.from(panelRoot.children || []),
            ];

            for (const candidate of candidates) {
                if (!isChatHeaderCandidate(candidate, rootEl)) continue;
                const text = getVisibleText(candidate);
                const buttons = Array.from(candidate.querySelectorAll("button"));
                if (CHAT_TITLE_RE.test(text) && buttons.some(isMenuButton)) return candidate;
            }

            for (const candidate of candidates) {
                if (
                    !(candidate instanceof Element) ||
                    candidate.contains(rootEl) ||
                    isOwnUi(candidate) ||
                    isPinnedNoticeElement(candidate) ||
                    isChatInputElement(candidate)
                ) {
                    continue;
                }
                const text = getVisibleText(candidate);
                const buttons = Array.from(candidate.querySelectorAll("button"));
                if ((/채팅|chat/i.test(text) || buttons.some(isMenuButton)) && buttons.length) return candidate;
            }

            const menuButton = Array.from(panelRoot.querySelectorAll("button")).find(
                (button) => isMenuButton(button) && !isPinnedNoticeElement(button) && !isChatInputElement(button)
            );
            return menuButton?.parentElement || panelRoot;
        }

        function findMenuButton(header) {
            const buttons = Array.from(header?.querySelectorAll?.("button") || []).filter(
                (button) => !isOwnUi(button) && !isPinnedNoticeElement(button) && !isChatInputElement(button)
            );
            return buttons.find(isMenuButton) || buttons[buttons.length - 1] || null;
        }

        function isChatPopup() {
            // 2026-09-08: the standalone chat header reserves its right side for scale controls.
            return /^\/live\/[a-f0-9]{32}\/chat\/?$/.test(location.pathname);
        }

        function ensureModeratorActionGroup(menuButton, header) {
            if (!(menuButton instanceof HTMLButtonElement)) return null;
            const existing = menuButton.closest(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
            if (existing instanceof Element) return existing;

            const group = document.createElement("span");
            group.className = "bcct-moderator-actions";
            group.setAttribute(MODERATOR_ACTION_GROUP_ATTR, "1");

            const parent = menuButton.parentElement || header;
            parent.insertBefore(group, menuButton);
            group.appendChild(menuButton);
            return group;
        }

        function isPotentialModeratorAnchorNode(node, rootEl) {
            const element = resolveMutationElement(node);
            if (!(element instanceof Element) || element === rootEl || rootEl.contains(element)) return false;
            if (moderatorMenuButton && (element === moderatorMenuButton || element.contains(moderatorMenuButton))) {
                return true;
            }
            if (element.closest(`[${MODERATOR_BOX_ATTR}], [${MODERATOR_TRIGGER_ATTR}]`)) return false;
            if (isPinnedNoticeElement(element) || isChatInputElement(element)) return false;
            if (element.matches("header,[class*='header'],[class*='Header'],[class*='toolbar'],[class*='Toolbar']")) {
                return true;
            }

            const buttons = [
                ...(element instanceof HTMLButtonElement ? [element] : []),
                ...Array.from(element.querySelectorAll("button")),
            ];
            return buttons.some(
                (button) =>
                    button !== moderatorToggle &&
                    hasMenuButtonSignal(button) &&
                    !isPinnedNoticeElement(button) &&
                    !isChatInputElement(button)
            );
        }

        function observeProvisionalModeratorAnchor(host, rootEl, menuButtonConfirmed) {
            if (moderatorAnchorObserver) moderatorAnchorObserver.disconnect();
            moderatorAnchorObserver = null;
            moderatorAnchorRoot = null;
            moderatorAnchorDirty = false;
            if (menuButtonConfirmed || !(host instanceof Element) || !(rootEl instanceof Element)) return;

            const observedHost = host;
            const observedRoot = rootEl;
            moderatorAnchorRoot = rootEl;
            moderatorAnchorObserver = new MutationObserver((mutations) => {
                if (moderatorPanelHost !== observedHost || chatRoot !== observedRoot) return;
                const anchorChanged = mutations.some((mutation) => {
                    const target = resolveMutationElement(mutation.target);
                    if (!(target instanceof Element)) return false;
                    if (target.closest(`[${MODERATOR_BOX_ATTR}], [${MODERATOR_TRIGGER_ATTR}], .bcct-blind-reveal`)) {
                        return false;
                    }
                    if (target === observedRoot || observedRoot.contains(target)) return false;
                    if (
                        moderatorMenuButton &&
                        (target === moderatorMenuButton || moderatorMenuButton.contains(target))
                    ) {
                        return true;
                    }
                    return [...Array.from(mutation.addedNodes), ...Array.from(mutation.removedNodes)].some((node) =>
                        isPotentialModeratorAnchorNode(node, observedRoot)
                    );
                });
                if (!anchorChanged) return;
                moderatorAnchorDirty = true;
                onRequestSync();
            });
            moderatorAnchorObserver.observe(host, { childList: true, subtree: true });
        }

        function isModeratorUiMountedForRoot(rootEl) {
            if (
                !moderatorBox?.isConnected ||
                !moderatorList?.isConnected ||
                !moderatorCount?.isConnected ||
                !moderatorToggle?.isConnected ||
                !moderatorTriggerCount?.isConnected ||
                !moderatorPanelHost?.isConnected ||
                !moderatorHeader?.isConnected
            ) {
                return false;
            }

            const hostOwnsRoot =
                moderatorPanelHost === rootEl ||
                moderatorPanelHost.contains(rootEl) ||
                rootEl.contains(moderatorPanelHost);
            if (
                !hostOwnsRoot ||
                moderatorBox.parentElement !== moderatorPanelHost ||
                !moderatorPanelHost.contains(moderatorHeader)
            ) {
                return false;
            }

            let placementValid = false;
            const popup = isChatPopup();
            if (moderatorToggle.hasAttribute("data-bcct-popup") !== popup) return false;
            if (popup || !moderatorMenuButton) {
                placementValid =
                    moderatorToggle.parentElement === moderatorHeader &&
                    (!moderatorMenuButton || moderatorHeader.contains(moderatorMenuButton));
            } else {
                const actionGroup = moderatorToggle.closest(`[${MODERATOR_ACTION_GROUP_ATTR}]`);
                placementValid = Boolean(
                    moderatorMenuButton.isConnected &&
                    actionGroup?.isConnected &&
                    actionGroup.parentElement &&
                    moderatorHeader.contains(actionGroup) &&
                    moderatorMenuButton.parentElement === actionGroup &&
                    moderatorToggle.nextElementSibling === moderatorMenuButton
                );
            }
            if (!placementValid) return false;

            if (!moderatorMenuButtonConfirmed) {
                if (moderatorAnchorRoot !== rootEl) {
                    observeProvisionalModeratorAnchor(moderatorPanelHost, rootEl, false);
                    moderatorAnchorDirty = true;
                }
                return !moderatorAnchorDirty;
            }
            return true;
        }

        function ensureModeratorBox(rootEl) {
            chatRoot = rootEl;
            if (!(rootEl instanceof Element)) {
                removeModeratorBox();
                return;
            }

            if (isModeratorUiMountedForRoot(rootEl)) {
                renderModeratorList();
                return;
            }
            if (moderatorBox || moderatorToggle) removeModeratorBox();

            const panelRoot = findChatPanelRoot(rootEl);
            const header = findChatHeader(rootEl);
            const menuButton = findMenuButton(header);
            const menuButtonConfirmed = Boolean(menuButton && isMenuButton(menuButton));
            const host = panelRoot instanceof Element ? panelRoot : rootEl.parentElement || rootEl;
            host.setAttribute(MODERATOR_PANEL_HOST_ATTR, "1");

            if (!moderatorToggle?.isConnected) {
                const trigger = document.createElement("button");
                trigger.type = "button";
                trigger.className = "bcct-moderator-trigger";
                trigger.setAttribute(MODERATOR_TRIGGER_ATTR, "1");
                trigger.appendChild(createModeratorIcon());

                const count = document.createElement("span");
                count.className = "bcct-moderator-trigger__count";
                count.dataset.empty = "1";
                trigger.appendChild(count);

                trigger.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setModeratorPanelOpen(!moderatorPanelOpen);
                });

                moderatorToggle = trigger;
                moderatorTriggerCount = count;
            }

            const popup = isChatPopup();
            if (popup) moderatorToggle.setAttribute("data-bcct-popup", "1");
            const actionGroup = popup ? null : ensureModeratorActionGroup(menuButton, header);
            if (actionGroup && moderatorToggle.nextElementSibling !== menuButton) {
                actionGroup.insertBefore(moderatorToggle, menuButton);
            } else if (!moderatorToggle.isConnected) {
                header.appendChild(moderatorToggle);
            }

            if (moderatorBox?.isConnected) {
                renderModeratorList();
                return;
            }

            const box = document.createElement("section");
            box.className = "bcct-moderator-box";
            if (popup) box.setAttribute("data-bcct-popup", "1");
            box.setAttribute(MODERATOR_BOX_ATTR, "1");
            box.setAttribute("aria-label", MODERATOR_TITLE);
            box.dataset.open = "0";

            const headerRow = document.createElement("div");
            headerRow.className = "bcct-moderator-box__header";
            const title = document.createElement("span");
            title.className = "bcct-moderator-box__title";
            title.textContent = MODERATOR_TITLE;

            const count = document.createElement("span");
            count.className = "bcct-moderator-box__count";
            count.textContent = "0";

            const titleWrap = document.createElement("span");
            titleWrap.className = "bcct-moderator-box__heading";
            titleWrap.append(title, " ", count);

            const close = document.createElement("button");
            close.type = "button";
            close.className = "bcct-moderator-box__close";
            close.setAttribute("aria-label", `${MODERATOR_TITLE} 닫기`);
            close.textContent = "×";
            close.addEventListener("click", () => setModeratorPanelOpen(false));

            headerRow.append(titleWrap, close);

            const list = document.createElement("div");
            list.className = "bcct-moderator-box__list";
            list.addEventListener("scroll", scheduleModeratorReadCheck, { passive: true });
            list.addEventListener("focusin", scheduleModeratorReadCheck);

            const authors = document.createElement("div");
            authors.className = "bcct-moderator-authors";
            authors.setAttribute("role", "group");
            authors.setAttribute("aria-label", "식별된 사용자별 채팅 보기");
            const summaryRow = document.createElement("div");
            summaryRow.className = "bcct-moderator-summary";
            const summary = document.createElement("span");
            summary.setAttribute("role", "status");
            const bottomButton = document.createElement("button");
            bottomButton.type = "button";
            bottomButton.className = "bcct-moderator-bottom";
            bottomButton.setAttribute("aria-label", "맨 아래로");
            bottomButton.title = "맨 아래로";
            const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            chevron.setAttribute("viewBox", "0 0 24 24");
            chevron.setAttribute("fill", "none");
            chevron.setAttribute("stroke", "currentColor");
            chevron.setAttribute("stroke-width", "2");
            chevron.setAttribute("stroke-linecap", "round");
            chevron.setAttribute("stroke-linejoin", "round");
            chevron.setAttribute("aria-hidden", "true");
            const chevronPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
            chevronPath.setAttribute("d", "M6 9l6 6 6-6");
            chevron.appendChild(chevronPath);
            bottomButton.appendChild(chevron);
            bottomButton.hidden = true;
            bottomButton.addEventListener("click", scrollModeratorListToBottom);
            summaryRow.append(summary, bottomButton);

            box.append(headerRow, authors, summaryRow, list);
            host.appendChild(box);

            moderatorBox = box;
            moderatorList = list;
            moderatorCount = count;
            moderatorAuthors = authors;
            moderatorSummary = summary;
            moderatorBottomButton = bottomButton;
            moderatorPanelHost = host;
            moderatorHeader = header;
            moderatorMenuButton = menuButton;
            moderatorMenuButtonConfirmed = menuButtonConfirmed;
            document.addEventListener("keydown", onModeratorDocumentKeydown, true);
            document.addEventListener("visibilitychange", scheduleModeratorReadCheck);
            document.addEventListener("scroll", onModeratorAncestorScroll, { capture: true, passive: true });
            window.addEventListener("resize", scheduleModeratorReadCheck);
            if (typeof ResizeObserver === "function") {
                moderatorResizeObserver = new ResizeObserver(scheduleModeratorReadCheck);
                moderatorResizeObserver.observe(list);
            }
            setModeratorPanelOpen(moderatorPanelOpen);
            renderModeratorList();
            observeProvisionalModeratorAnchor(host, rootEl, menuButtonConfirmed);
        }

        function render(messages) {
            moderatorMessages = messages;
            renderModeratorList();
        }

        function configure({ showTimestamp }) {
            showChatTimestamp = showTimestamp === true;
            renderModeratorList();
        }

        function reset() {
            moderatorAuthorFilter = "";
            render([]);
        }

        function isChatTimestampEnabled() {
            return showChatTimestamp;
        }

        return {
            mount: ensureModeratorBox,
            remove: removeModeratorBox,
            render,
            configure,
            reset,
            installStyles: () => injectStyleOnce(STYLE_ID, STYLE_TEXT),
            removeStyles: () => document.getElementById(STYLE_ID)?.remove(),
        };
    };
})();
