/**
 * features/chatMultiview.js — 채팅 멀티뷰 (isolated world, 최상위 프레임 전용)
 *
 * 헤더 오른쪽 도구 영역의 `채팅 멀티뷰` 버튼이 비모달 패널을 열고, 저장한 채널(최대 4개)의 치지직 네이티브 채팅
 * 경로만 같은 출처 프레임으로 나란히 보여 준다. 채팅 입력·로그인·작성 권한은 각 프레임의 치지직 화면이 소유한다.
 * 화면(2026-10-12 사용자 요청): 칸에는 채널 이름과 채팅만 보이고, 조작(추가·설정·채팅 크기·순서·제거·크기 조절)은
 * 마우스를 올리거나 키보드 초점이 들어왔을 때만 보인다. 확인된 칸 문서에는 확장 소유 스타일 하나만 넣어 네이티브
 * 머리·배너·주간 랭킹·후원 버튼과, 설정에서 끈 경우 입력 영역을 숨긴다. 채팅 크기는 프레임 바깥의 배율로만 바꾼다.
 * 크기는 채팅 한 칸 기준이고 패널은 칸 수만큼 커진다. 칸 머리를 끌면 패널이 옮겨지고 가까운 화면 모서리에 붙는다.
 * 의존: shared/chatMultiview.js(BetterChzzkChatMultiview), BetterChzzk.utils(shared/data.js·content.js),
 *   랭킹 상자 규칙은 features/chatWeeklyRanking.js의 BetterChzzk.chatWeeklyRanking(있으면).
 * 경계:
 *   - 프레임 주소는 model.frameUrl(검증한 채널 ID)뿐이다. 실패는 해당 칸에만 표시하고
 *     다른 경로·새 창으로 대체하지 않는다.
 *   - 프레임 load만으로 성공을 표시하지 않는다. 같은 출처·같은 채팅 경로와 네이티브 채팅 로그를 확인한 뒤 표시하고,
 *     프레임이 다른 주소로 이동하면 입력 대상이 바뀌지 않도록 그 칸을 가리고, 가려진 그 문서는 프레임을 떼어 멈춘다.
 *   - 검색·채널 조회·프레임 로드와 구성 저장은 신뢰된 사용자 동작에서만 시작한다(페이지의 합성 이벤트 거절).
 *   - 구성 저장은 saveConfig 어댑터 하나로만 나가며 settingsStoreSet의 expected 비교를 사용한다. 직접 쓰지 않는다.
 *   - 열림 상태는 저장하지 않는다. 닫기·옵션 OFF·pagehide에서 프레임·요청·관찰·타이머를 정리한다.
 *     SPA 이동은 열린 채팅을 유지하고 헤더 진입 버튼만 다시 연결한다.
 *   - 채널 추가는 영상 멀티뷰와 같은 방식이다. 검색 결과 행을 눌러 추가하고, 팔로잉 채널 링크를 패널에 끌어
 *     놓아도 된다. 놓은 링크는 채널 ID만 읽어 입력한 주소와 같은 조회 경로로 확인한다.
 */
(() => {
    if (window.top !== window) return;
    const model = globalThis.BetterChzzkChatMultiview;
    const root = window.BetterChzzk;
    if (!model || !root?.utils) return;

    const ID = "betterchzzk-chat-multiview";
    const PANEL_ID = ID + "-panel";
    const STYLE_ID = ID + "-style";
    const LIVE_START_ENTRY_ID = "betterchzzk-live-start-registration";
    const KEY = model.STORAGE_KEY;
    // features/chatTools.js가 독립 채팅 경로(2026-09-08 확인)에서도 첫 채팅 루트 후보로 쓰는 네이티브 로그 역할이에요.
    const NATIVE_CHAT_SELECTOR = '[role="log"]';
    const FRAME_LOAD_TIMEOUT_MS = 30000;
    const FRAME_CHAT_TIMEOUT_MS = 20000;
    const REQUEST_TIMEOUT_MS = 8000;
    const PANEL_MARGIN = 16;
    // 마우스를 올리면 패널 바로 위에 나타나는 조작 막대의 자리예요. 패널 높이 상한에서 미리 빼서 화면 밖으로 나가지 않게 해요.
    const BAR_SPACE = 40;
    // 2026-10-09 Codex 실측: 보통(960px)에서 4칸을 한 줄로 나누면 칸이 약 225px가 되어 네이티브 채팅 입력이 잘렸어요.
    // 입력창을 보일 때는 그 최소 크기를, 숨기면 채팅 목록을 읽을 수 있는 크기를 채팅 크기만큼 키워 보장하고
    // 남는 공간만 나눠요. 부족하면 패널 안에서 스크롤해요.
    const INPUT_CELL_MIN = Object.freeze({ width: 340, height: 320 });
    const LIST_CELL_MIN = Object.freeze({ width: 240, height: 180 });
    const GRID_GAP = 4;
    const PANEL_PADDING = 4;
    const EMPTY_PANEL = Object.freeze({ width: 400, height: 320 });
    const MESSAGE_MS = 5000;
    const FRAME_STYLE_ID = "betterchzzk-chat-multiview-frame-style";
    // 칸(네이티브 채팅 팝업, 2026-10-12 공개 번들 `index-VdvK-ysl.js`)에서 숨길 부분이에요. 모두 `aside#aside-chatting`
    // 직속 상자로 제한해 채팅 목록·고정 메시지는 남겨요. 머리는 첫 자식의 제목 h2(채팅 제목·채팅 크기·메뉴),
    // 배너는 `_banner_`, 입력 영역은 `_area_`, 후원 버튼은 입력 도구 `_tools_` 안의 `_donation_`이에요.
    const FRAME_HIDDEN = Object.freeze([
        "aside#aside-chatting > div:first-child:has(> h2)",
        'aside#aside-chatting > :is([class^="_banner_"], [class*=" _banner_"])',
        'aside#aside-chatting :is([class^="_tools_"], [class*=" _tools_"]) > :is([class^="_donation_"], [class*=" _donation_"])',
    ]);
    const FRAME_INPUT_AREA = 'aside#aside-chatting > :is([class^="_area_"], [class*=" _area_"])';
    // 2026-10-12 공개 CSS `index-B5SHICxp.css`: 채팅 팝업 페이지의 바깥 상자(`_container_1gtzb_1`)가
    // `min-width:353px`라서 그보다 좁은 칸(보통 340px·작게 280px·큰 채팅 크기)에는 칸 아래에 좌우 스크롤이 생겨요.
    // 채팅 상자의 부모만 최소 너비를 풀고, 칸 문서는 가로로 넘치지 않게 해요.
    const FRAME_FIT = "div:has(> aside#aside-chatting){min-width:0!important}html,body{overflow-x:hidden!important}";
    // 사용자 활성화 없는 최상위 이동만 막아 본문 영상 페이지를 보존해요. 같은 출처 채팅의 입력·팝업·확인 창은 유지해요.
    const FRAME_SANDBOX = [
        "allow-scripts",
        "allow-same-origin",
        "allow-forms",
        "allow-popups",
        "allow-popups-to-escape-sandbox",
        "allow-modals",
        "allow-top-navigation-by-user-activation",
    ].join(" ");
    const SIZE_OPTIONS = [
        ["small", "작게"],
        ["medium", "보통"],
        ["large", "크게"],
    ];
    const CORNER_OPTIONS = [
        ["bottom-left", "왼쪽 아래"],
        ["bottom-right", "오른쪽 아래"],
    ];
    const SVG_NS = "http://www.w3.org/2000/svg";
    // 장식 아이콘은 정적 경로만 SVG 요소로 만들어요. 두 번째 값이 true면 채운 모양이에요.
    const ICON_PATHS = Object.freeze({
        close: [["M4 4l8 8M12 4l-8 8"]],
        add: [["M8 3.5v9M3.5 8h9"]],
        minus: [["M3.5 8h9"]],
        text: [["M2 4h7M5.5 4v8.5M9.5 7.5h4.5M11.75 7.5v5"]],
        reload: [["M12.5 8a4.5 4.5 0 1 1-1.32-3.18M12.5 3v2.5H10"]],
        settings: [
            ["M2.5 5h6M12 5h1.5M2.5 11h1.5M7 11h6.5"],
            ["M10.5 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM5.5 9.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z"],
        ],
        prev: [["M10 3 5 8l5 5"]],
        next: [["m6 3 5 5-5 5"]],
        search: [["M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0ZM10.5 10.5 14 14"]],
        chat: [
            [
                "M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5a1.5 1.5 0 0 1-1.5 1.5H7.5L4.5 13.5V11A1.5 1.5 0 0 1 3 9.5Z",
            ],
        ],
        "bottom-left": [
            ["M3.5 2.5h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"],
            ["M3.5 8.5h4.5v3.5H3.5Z", true],
        ],
        "bottom-right": [
            ["M3.5 2.5h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z"],
            ["M8 8.5h4.5v3.5H8Z", true],
        ],
    });
    const TEXT = {
        conflict: "다른 탭에서 채팅 멀티뷰 구성이 바뀌어 최신 구성을 불러왔어요. 다시 시도해 주세요.",
        saveFailed: "구성을 저장하지 못했어요. 이 탭에서만 바뀐 구성으로 표시해요.",
        saveFailedExternal: "구성을 저장하지 못했어요. 다른 탭에서 저장한 구성을 표시해요.",
        discarded: "다른 탭에서 저장한 구성을 반영했어요. 이 탭에서 저장하지 못한 변경은 사라졌어요.",
        loadFailed: "채팅 멀티뷰 구성을 불러오지 못했어요.",
        loading: "채팅 멀티뷰 구성을 불러오는 중이에요.",
        notReady: "구성을 불러온 뒤 추가할 수 있어요.",
        empty: "채널을 추가하면 채팅이 여기에 나란히 표시돼요. 최대 4개까지 볼 수 있어요.",
        inputOn: "칸에서 채팅을 입력할 수 있어요.",
        inputOff: "채팅 입력창을 숨겼어요.",
        inputHelp: "켜면 각 칸 아래에 치지직 채팅 입력창이 보여요. 후원 버튼은 계속 숨겨요.",
        emptyInput: "채널 URL·채널 ID 또는 채널명을 입력해 주세요.",
        invalidInput: "치지직 채널 주소나 32자리 채널 ID를 확인해 주세요.",
        lookup: "채널을 확인하는 중이에요…",
        lookupFailed: "채널을 확인하지 못했어요. 주소나 채널 ID를 다시 확인해 주세요.",
        searching: "검색 중이에요…",
        searchFailed: "채널을 검색하지 못했어요. 잠시 후 다시 시도해 주세요.",
        pick: "추가할 채널을 선택해 주세요.",
        noResults: "검색 결과가 없어요.",
        dropInvalid: "치지직 채널 링크만 놓을 수 있어요.",
        dropHint: "팔로잉 채널을 패널에 끌어 놓아도 추가돼요.",
    };
    // 칸 상태별 입력 대상 표시와 프레임을 가리는 안내예요. ready·unverified만 프레임을 보여 줘요.
    const CELL_TEXT = {
        loading: {
            target: "입력 대상 확인 중",
            overlay: "채팅을 불러오는 중이에요…",
            action: "",
        },
        left: {
            target: "입력할 수 없어요",
            overlay: "이 칸이 채팅 화면을 벗어나 다른 곳에 입력되지 않도록 가렸어요.",
            action: "채팅으로 돌아가기",
        },
        failed: {
            target: "입력할 수 없어요",
            overlay: "채팅을 불러오지 못했어요.",
            action: "다시 시도",
        },
    };
    const {
        bindFeatureOptions,
        createMutationObserverSync,
        fetchJson,
        injectStyleOnce,
        normalizeChzzkImageUrl,
        onReady,
        startPageChangeDetection,
        storageGet,
    } = root.utils;
    const part = (name) => '[class^="_' + name + '_"], [class*=" _' + name + '_"]';
    const WATCH = "#" + ID + ", " + part("container") + ", " + part("section");

    let running = false,
        active = false,
        ready = false,
        unsaved = false;
    let lifecycle = 0,
        loadVersion = 0,
        storageRevision = 0,
        syncFrame = 0;
    // 마지막으로 확인한 저장 원본이에요. 키가 없으면 undefined이며 저장 요청의 expected로 그대로 보내요.
    let storedRaw;
    let config = model.createDefaultConfig();
    let loadError = "";
    let entry = null,
        panel = null,
        observer = null,
        removeOptions = null,
        removeRoute = null;
    let queue = Promise.resolve();

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
    }
    function button(text, label = text) {
        const node = el("button", "", text);
        node.type = "button";
        node.setAttribute("aria-label", label);
        return node;
    }
    function icon(name) {
        const svg = document.createElementNS(SVG_NS, "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        svg.setAttribute("focusable", "false");
        svg.setAttribute("class", "bccmv-icon");
        for (const [d, filled] of ICON_PATHS[name]) {
            const path = document.createElementNS(SVG_NS, "path");
            path.setAttribute("d", d);
            if (filled) path.setAttribute("class", "bccmv-icon-fill");
            svg.append(path);
        }
        return svg;
    }
    function iconButton(name, label, className = "bccmv-icon-button") {
        const node = button("", label);
        node.className = className;
        node.title = label;
        node.append(icon(name));
        return node;
    }
    function initialOf(name) {
        return Array.from(String(name || "").trim())[0] || "";
    }
    // 상태 안내는 잠깐 보였다가 사라져요. 열린 시트가 있으면 시트 아래, 없으면 패널 아래쪽에 떠요.
    function showMessage(target, text) {
        if (!target || panel !== target) return;
        target.message.textContent = text;
        if (target.messageTimer) clearTimeout(target.messageTimer);
        target.messageTimer = 0;
        if (!text) return;
        target.messageTimer = setTimeout(() => {
            target.messageTimer = 0;
            if (panel === target) target.message.textContent = "";
        }, MESSAGE_MS);
    }
    function notify(text) {
        showMessage(panel, text);
        render();
    }

    // ── 저장 경계 ──────────────────────────────────────────────────────────────
    // 구성 저장 어댑터. 워커의 설정 저장 잠금 안에서 expected(이전 원본)와 비교한 뒤에만 쓰며,
    // 다른 탭이 먼저 바꿨으면 error.code "conflict"와 error.current로 거절돼요.
    // 클라이언트에서 직접 저장하는 대체 경로는 두지 않아요.
    function saveConfig(previous, next) {
        const store = window.BetterChzzk?.utils?.settingsStoreSet;
        if (typeof store !== "function") {
            const error = new Error("Settings store is unavailable");
            error.code = "unavailable";
            return Promise.reject(error);
        }
        const expected = { [KEY]: previous === undefined ? { absent: true } : { value: previous } };
        return Promise.resolve().then(() => store("local", { [KEY]: next }, expected));
    }
    function readConflictCurrent(error) {
        const current = error?.current?.[KEY];
        if (current?.absent === true) return { known: true, value: undefined };
        if (current && Object.hasOwn(current, "value")) return { known: true, value: current.value };
        return { known: false };
    }
    function errorText(error) {
        if (error === "duplicate") return "이미 추가한 채널이에요.";
        if (error === "limit") return "채팅은 최대 " + model.MAX_CHANNELS + "개까지 추가할 수 있어요.";
        return "채팅 멀티뷰 구성을 바꾸지 못했어요.";
    }
    // 같은 문서의 변경은 순서대로 처리해요. 각 변경은 실행 시점의 문서 구성에서 계산하고
    // 마지막으로 확인한 저장 원본을 expected로 보내요.
    function commit(mutate, { success = "", after } = {}) {
        if (!active || !ready) return;
        const cycle = lifecycle;
        const task = async () => {
            if (cycle !== lifecycle) return;
            const result = mutate(config);
            if (!result.ok) {
                notify(errorText(result.error));
                after?.("rejected");
                return;
            }
            if (result.unchanged) {
                after?.("unchanged");
                return;
            }
            const previous = storedRaw;
            const revision = storageRevision;
            let outcome = "saved",
                conflict = null;
            try {
                await saveConfig(previous, result.config);
            } catch (error) {
                outcome = error?.code === "conflict" ? "conflict" : "failed";
                if (outcome === "conflict") conflict = readConflictCurrent(error);
            }
            if (cycle !== lifecycle) return;
            // 실패 응답이어도 저장 통지가 같은 값을 이미 알렸다면 저장된 것으로 봐요.
            if (
                outcome !== "saved" &&
                revision !== storageRevision &&
                model.isSameStoredValue(storedRaw, result.config)
            )
                outcome = "saved";
            if (outcome === "saved") {
                // 저장 통지가 먼저 왔다면 그 값(같거나 더 최신)이 이미 반영돼 있어요.
                if (revision === storageRevision) {
                    storedRaw = result.config;
                    config = result.config;
                }
                unsaved = false;
                notify(success);
            } else if (outcome === "conflict") {
                if (revision === storageRevision && conflict.known) {
                    storedRaw = conflict.value;
                    config = model.normalizeConfig(conflict.value);
                    unsaved = false;
                } else if (revision === storageRevision) void loadConfig();
                notify(TEXT.conflict);
            } else if (revision === storageRevision) {
                // 저장하지 못한 선택도 현재 문서에서는 유지하고, 다음 변경이 같은 expected로 다시 저장해요.
                config = result.config;
                unsaved = true;
                notify(TEXT.saveFailed);
            } else notify(TEXT.saveFailedExternal);
            after?.(outcome);
        };
        queue = queue.then(task, task).catch(() => {
            /* 한 변경의 예외가 다음 변경을 막지 않게 해요. */
        });
    }
    function onStorageChange(changes, area) {
        if (area !== "local" || !Object.hasOwn(changes, KEY)) return;
        storageRevision++;
        const raw = changes[KEY].newValue;
        const discarded = unsaved && !model.isSameStoredValue(raw, config);
        storedRaw = raw;
        config = model.normalizeConfig(raw);
        unsaved = false;
        ready = true;
        loadError = "";
        if (discarded) showMessage(panel, TEXT.discarded);
        render();
    }
    async function loadConfig() {
        const version = ++loadVersion,
            revision = storageRevision,
            cycle = lifecycle;
        try {
            const data = await storageGet(globalThis.chrome?.storage?.local, KEY);
            if (cycle !== lifecycle || version !== loadVersion) return;
            // 읽는 동안 도착한 변경 통지가 늦은 읽기 결과보다 우선해요.
            if (revision === storageRevision) {
                storedRaw = data?.[KEY];
                config = model.normalizeConfig(storedRaw);
                unsaved = false;
            }
            ready = true;
            loadError = "";
        } catch (_) {
            if (cycle !== lifecycle || version !== loadVersion) return;
            if (!ready) loadError = TEXT.loadFailed;
        }
        render();
    }

    // ── 헤더 진입 ──────────────────────────────────────────────────────────────
    function findControl() {
        const header = document.getElementById("header");
        if (!header) return null;
        // 2026-09-19: the right toolbar is a section directly inside the header's container.
        const matches = [];
        for (const container of header.children) {
            if (!container.matches(part("container"))) continue;
            for (const section of container.children) if (section.matches(part("section"))) matches.push(section);
        }
        return matches.length === 1 ? matches[0] : null;
    }
    function removeEntry() {
        entry?.node.remove();
        entry = null;
    }
    function onEntryClick(event) {
        if (panel) {
            closePanel();
            return;
        }
        // 페이지 스크립트의 합성 클릭으로 프레임 로드(네트워크)를 시작하지 않아요.
        if (!event.isTrusted) return;
        openPanel();
    }
    function syncEntry() {
        syncFrame = 0;
        if (!active) return;
        const control = findControl();
        if (!control) {
            removeEntry();
            return;
        }
        if (entry?.control !== control) {
            removeEntry();
            const node = el("span"),
                trigger = button("채팅 멀티뷰");
            node.id = ID;
            trigger.setAttribute("aria-expanded", String(!!panel));
            trigger.setAttribute("aria-controls", PANEL_ID);
            trigger.addEventListener("click", onEntryClick);
            trigger.addEventListener("keydown", onPanelKeydown);
            node.append(trigger);
            entry = { node, button: trigger, control };
        }
        if (entry.node.parentElement !== control) {
            // 방송 알림 버튼이 있으면 그 뒤에 두어 두 확장 버튼의 순서를 로드 순서와 무관하게 유지해요.
            const liveStart = Array.from(control.children).find((child) => child.id === LIVE_START_ENTRY_ID);
            if (liveStart) liveStart.after(entry.node);
            else control.prepend(entry.node);
        }
    }
    function scheduleEntry() {
        if (active && !syncFrame) syncFrame = requestAnimationFrame(syncEntry);
    }
    function shouldSchedule(mutations) {
        return mutations.some((mutation) => {
            if (entry?.node.contains(mutation.target)) return false;
            if (mutation.type === "attributes") return mutation.target.matches(WATCH);
            return [...mutation.addedNodes, ...mutation.removedNodes].some(
                (node) =>
                    node instanceof Element &&
                    !(node === entry?.node && Array.from(mutation.addedNodes).includes(node)) &&
                    (node.matches(WATCH) || node.querySelector(WATCH))
            );
        });
    }

    // ── 채널 추가 ──────────────────────────────────────────────────────────────
    function addBlockReason(channelId) {
        if (config.channels.some((item) => item.channelId === channelId)) return errorText("duplicate");
        if (config.channels.length >= model.MAX_CHANNELS) return errorText("limit");
        return "";
    }
    function cancelRequest(target) {
        target.controller?.abort();
        target.controller = null;
        target.busy = false;
    }
    function beginRequest(target) {
        cancelRequest(target);
        const controller = new AbortController();
        target.controller = controller;
        target.busy = true;
        return {
            signal: controller.signal,
            current: () => active && panel === target && target.controller === controller && !controller.signal.aborted,
            done() {
                if (target.controller !== controller) return;
                target.controller = null;
                target.busy = false;
            },
        };
    }
    function clearResults(target) {
        target.results.replaceChildren();
        target.resultRows.clear();
        target.results.hidden = true;
    }
    // 영상 멀티뷰 검색 결과처럼 행 전체를 눌러 추가해요. 오른쪽 표시는 추가·추가됨·가득 참 상태예요.
    function showResults(target, channels) {
        clearResults(target);
        for (const channel of channels) {
            const item = el("li"),
                add = el("button", "bccmv-result"),
                avatar = el("span", "bccmv-avatar", initialOf(channel.channelName));
            add.type = "button";
            add.dataset.channelId = channel.channelId;
            avatar.setAttribute("aria-hidden", "true");
            if (channel.imageUrl) {
                const image = el("img");
                image.alt = "";
                image.width = image.height = 32;
                image.loading = "lazy";
                image.decoding = "async";
                image.referrerPolicy = "no-referrer";
                image.addEventListener("error", () => image.remove(), { once: true });
                image.src = channel.imageUrl;
                avatar.append(image);
            }
            const info = el("span", "bccmv-result-info"),
                name = el("span", "bccmv-result-name", channel.channelName);
            name.title = channel.channelName;
            const followers = channel.followerCount;
            const parts = [];
            if (channel.live === true) parts.push("방송 중");
            else if (channel.live === false) parts.push("오프라인");
            if (followers !== null) parts.push(followerText(followers));
            const detail = el("span", "bccmv-result-detail", parts.join(" · "));
            if (channel.live === true) detail.dataset.live = "1";
            info.append(name, detail);
            const state = el("span", "bccmv-result-state", "추가");
            state.setAttribute("aria-hidden", "true");
            add.append(avatar, info, state);
            add.addEventListener("click", (event) => {
                if (!event.isTrusted) return;
                addChannel(target, channel);
            });
            item.append(add);
            target.results.append(item);
            target.resultRows.set(channel.channelId, { add, state, channel });
        }
        if (channels.length) target.results.append(el("li", "bccmv-results-hint", TEXT.dropHint));
        target.results.hidden = channels.length === 0;
    }
    function followerText(count) {
        return "팔로워 " + count.toLocaleString("ko-KR") + "명";
    }
    function followerCountOf(channel) {
        const count = channel.followerCount;
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }
    function addChannel(target, channel) {
        if (panel !== target) return;
        const blocked = addBlockReason(channel.channelId);
        if (blocked) {
            notify(blocked);
            return;
        }
        // 비어 있어 펼쳐 둔 추가 시트는 첫 채널을 추가한 뒤에도 이어서 추가할 수 있게 열어 둬요.
        if (sheetOf(target) === "add") target.sheetName = "add";
        const name = model.normalizeChannelName(channel.channelName) || channel.channelId;
        commit((base) => model.addChannel(base, channel), {
            success: name + " 채팅을 추가했어요.",
            after(outcome) {
                if (panel !== target || (outcome !== "saved" && outcome !== "failed")) return;
                target.input.value = "";
                clearResults(target);
                syncSubmitLabel(target);
                if (sheetOf(target) === "add") target.input.focus();
            },
        });
    }
    async function lookupChannel(target, channelId) {
        const request = beginRequest(target);
        clearResults(target);
        notify(TEXT.lookup);
        let channel = null;
        try {
            const json = await fetchJson("https://api.chzzk.naver.com/service/v1/channels/" + channelId, {
                signal: request.signal,
                timeoutMs: REQUEST_TIMEOUT_MS,
            });
            if (!request.current()) return;
            const content = json?.code === 200 ? json.content : null;
            if (
                content?.channelId === channelId &&
                typeof content.channelName === "string" &&
                content.channelName.trim()
            )
                channel = { channelId, channelName: content.channelName };
        } catch (_) {
            if (!request.current()) return;
        }
        request.done();
        if (!channel) {
            notify(TEXT.lookupFailed);
            return;
        }
        addChannel(target, channel);
    }
    async function searchChannels(target, keyword) {
        const request = beginRequest(target);
        clearResults(target);
        notify(TEXT.searching);
        let channels = null;
        try {
            const params = new URLSearchParams({ keyword, offset: "0", size: "5", withFirstChannelContent: "false" });
            const response = await fetchJson("https://api.chzzk.naver.com/service/v1/search/channels?" + params, {
                signal: request.signal,
                timeoutMs: REQUEST_TIMEOUT_MS,
            });
            if (!request.current()) return;
            if (response?.code === 200 && Array.isArray(response.content?.data)) {
                const seen = new Set();
                channels = response.content.data
                    .slice(0, 5)
                    .map((item) => item?.channel)
                    .filter((channel) => {
                        if (
                            !/^[a-f0-9]{32}$/.test(channel?.channelId) ||
                            typeof channel.channelName !== "string" ||
                            !channel.channelName.trim() ||
                            seen.has(channel.channelId)
                        )
                            return false;
                        seen.add(channel.channelId);
                        return true;
                    })
                    .map((channel) => ({
                        channelId: channel.channelId,
                        channelName: model.normalizeChannelName(channel.channelName),
                        imageUrl: normalizeChzzkImageUrl(channel.channelImageUrl),
                        followerCount: followerCountOf(channel),
                        live: typeof channel.openLive === "boolean" ? channel.openLive : null,
                    }));
            }
        } catch (_) {
            if (!request.current()) return;
        }
        request.done();
        if (!channels) {
            notify(TEXT.searchFailed);
            return;
        }
        showResults(target, channels);
        notify(channels.length ? TEXT.pick : TEXT.noResults);
    }
    function requestAdd(target) {
        if (!active || panel !== target) return;
        if (!ready) {
            notify(TEXT.notReady);
            return;
        }
        const parsed = model.parseChannelInput(target.input.value);
        if (parsed.kind === "empty") {
            notify(TEXT.emptyInput);
            return;
        }
        if (parsed.kind === "invalid") {
            notify(TEXT.invalidInput);
            return;
        }
        const blocked = parsed.kind === "id" ? addBlockReason(parsed.channelId) : addBlockReason("");
        if (blocked) {
            cancelRequest(target);
            clearResults(target);
            notify(blocked);
            return;
        }
        if (parsed.kind === "id") void lookupChannel(target, parsed.channelId);
        else void searchChannels(target, parsed.keyword);
    }
    function syncSubmitLabel(target) {
        const text = model.parseChannelInput(target.input.value).kind === "id" ? "추가" : "검색";
        if (target.submit.textContent !== text) target.submit.textContent = text;
    }

    // ── 끌어 놓기로 추가 ────────────────────────────────────────────────────────────
    // 팔로잉 채널 링크(text/uri-list)만 받아요. 링크에서 채널 ID만 읽고, 입력한 주소와 같은 조회로 확인해요.
    function carriesLink(event) {
        return Array.from(event.dataTransfer?.types || []).includes("text/uri-list");
    }
    function setDropState(target, value) {
        if (value) target.node.setAttribute("data-bccmv-drop", value);
        else target.node.removeAttribute("data-bccmv-drop");
    }
    function onPanelDragOver(target, event) {
        if (panel !== target || !event.isTrusted || !carriesLink(event)) return;
        if (!ready || addBlockReason("")) {
            setDropState(target, "blocked");
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "link";
        setDropState(target, "ready");
    }
    function onPanelDragLeave(target, event) {
        if (event.relatedTarget instanceof Node && target.node.contains(event.relatedTarget)) return;
        setDropState(target, "");
    }
    function onPanelDrop(target, event) {
        if (!event.isTrusted) return;
        const accepted = target.node.getAttribute("data-bccmv-drop") === "ready";
        setDropState(target, "");
        if (panel !== target || !accepted || !carriesLink(event)) return;
        event.preventDefault();
        const link = String(event.dataTransfer.getData("text/uri-list") || "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line && !line.startsWith("#"));
        const parsed = model.parseChannelInput(link || "");
        if (parsed.kind !== "id") {
            notify(TEXT.dropInvalid);
            return;
        }
        const blocked = addBlockReason(parsed.channelId);
        if (blocked) {
            notify(blocked);
            return;
        }
        void lookupChannel(target, parsed.channelId);
    }
    // 같은 문서에서 시작한 끌기 동안에는 채팅 프레임이 끌기 이벤트를 가져가지 않게 해요.
    function onDocumentDragStart(event) {
        if (panel && event.isTrusted) panel.node.setAttribute("data-bccmv-dragging", "");
    }
    // 끌던 노드가 끄는 중에 문서에서 빠지면(다시 그린 팔로잉 행 등) dragend가 떨어진 노드에만 와서 창까지 오지 않아요.
    // 끌기 중에는 누르기가 오지 않으므로 다음 누르기에서도 정리해 칸 프레임이 포인터를 계속 잃지 않게 해요.
    function onDocumentDragEnd(event) {
        if (!panel || !event.isTrusted) return;
        panel.node.removeAttribute("data-bccmv-dragging");
        setDropState(panel, "");
    }

    // ── 채팅 칸과 프레임 ────────────────────────────────────────────────────────
    function isCurrent(target, cell) {
        return active && panel === target && target.cells.get(cell.channelId) === cell;
    }
    function clearWait(cell) {
        if (cell.timer) clearTimeout(cell.timer);
        cell.timer = 0;
        cell.observer?.disconnect();
        cell.observer = null;
    }
    function stopWatching(cell) {
        clearWait(cell);
        cell.unwatch?.();
        cell.unwatch = null;
        cell.verified = false;
    }
    function frameLocation(frame) {
        try {
            const view = frame.contentWindow;
            if (!view || !frame.contentDocument) return null;
            const { href, origin, pathname } = view.location;
            return { href: String(href), origin: String(origin), pathname: String(pathname) };
        } catch (_) {
            return null;
        }
    }
    function isChatLocation(location, cell) {
        return (
            !!location && location.origin === model.FRAME_ORIGIN && model.isFramePath(location.pathname, cell.channelId)
        );
    }
    function hasNativeChat(cell) {
        try {
            return !!cell.frame.contentDocument?.querySelector(NATIVE_CHAT_SELECTOR);
        } catch (_) {
            return false;
        }
    }
    // 확인한 칸 문서에 확장 소유 스타일 하나만 두고 숨김 규칙을 맞춰요. 칸의 스크립트·입력 값·쿠키는 다루지 않아요.
    function frameCss() {
        const ranking = root.chatWeeklyRanking?.RANKING_BOX_SELECTORS;
        const rules = [...FRAME_HIDDEN, ...(Array.isArray(ranking) ? ranking : [])];
        if (!config.input) rules.push(FRAME_INPUT_AREA);
        return FRAME_FIT + "\n" + rules.join(",\n") + "{display:none!important}";
    }
    function syncFrameStyle(cell) {
        if (!cell.verified || !isChatLocation(frameLocation(cell.frame), cell)) return;
        try {
            const doc = cell.frame.contentDocument;
            if (!doc?.documentElement) return;
            const css = frameCss();
            let style = doc.getElementById(FRAME_STYLE_ID);
            if (!style) {
                style = doc.createElement("style");
                style.id = FRAME_STYLE_ID;
                (doc.head || doc.documentElement).append(style);
            }
            if (style.textContent !== css) style.textContent = css;
        } catch (_) {
            /* 문서가 바뀌는 중이에요. 다음 load에서 다시 맞춰요. */
        }
    }
    function setCellState(cell, state) {
        cell.state = state;
        syncCell(cell);
    }
    // 채팅을 벗어난 칸 문서는 가려져 입력도 받지 않으므로 프레임을 떼어 그 화면(다른 방송 플레이어 등)을 멈춰요.
    // 같은 프레임은 `채팅으로 돌아가기`에서 채팅 주소로만 다시 붙여요.
    function leaveCell(cell) {
        stopWatching(cell);
        cell.frame.remove();
        setCellState(cell, "left");
    }
    // 확인된 문서가 다른 주소로 바뀌었으면 입력 대상이 달라지지 않게 칸을 가려요.
    function verifyCell(target, cell) {
        if (!isCurrent(target, cell) || !cell.verified) return false;
        if (isChatLocation(frameLocation(cell.frame), cell)) return true;
        leaveCell(cell);
        return false;
    }
    function watchNavigation(target, cell) {
        let navigation = null;
        try {
            navigation = cell.frame.contentWindow?.navigation || null;
        } catch (_) {
            navigation = null;
        }
        if (typeof navigation?.addEventListener !== "function") return;
        const check = () => verifyCell(target, cell);
        try {
            navigation.addEventListener("currententrychange", check);
            cell.unwatch = () => {
                try {
                    navigation.removeEventListener("currententrychange", check);
                } catch (_) {
                    /* 이미 사라진 프레임 문서예요. */
                }
            };
        } catch (_) {
            cell.unwatch = null;
        }
    }
    function onFrameLoad(target, cell) {
        if (!isCurrent(target, cell)) return;
        const location = frameLocation(cell.frame);
        if (location?.href === "about:blank") return;
        stopWatching(cell);
        if (!isChatLocation(location, cell)) {
            leaveCell(cell);
            return;
        }
        cell.verified = true;
        watchNavigation(target, cell);
        if (hasNativeChat(cell)) {
            setCellState(cell, "ready");
            return;
        }
        setCellState(cell, "loading");
        try {
            cell.observer = new MutationObserver(() => {
                if (!verifyCell(target, cell) || !hasNativeChat(cell)) return;
                clearWait(cell);
                setCellState(cell, "ready");
            });
            cell.observer.observe(cell.frame.contentDocument, { childList: true, subtree: true });
        } catch (_) {
            cell.observer = null;
        }
        cell.timer = setTimeout(() => {
            cell.timer = 0;
            if (!isCurrent(target, cell) || cell.state !== "loading") return;
            clearWait(cell);
            if (!verifyCell(target, cell)) return;
            setCellState(cell, hasNativeChat(cell) ? "ready" : "unverified");
        }, FRAME_CHAT_TIMEOUT_MS);
    }
    function loadFrame(target, cell) {
        if (!isCurrent(target, cell)) return;
        const url = model.frameUrl(cell.channelId);
        stopWatching(cell);
        if (!url) {
            setCellState(cell, "failed");
            return;
        }
        const attempt = ++cell.attempt;
        setCellState(cell, "loading");
        cell.timer = setTimeout(() => {
            cell.timer = 0;
            if (!isCurrent(target, cell) || cell.attempt !== attempt || cell.verified || cell.state !== "loading")
                return;
            clearWait(cell);
            setCellState(cell, "failed");
        }, FRAME_LOAD_TIMEOUT_MS);
        cell.frame.src = url;
        // 벗어나 떼어 둔 프레임은 채팅 주소를 정한 뒤 다시 붙여 그 주소로만 불러와요.
        if (cell.frame.parentNode !== cell.body) cell.body.prepend(cell.frame);
    }
    function syncCell(cell) {
        const { state } = cell;
        const usable = state === "ready" || state === "unverified";
        const text = CELL_TEXT[state] || CELL_TEXT.failed;
        cell.node.dataset.state = state;
        // 확인되지 않은 프레임은 inert로 초점·입력을 받지 않아요.
        cell.frame.toggleAttribute("inert", !usable);
        // 입력 대상은 화면에서 칸 머리의 채널 이름으로 보이고, 화면 낭독기에는 프레임 설명으로 읽혀요.
        cell.target.textContent = usable ? "입력 대상: " + cell.name : text.target;
        cell.note.textContent = state === "unverified" ? "채팅 목록을 확인하지 못했어요." : "";
        cell.note.title = cell.note.textContent;
        cell.note.hidden = state !== "unverified";
        cell.retry.hidden = state !== "unverified";
        syncFrameStyle(cell);
        cell.overlay.hidden = usable;
        cell.overlayText.textContent = usable ? "" : text.overlay;
        cell.overlayButton.hidden = usable || !text.action;
        cell.overlayButton.textContent = text.action || "다시 시도";
        cell.overlayButton.setAttribute("aria-label", cell.name + " " + cell.overlayButton.textContent);
        if (!usable) cell.node.removeAttribute("data-bccmv-active");
    }
    function createCell(target, channel) {
        const node = el("li", "bccmv-cell");
        node.dataset.channelId = channel.channelId;
        // 칸 머리는 채널 이름만 보여요. 조작 버튼은 마우스를 올리거나 키보드 초점이 들어왔을 때만 보여요.
        const head = el("div", "bccmv-cell-head"),
            title = el("strong", "bccmv-cell-name"),
            targetLabel = el("span", "bccmv-cell-target bccmv-visually-hidden"),
            note = el("span", "bccmv-cell-note");
        targetLabel.id = PANEL_ID + "-target-" + channel.channelId;
        const actions = el("div", "bccmv-cell-actions");
        const retry = iconButton("reload", "다시 시도"),
            back = iconButton("prev", "앞으로"),
            forward = iconButton("next", "뒤로"),
            remove = iconButton("close", "제거");
        retry.dataset.action = "retry";
        back.dataset.action = "back";
        forward.dataset.action = "forward";
        remove.dataset.action = "remove";
        actions.append(retry, back, forward, remove);
        head.append(title, note, targetLabel, actions);
        const body = el("div", "bccmv-cell-body");
        const frame = document.createElement("iframe");
        frame.className = "bccmv-frame";
        frame.setAttribute("sandbox", FRAME_SANDBOX);
        frame.setAttribute("aria-describedby", targetLabel.id);
        const overlay = el("div", "bccmv-cell-overlay"),
            overlayText = el("p"),
            overlayButton = button("다시 시도");
        overlayButton.dataset.action = "reload";
        overlay.append(overlayText, overlayButton);
        body.append(frame, overlay);
        node.append(head, body);
        const cell = {
            channelId: channel.channelId,
            name: channel.channelName || channel.channelId,
            node,
            title,
            back,
            forward,
            remove,
            target: targetLabel,
            note,
            retry,
            body,
            frame,
            overlay,
            overlayText,
            overlayButton,
            state: "loading",
            verified: false,
            attempt: 0,
            timer: 0,
            observer: null,
            unwatch: null,
        };
        back.addEventListener("click", (event) => {
            if (event.isTrusted) moveCell(target, cell, -1);
        });
        forward.addEventListener("click", (event) => {
            if (event.isTrusted) moveCell(target, cell, 1);
        });
        remove.addEventListener("click", (event) => {
            if (event.isTrusted) removeChannel(target, cell);
        });
        for (const reload of [retry, overlayButton]) {
            reload.addEventListener("click", (event) => {
                if (event.isTrusted) loadFrame(target, cell);
            });
        }
        frame.addEventListener("load", () => onFrameLoad(target, cell));
        body.addEventListener("pointerenter", () => verifyCell(target, cell));
        head.title = "끌어서 패널 옮기기";
        bindDrag(target, head, startMove);
        return cell;
    }
    function removeCell(target, cell) {
        stopWatching(cell);
        target.cells.delete(cell.channelId);
        cell.node.remove();
    }
    function moveCell(target, cell, offset) {
        const source = offset < 0 ? cell.back : cell.forward;
        commit((base) => model.moveChannel(base, cell.channelId, offset), {
            success: cell.name + " 채팅을 " + (offset < 0 ? "앞으로" : "뒤로") + " 옮겼어요.",
            after() {
                if (!isCurrent(target, cell) || !source.disabled) return;
                const focused = document.activeElement;
                if (focused === source || focused === document.body || !focused)
                    (offset < 0 ? cell.forward : cell.back).focus();
            },
        });
    }
    function removeChannel(target, cell) {
        const index = config.channels.findIndex((item) => item.channelId === cell.channelId);
        commit((base) => model.removeChannel(base, cell.channelId), {
            success: cell.name + " 채팅을 제거했어요.",
            after() {
                if (panel !== target || cell.node.isConnected) return;
                const focused = document.activeElement;
                if (focused && focused !== document.body && focused.isConnected) return;
                const next = config.channels[Math.min(Math.max(index, 0), config.channels.length - 1)];
                const fallback = sheetOf(target) === "add" ? target.input : target.addToggle;
                (target.cells.get(next?.channelId)?.remove || fallback).focus();
            },
        });
    }
    function syncDomOrder(target, channels) {
        // 프레임을 옮기면 채팅이 다시 로드되므로 상태를 보존하는 moveBefore가 있을 때만 DOM 순서를 맞춰요.
        // 없으면 CSS order로 표시 순서만 바꿔요.
        if (typeof target.grid.moveBefore !== "function") return;
        channels.forEach((channel, index) => {
            const node = target.cells.get(channel.channelId)?.node;
            const current = target.grid.children[index] || null;
            if (!node || node === current) return;
            try {
                target.grid.moveBefore(node, current);
            } catch (_) {
                /* 이동할 수 없으면 CSS order 표시를 유지해요. */
            }
        });
    }
    function renderCells(target) {
        const channels = ready ? config.channels : [];
        const ids = new Set(channels.map((item) => item.channelId));
        for (const cell of [...target.cells.values()]) if (!ids.has(cell.channelId)) removeCell(target, cell);
        channels.forEach((channel, index) => {
            let cell = target.cells.get(channel.channelId);
            const created = !cell;
            if (created) {
                cell = createCell(target, channel);
                target.cells.set(channel.channelId, cell);
                target.grid.append(cell.node);
            }
            cell.name = channel.channelName || channel.channelId;
            cell.node.style.order = String(index);
            cell.title.textContent = cell.name;
            cell.title.title = cell.name;
            cell.frame.title = cell.name + " 채팅";
            cell.back.disabled = index === 0;
            cell.forward.disabled = index === channels.length - 1;
            cell.back.setAttribute("aria-label", cell.name + " 채팅을 앞으로 이동");
            cell.forward.setAttribute("aria-label", cell.name + " 채팅을 뒤로 이동");
            cell.remove.setAttribute("aria-label", cell.name + " 채팅 제거");
            cell.back.title = "앞으로 이동";
            cell.forward.title = "뒤로 이동";
            cell.remove.title = "채팅 제거";
            cell.retry.setAttribute("aria-label", cell.name + " 채팅 다시 시도");
            cell.retry.title = "다시 시도";
            if (created) loadFrame(target, cell);
            else syncCell(cell);
        });
        syncDomOrder(target, channels);
    }

    // ── 패널 ───────────────────────────────────────────────────────────────────
    function cellMin() {
        const base = config.input ? INPUT_CELL_MIN : LIST_CELL_MIN;
        const ratio = config.scale / 100;
        return { width: Math.ceil(base.width * ratio), height: Math.ceil(base.height * ratio) };
    }
    function viewportSpace() {
        return {
            width: Math.max(0, window.innerWidth - PANEL_MARGIN * 2),
            height: Math.max(0, window.innerHeight - PANEL_MARGIN * 2 - BAR_SPACE),
        };
    }
    function span(count, size) {
        return count * size + (count - 1) * GRID_GAP + PANEL_PADDING * 2;
    }
    // 2026-10-12 사용자 요청: 크기는 채팅 한 칸의 크기이고 패널은 칸 수에 맞춰 커져요. 한 줄에 다 들어가지 않으면
    // 줄 수를 늘리되 줄마다 칸 수를 고르게 나누고, 화면보다 크면 화면에 맞춘 뒤 최소 크기 아래로는 스크롤해요.
    function panelGeometry(target) {
        const count = ready ? config.channels.length : 0;
        const space = viewportSpace();
        if (!count)
            return {
                width: Math.min(EMPTY_PANEL.width, space.width),
                height: Math.min(EMPTY_PANEL.height, space.height),
                columns: 1,
                rows: 1,
            };
        const min = cellMin();
        const size = target.displaySize || { width: config.chatWidth, height: config.chatHeight };
        const chatWidth = Math.max(size.width, min.width),
            chatHeight = Math.max(size.height, min.height);
        let { columns, rows } = target.drag?.type === "resize" ? target.drag : {};
        if (!columns) {
            const fit = Math.max(1, Math.floor((space.width - PANEL_PADDING * 2 + GRID_GAP) / (chatWidth + GRID_GAP)));
            rows = Math.ceil(count / Math.min(count, fit));
            columns = Math.ceil(count / rows);
        }
        return {
            width: Math.min(span(columns, chatWidth), space.width),
            height: Math.min(span(rows, chatHeight), space.height),
            columns,
            rows,
        };
    }
    function placementOf(target) {
        return target.displayPosition || { corner: config.corner, x: config.x, y: config.y };
    }
    function clampTo(value, min, max) {
        return Math.max(min, Math.min(value, Math.max(min, max)));
    }
    // 저장한 모서리에서의 거리로 위치를 정하고, 화면이 줄어도 패널과 위쪽 조작 막대가 화면 안에 남게 해요.
    function panelBox(target, geometry) {
        const place = placementOf(target);
        const left = place.corner.endsWith("right") ? window.innerWidth - place.x - geometry.width : place.x;
        const top = place.corner.startsWith("bottom") ? window.innerHeight - place.y - geometry.height : place.y;
        return {
            corner: place.corner,
            left: clampTo(left, PANEL_MARGIN, window.innerWidth - PANEL_MARGIN - geometry.width),
            top: clampTo(top, PANEL_MARGIN + BAR_SPACE, window.innerHeight - PANEL_MARGIN - geometry.height),
        };
    }
    function applyGeometry(target) {
        const geometry = panelGeometry(target);
        const box = panelBox(target, geometry);
        target.geometry = geometry;
        target.node.dataset.corner = box.corner;
        const style = { left: box.left, top: box.top, width: geometry.width, height: geometry.height };
        for (const [name, value] of Object.entries(style))
            if (target.node.style[name] !== Math.round(value) + "px")
                target.node.style[name] = Math.round(value) + "px";
        layoutGrid(target, geometry);
    }
    // 프레임을 옮기거나 다시 불러오지 않고 그리드 열·행 값만 바꿔요.
    function layoutGrid(target, { columns, rows }) {
        const min = cellMin();
        const vars = {
            "--bccmv-columns": String(columns),
            "--bccmv-rows": String(rows),
            "--bccmv-cell-width": min.width + "px",
            "--bccmv-cell-height": min.height + "px",
        };
        for (const [name, value] of Object.entries(vars))
            if (target.grid.style.getPropertyValue(name) !== value) target.grid.style.setProperty(name, value);
        target.grid.dataset.columns = String(columns);
        target.grid.dataset.rows = String(rows);
        scheduleNav(target);
    }
    // 2026-10-09 Codex 실측: 작게에서 앞 2칸만 보이고 macOS 자동 숨김 스크롤바 때문에 뒤 칸이 있다는 표시가 없었어요.
    // 그리드 스크롤바는 항상 보이고, 칸이 패널을 넘칠 때만 조작 막대에 이전·다음 버튼, 채널 이름 버튼,
    // 보이는 범위 안내(화면 낭독용)를 더해요. 그리드만 스크롤하며 채팅 프레임은 옮기거나 다시 불러오지 않아요.
    function orderedCells(target) {
        return config.channels.map((channel) => target.cells.get(channel.channelId)).filter(Boolean);
    }
    function isCellVisible(target, cell) {
        const area = target.grid.getBoundingClientRect(),
            rect = cell.node.getBoundingClientRect();
        const shown = (start, end, min, max) => Math.max(0, Math.min(end, max) - Math.max(start, min));
        const width = rect.right - rect.left,
            height = rect.bottom - rect.top;
        if (width <= 0 || height <= 0) return false;
        return (
            shown(rect.left, rect.right, area.left, area.right) / width >= 0.6 &&
            shown(rect.top, rect.bottom, area.top, area.bottom) / height >= 0.6
        );
    }
    function gridOverflows(target) {
        const grid = target.grid;
        return grid.scrollWidth > grid.clientWidth + 1 || grid.scrollHeight > grid.clientHeight + 1;
    }
    function scrollToCell(target, cell) {
        if (!cell || panel !== target) return;
        const area = target.grid.getBoundingClientRect(),
            rect = cell.node.getBoundingClientRect();
        const left = rect.left - area.left,
            top = rect.top - area.top;
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        if (typeof target.grid.scrollBy === "function")
            target.grid.scrollBy({ left, top, behavior: reduce ? "auto" : "smooth" });
        else {
            target.grid.scrollLeft += left;
            target.grid.scrollTop += top;
        }
        scheduleNav(target);
    }
    function stepCells(target, direction) {
        const cells = orderedCells(target);
        const visible = cells.map((cell) => isCellVisible(target, cell));
        const first = visible.indexOf(true),
            last = visible.lastIndexOf(true);
        let index;
        if (first < 0) index = direction < 0 ? 0 : cells.length - 1;
        else index = direction < 0 ? first - 1 : last + 1;
        scrollToCell(target, cells[Math.min(Math.max(index, 0), cells.length - 1)]);
    }
    function syncNav(target) {
        target.navFrame = 0;
        if (panel !== target) return;
        const cells = orderedCells(target);
        const overflow = cells.length > 1 && gridOverflows(target);
        target.nav.hidden = !overflow;
        if (!overflow) return;
        const visible = cells.map((cell) => isCellVisible(target, cell));
        const chips = cells.map((cell, index) => {
            let chip = target.navChips.get(cell.channelId);
            if (!chip) {
                chip = button("");
                chip.className = "bccmv-nav-chip";
                chip.addEventListener("click", () => scrollToCell(target, target.cells.get(cell.channelId)));
                target.navChips.set(cell.channelId, chip);
            }
            chip.textContent = cell.name;
            chip.title = cell.name;
            chip.setAttribute(
                "aria-label",
                visible[index] ? cell.name + " 채팅, 지금 보여요" : cell.name + " 채팅으로 이동"
            );
            if (visible[index]) chip.setAttribute("aria-current", "true");
            else chip.removeAttribute("aria-current");
            return chip;
        });
        for (const [id, chip] of [...target.navChips]) {
            if (!target.cells.has(id)) {
                chip.remove();
                target.navChips.delete(id);
            }
        }
        // Extension-owned buttons only; the chat frames stay where they are.
        if (chips.some((chip, index) => target.navList.children[index] !== chip))
            target.navList.replaceChildren(...chips);
        const first = visible.indexOf(true),
            last = visible.lastIndexOf(true);
        target.navPrev.disabled = first <= 0;
        target.navNext.disabled = last < 0 || last >= cells.length - 1;
        target.navStatus.textContent =
            first < 0
                ? cells.length + "개 중 보이는 채팅이 없어요"
                : first === last
                  ? cells.length + "개 중 " + (first + 1) + "번째가 보여요"
                  : cells.length + "개 중 " + (first + 1) + "–" + (last + 1) + "번째가 보여요";
    }
    function scheduleNav(target) {
        if (!target || target.navFrame || panel !== target) return;
        target.navFrame = requestAnimationFrame(() => syncNav(target));
    }
    function onViewportResize() {
        if (panel) applyGeometry(panel);
    }
    function syncActiveCell() {
        const target = panel;
        if (!target) return;
        const focused = document.activeElement;
        for (const cell of target.cells.values()) {
            const focusedCell = cell.frame === focused && verifyCell(target, cell);
            cell.node.toggleAttribute(
                "data-bccmv-active",
                focusedCell && (cell.state === "ready" || cell.state === "unverified")
            );
        }
    }
    function onWindowBlur() {
        // 프레임으로 초점이 옮겨진 뒤 activeElement가 갱신돼요.
        setTimeout(syncActiveCell, 0);
    }
    // ── 끌어서 옮기기·크기 조절 ─────────────────────────────────────────────────
    // 칸 머리(채널 이름 줄)를 끌면 패널 전체가 따라와요. 놓은 곳에서 가장 가까운 화면 모서리를 기준으로
    // 거리를 저장해 창 크기가 바뀌어도 그 모서리에 붙어 있어요. 크기 손잡이는 그 반대쪽 모서리에 있어요.
    function beginDrag(target, event, type, handle) {
        if (!event.isTrusted || event.pointerType !== "mouse" || event.button !== 0 || !ready || target.drag) return;
        event.preventDefault();
        const geometry = target.geometry || panelGeometry(target);
        const box = panelBox(target, geometry);
        target.drag = {
            type,
            handle,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            left: box.left,
            top: box.top,
            corner: box.corner,
            width: geometry.width,
            height: geometry.height,
            columns: geometry.columns,
            rows: geometry.rows,
            moved: false,
        };
        try {
            handle.setPointerCapture?.(event.pointerId);
        } catch (_) {
            /* 캡처가 없어도 끄는 동안에는 프레임이 포인터를 가로채지 않아요. */
        }
        target.node.setAttribute(type === "move" ? "data-bccmv-moving" : "data-bccmv-resizing", "");
    }
    function bindDrag(target, element, start) {
        element.addEventListener("pointerdown", (event) => start(target, event));
        element.addEventListener("pointermove", (event) => dragTo(target, event));
        element.addEventListener("pointerup", (event) => endDrag(target, event, true));
        element.addEventListener("pointercancel", (event) => endDrag(target, event, false));
        element.addEventListener("lostpointercapture", (event) => endDrag(target, event, false));
    }
    function startMove(target, event) {
        if (event.target instanceof Element && event.target.closest("button, input, a")) return;
        beginDrag(target, event, "move", event.currentTarget);
    }
    function startResize(target, event) {
        if (!config.channels.length) return;
        beginDrag(target, event, "resize", target.handle);
    }
    function dragTo(target, event) {
        const drag = target.drag;
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.x,
            dy = event.clientY - drag.y;
        if (dx || dy) drag.moved = true;
        if (drag.type === "move") {
            const width = drag.width,
                height = drag.height;
            const left = clampTo(drag.left + dx, PANEL_MARGIN, window.innerWidth - PANEL_MARGIN - width);
            const top = clampTo(drag.top + dy, PANEL_MARGIN + BAR_SPACE, window.innerHeight - PANEL_MARGIN - height);
            const right = left + width / 2 >= window.innerWidth / 2,
                bottom = top + height / 2 >= window.innerHeight / 2;
            target.displayPosition = {
                corner: (bottom ? "bottom-" : "top-") + (right ? "right" : "left"),
                x: Math.round(right ? window.innerWidth - left - width : left),
                y: Math.round(bottom ? window.innerHeight - top - height : top),
            };
        } else {
            // 손잡이는 붙인 모서리의 반대쪽이라, 그쪽으로 끌수록 커져요. 끄는 동안 열·행 수는 그대로 둬요.
            const space = viewportSpace(),
                min = cellMin();
            const width = drag.width + (drag.corner.endsWith("right") ? -dx : dx);
            const height = drag.height + (drag.corner.startsWith("bottom") ? -dy : dy);
            const panelWidth = clampTo(width, span(drag.columns, min.width), space.width);
            const panelHeight = clampTo(height, span(drag.rows, min.height), space.height);
            target.displaySize = {
                width: Math.round((panelWidth - span(drag.columns, 0)) / drag.columns),
                height: Math.round((panelHeight - span(drag.rows, 0)) / drag.rows),
            };
        }
        applyGeometry(target);
    }
    function endDrag(target, event, save) {
        const drag = target.drag;
        if (!drag || (event && event.pointerId !== drag.pointerId)) return;
        target.drag = null;
        target.node.removeAttribute("data-bccmv-moving");
        target.node.removeAttribute("data-bccmv-resizing");
        try {
            drag.handle?.releasePointerCapture?.(drag.pointerId);
        } catch (_) {
            /* 이미 해제된 캡처예요. */
        }
        if (save && drag.moved && event?.isTrusted) {
            if (drag.type === "move" && target.displayPosition) {
                const place = target.displayPosition;
                commit((base) => model.withPosition(base, place.corner, place.x, place.y), {
                    after() {
                        if (target.displayPosition === place) target.displayPosition = null;
                        if (panel === target) applyGeometry(target);
                    },
                });
            } else if (drag.type === "resize" && target.displaySize) {
                const size = target.displaySize;
                commit((base) => model.withChatSize(base, size.width, size.height), {
                    success: "채팅 칸 크기를 저장했어요.",
                    after() {
                        if (target.displaySize === size) target.displaySize = null;
                        if (panel === target) applyGeometry(target);
                    },
                });
            }
        } else {
            target.displayPosition = null;
            target.displaySize = null;
        }
        applyGeometry(target);
    }
    function onPanelKeydown(event) {
        const target = panel;
        if (!target || event.key !== "Escape" || event.isComposing) return;
        event.preventDefault();
        if (target.drag) {
            endDrag(target, null, false);
            return;
        }
        if (!target.results.hidden && target.node.contains(event.target)) {
            clearResults(target);
            return;
        }
        if (target.sheetName && target.node.contains(event.target)) {
            const toggle = target.sheetName === "add" ? target.addToggle : target.settingsToggle;
            setSheet(target, "");
            toggle.focus();
            return;
        }
        closePanel(true);
    }
    // 채널 추가·설정은 조작 막대 아래의 시트 하나에 번갈아 보여요. 채팅이 없으면 추가 시트를 펼쳐 둬요.
    function sheetOf(target) {
        if (target.sheetName) return target.sheetName;
        return ready && !config.channels.length ? "add" : "";
    }
    function setSheet(target, name) {
        if (panel !== target) return;
        if (target.sheetName === "add" && name !== "add") {
            cancelRequest(target);
            clearResults(target);
        }
        target.sheetName = name;
        render();
        if (name === "add") target.input.focus();
    }
    function segmented(label) {
        const group = el("div", "bccmv-group");
        group.setAttribute("role", "group");
        group.setAttribute("aria-label", label);
        return group;
    }
    function settingRow(label, control) {
        const row = el("div", "bccmv-setting"),
            name = el("span", "bccmv-setting-name", label);
        row.append(name, control);
        return row;
    }
    function openPanel() {
        if (!active || panel) return;
        const node = el("section");
        node.id = PANEL_ID;
        node.setAttribute("role", "dialog");
        node.setAttribute("aria-labelledby", PANEL_ID + "-title");
        const title = el("h2", "bccmv-visually-hidden", "채팅 멀티뷰");
        title.id = PANEL_ID + "-title";

        // 조작 막대: 마우스를 패널에 올리거나 키보드 초점이 들어오면 패널 바로 위에 나타나요.
        const bar = el("div", "bccmv-bar");
        bar.setAttribute("role", "toolbar");
        bar.setAttribute("aria-label", "채팅 멀티뷰 조작");
        const nav = el("div", "bccmv-nav"),
            navPrev = iconButton("prev", "이전 채팅 보기"),
            navList = el("div", "bccmv-nav-chips"),
            navNext = iconButton("next", "다음 채팅 보기"),
            navStatus = el("span", "bccmv-nav-status bccmv-visually-hidden");
        nav.setAttribute("role", "group");
        nav.setAttribute("aria-label", "가려진 채팅으로 이동");
        nav.hidden = true;
        nav.append(navPrev, navList, navNext, navStatus);
        const scaleGroup = segmented("채팅 크기"),
            scaleDown = iconButton("minus", "채팅 크기 줄이기"),
            scaleValue = el("span", "bccmv-scale-value"),
            scaleUp = iconButton("add", "채팅 크기 키우기");
        scaleGroup.classList.add("bccmv-scale");
        scaleGroup.title = "채팅 크기";
        scaleValue.setAttribute("aria-live", "polite");
        // 채널 추가의 + 버튼과 헷갈리지 않게 글자 크기 아이콘을 앞에 둬요.
        scaleGroup.append(icon("text"), scaleDown, scaleValue, scaleUp);
        const addToggle = button("", "채널 추가"),
            count = el("span", "bccmv-count");
        addToggle.className = "bccmv-bar-button";
        addToggle.title = "채널 추가";
        addToggle.setAttribute("aria-controls", PANEL_ID + "-sheet");
        addToggle.append(icon("add"), count);
        const settingsToggle = iconButton("settings", "채팅 멀티뷰 설정");
        settingsToggle.setAttribute("aria-controls", PANEL_ID + "-sheet");
        const close = iconButton("close", "채팅 멀티뷰 닫기");
        bar.append(nav, scaleGroup, addToggle, settingsToggle, close);

        // 시트: 채널 추가 또는 설정 하나를 조작 막대 아래에 띄워요.
        const sheet = el("div", "bccmv-sheet");
        sheet.id = PANEL_ID + "-sheet";
        const add = el("div", "bccmv-add"),
            label = el("label", "bccmv-visually-hidden", "채널 추가"),
            field = el("span", "bccmv-field"),
            input = el("input");
        input.id = PANEL_ID + "-input";
        label.htmlFor = input.id;
        input.type = "search";
        input.placeholder = "채널명 또는 채널 주소·ID";
        input.autocomplete = "off";
        input.maxLength = 200;
        field.append(icon("search"), input);
        const submit = button("검색", "채널 추가 또는 검색");
        submit.className = "bccmv-primary";
        const results = el("ul", "bccmv-results");
        results.setAttribute("aria-label", "채널 검색 결과");
        results.hidden = true;
        add.append(label, field, submit, results);
        const settings = el("div", "bccmv-settings");
        settings.setAttribute("role", "group");
        settings.setAttribute("aria-label", "채팅 멀티뷰 설정");
        const inputSwitch = button("", "채팅 입력창 표시");
        inputSwitch.className = "bccmv-switch";
        inputSwitch.setAttribute("role", "switch");
        inputSwitch.setAttribute("aria-describedby", PANEL_ID + "-input-help");
        const inputHelp = el("p", "bccmv-setting-help", TEXT.inputHelp);
        inputHelp.id = PANEL_ID + "-input-help";
        const sizeGroup = segmented("채팅 칸 크기"),
            cornerGroup = segmented("패널 위치");
        const moveHelp = el("p", "bccmv-setting-help", "채널 이름 줄을 끌어 패널을 원하는 곳으로 옮길 수도 있어요.");
        settings.append(
            settingRow("채팅 입력창", inputSwitch),
            inputHelp,
            settingRow("채팅 칸 크기", sizeGroup),
            settingRow("패널 위치", cornerGroup),
            moveHelp
        );
        sheet.append(add, settings);
        const message = el("p", "bccmv-message");
        message.setAttribute("role", "status");
        const empty = el("div", "bccmv-empty"),
            emptyText = el("p", "bccmv-empty-text"),
            emptyHint = el("p", "bccmv-empty-hint", TEXT.dropHint),
            reload = button("다시 불러오기", "채팅 멀티뷰 구성 다시 불러오기");
        empty.append(icon("chat"), emptyText, emptyHint);
        reload.hidden = true;
        const grid = el("ol", "bccmv-grid");
        grid.setAttribute("aria-label", "채팅 목록");
        const handle = el("span", "bccmv-resize");
        handle.setAttribute("aria-hidden", "true");
        handle.title = "끌어서 채팅 칸 크기 조절";
        const dropCover = el("div", "bccmv-drop-cover");
        dropCover.setAttribute("aria-hidden", "true");
        dropCover.append(
            el("span", "bccmv-drop-ready", "여기에 놓아 채팅 추가"),
            el("span", "bccmv-drop-blocked", "채팅은 최대 " + model.MAX_CHANNELS + "개까지 볼 수 있어요")
        );
        node.append(title, bar, sheet, empty, reload, grid, message, handle, dropCover);
        const target = {
            node,
            bar,
            count,
            addToggle,
            settingsToggle,
            sheet,
            add,
            settings,
            sheetName: "",
            input,
            submit,
            results,
            inputSwitch,
            scaleDown,
            scaleUp,
            scaleValue,
            message,
            messageTimer: 0,
            empty,
            emptyText,
            emptyHint,
            reload,
            grid,
            handle,
            nav,
            navPrev,
            navNext,
            navList,
            navStatus,
            navChips: new Map(),
            navFrame: 0,
            sizeButtons: [],
            cornerButtons: [],
            cells: new Map(),
            resultRows: new Map(),
            controller: null,
            busy: false,
            drag: null,
            displaySize: null,
            displayPosition: null,
            geometry: null,
        };
        for (const [name, text] of SIZE_OPTIONS) {
            const option = button(text, "채팅 칸 크기 " + text);
            option.dataset.size = name;
            option.addEventListener("click", (event) => {
                if (!event.isTrusted) return;
                const size = model.SIZE_PRESETS[name];
                target.displaySize = null;
                commit((base) => model.withChatSize(base, size.chatWidth, size.chatHeight), {
                    success: "채팅 칸 크기를 " + text + "로 바꿨어요.",
                });
            });
            sizeGroup.append(option);
            target.sizeButtons.push(option);
        }
        for (const [corner, text] of CORNER_OPTIONS) {
            const option = iconButton(corner, "패널 위치 " + text, "");
            option.title = text;
            option.dataset.corner = corner;
            option.addEventListener("click", (event) => {
                if (!event.isTrusted) return;
                target.displayPosition = null;
                commit((base) => model.withPosition(base, corner, model.DEFAULT_OFFSET, model.DEFAULT_OFFSET), {
                    success: "패널을 " + text + "에 두었어요.",
                });
            });
            cornerGroup.append(option);
            target.cornerButtons.push(option);
        }
        inputSwitch.addEventListener("click", (event) => {
            if (!event.isTrusted) return;
            const next = !config.input;
            commit((base) => model.withInput(base, next), { success: next ? TEXT.inputOn : TEXT.inputOff });
        });
        for (const [control, direction] of [
            [scaleDown, -1],
            [scaleUp, 1],
        ]) {
            control.addEventListener("click", (event) => {
                if (event.isTrusted) commit((base) => model.stepScale(base, direction));
            });
        }
        addToggle.addEventListener("click", () => setSheet(target, target.sheetName === "add" ? "" : "add"));
        settingsToggle.addEventListener("click", () =>
            setSheet(target, target.sheetName === "settings" ? "" : "settings")
        );
        close.addEventListener("click", () => closePanel(true));
        navPrev.addEventListener("click", () => stepCells(target, -1));
        navNext.addEventListener("click", () => stepCells(target, 1));
        grid.addEventListener("scroll", () => scheduleNav(target), { passive: true });
        reload.addEventListener("click", () => {
            if (panel === target && !ready) void loadConfig();
        });
        input.addEventListener("input", () => {
            cancelRequest(target);
            clearResults(target);
            syncSubmitLabel(target);
            notify("");
        });
        input.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.isComposing) return;
            event.preventDefault();
            if (event.isTrusted) requestAdd(target);
        });
        submit.addEventListener("click", (event) => {
            if (event.isTrusted) requestAdd(target);
        });
        node.addEventListener("keydown", onPanelKeydown);
        node.addEventListener("dragenter", (event) => onPanelDragOver(target, event));
        node.addEventListener("dragover", (event) => onPanelDragOver(target, event));
        node.addEventListener("dragleave", (event) => onPanelDragLeave(target, event));
        node.addEventListener("drop", (event) => onPanelDrop(target, event));
        bindDrag(target, handle, startResize);
        bindDrag(target, empty, startMove);
        panel = target;
        document.body.append(node);
        // 패널 크기가 CSS 상한(화면 크기)으로 바뀌는 경우까지 칸 배치를 다시 계산해요.
        if (typeof ResizeObserver === "function") {
            target.sizeObserver = new ResizeObserver(() => scheduleNav(target));
            target.sizeObserver.observe(node);
        }
        window.addEventListener("resize", onViewportResize);
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("focus", syncActiveCell);
        document.addEventListener("focusin", syncActiveCell);
        window.addEventListener("dragstart", onDocumentDragStart, true);
        window.addEventListener("dragend", onDocumentDragEnd, true);
        window.addEventListener("drop", onDocumentDragEnd);
        window.addEventListener("pointerdown", onDocumentDragEnd, true);
        if (!ready && loadError) void loadConfig();
        render();
        // 채팅이 있으면 초점을 헤더 버튼에 두어 조작 막대를 띄우지 않고, 비어 있으면 바로 검색할 수 있게 해요.
        if (sheetOf(target) === "add") input.focus();
    }
    function closePanel(restoreFocus = false) {
        const target = panel;
        if (!target) return;
        panel = null;
        cancelRequest(target);
        target.drag = null;
        target.sizeObserver?.disconnect();
        target.sizeObserver = null;
        if (target.navFrame) cancelAnimationFrame(target.navFrame);
        target.navFrame = 0;
        if (target.messageTimer) clearTimeout(target.messageTimer);
        target.messageTimer = 0;
        for (const cell of [...target.cells.values()]) removeCell(target, cell);
        target.node.remove();
        window.removeEventListener("resize", onViewportResize);
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", syncActiveCell);
        document.removeEventListener("focusin", syncActiveCell);
        window.removeEventListener("dragstart", onDocumentDragStart, true);
        window.removeEventListener("dragend", onDocumentDragEnd, true);
        window.removeEventListener("drop", onDocumentDragEnd);
        window.removeEventListener("pointerdown", onDocumentDragEnd, true);
        entry?.button.setAttribute("aria-expanded", "false");
        if (restoreFocus && entry?.button.isConnected) entry.button.focus();
    }
    function render() {
        entry?.button.setAttribute("aria-expanded", String(!!panel));
        const target = panel;
        if (!target) return;
        const total = config.channels.length;
        const sheet = sheetOf(target);
        target.count.textContent = ready ? total + "/" + model.MAX_CHANNELS : "";
        target.node.toggleAttribute("data-bccmv-empty", !ready || !total);
        if (sheet) target.node.setAttribute("data-bccmv-sheet", sheet);
        else target.node.removeAttribute("data-bccmv-sheet");
        target.add.hidden = sheet !== "add";
        target.settings.hidden = sheet !== "settings";
        target.sheet.hidden = !sheet;
        target.addToggle.setAttribute("aria-expanded", String(sheet === "add"));
        target.settingsToggle.setAttribute("aria-expanded", String(sheet === "settings"));
        // 안내는 열린 시트 안에, 시트가 없으면 패널 아래쪽에 띄워요. 확장 소유 요소만 옮겨요.
        const home = sheet ? target.sheet : target.node;
        if (target.message.parentElement !== home) home.append(target.message);
        const preset = model.sizePresetOf(config);
        for (const option of target.sizeButtons) {
            option.disabled = !ready;
            option.setAttribute("aria-pressed", String(ready && option.dataset.size === preset));
        }
        const docked = config.x === model.DEFAULT_OFFSET && config.y === model.DEFAULT_OFFSET;
        for (const option of target.cornerButtons) {
            option.disabled = !ready;
            option.setAttribute("aria-pressed", String(ready && docked && option.dataset.corner === config.corner));
        }
        target.inputSwitch.disabled = !ready;
        target.inputSwitch.setAttribute("aria-checked", String(ready && config.input));
        target.scaleValue.textContent = config.scale + "%";
        target.scaleDown.disabled = !ready || config.scale <= model.MIN_SCALE;
        target.scaleUp.disabled = !ready || config.scale >= model.MAX_SCALE;
        // 채팅 크기는 프레임 바깥 배율로만 바꿔 칸 문서의 배치·좌표 계산에 끼어들지 않아요.
        target.node.style.setProperty("--bccmv-scale", String(config.scale / 100));
        target.node.toggleAttribute("data-bccmv-scaled", config.scale !== 100);
        target.submit.disabled = !ready;
        target.results.setAttribute("aria-busy", String(target.busy));
        for (const { add, state, channel } of target.resultRows.values()) {
            const added = config.channels.some((item) => item.channelId === channel.channelId);
            const blocked = !added && !!addBlockReason(channel.channelId);
            state.textContent = added ? "추가됨" : blocked ? "가득 참" : "추가";
            add.disabled = !ready || added || blocked;
            add.setAttribute(
                "aria-label",
                added
                    ? channel.channelName + " 채팅, 이미 추가했어요"
                    : blocked
                      ? channel.channelName + " 채팅, " + errorText("limit")
                      : channel.channelName + " 채팅 추가"
            );
        }
        let emptyText = "";
        if (loadError) emptyText = loadError;
        else if (!ready) emptyText = TEXT.loading;
        else if (!total) emptyText = TEXT.empty;
        target.emptyText.textContent = emptyText;
        target.emptyHint.hidden = !ready || !!loadError;
        target.empty.hidden = !emptyText;
        target.reload.hidden = !loadError;
        renderCells(target);
        applyGeometry(target);
    }

    // ── 수명 ───────────────────────────────────────────────────────────────────
    function onRoute() {
        scheduleEntry();
    }
    function activate() {
        if (active) return;
        active = true;
        lifecycle++;
        ready = false;
        unsaved = false;
        loadError = "";
        storedRaw = undefined;
        config = model.createDefaultConfig();
        queue = Promise.resolve();
        observer = createMutationObserverSync({
            target: () => document.getElementById("header"),
            options: { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "id"] },
            shouldSchedule,
            schedule: scheduleEntry,
            onObserved: scheduleEntry,
            onBodyReady: scheduleEntry,
        });
        globalThis.chrome?.storage?.onChanged?.addListener(onStorageChange);
        removeRoute = startPageChangeDetection(onRoute);
        void loadConfig();
        scheduleEntry();
    }
    function deactivate() {
        if (!active) return;
        active = false;
        lifecycle++;
        loadVersion++;
        observer?.disconnectAll();
        observer = null;
        if (syncFrame) cancelAnimationFrame(syncFrame);
        syncFrame = 0;
        removeRoute?.();
        removeRoute = null;
        globalThis.chrome?.storage?.onChanged?.removeListener(onStorageChange);
        closePanel();
        removeEntry();
    }
    function start() {
        if (running || !globalThis.chrome?.storage?.local) return;
        running = true;
        injectStyleOnce(STYLE_ID, css());
        removeOptions = bindFeatureOptions((next) => {
            if (!running) return;
            if (next?.chatMultiviewEnabled === true) activate();
            else deactivate();
        });
    }
    function stop() {
        running = false;
        removeOptions?.();
        removeOptions = null;
        deactivate();
        document.getElementById(STYLE_ID)?.remove();
    }
    function css() {
        const font = '"BetterChzzk Pretendard",system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';
        const fontUrl = globalThis.chrome?.runtime?.getURL?.("vendor/fonts/PretendardVariable.woff2");
        return `
${fontUrl ? `/* Pretendard 1.3.9, SIL OFL 1.1: vendor/fonts/Pretendard.LICENSE.txt */\n@font-face{font-family:"BetterChzzk Pretendard";src:url("${fontUrl}") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}` : ""}
#${ID},#${PANEL_ID}{--bccmv-surface:var(--sem-color-surface-neutral-weaker,var(--Surface-Neutral-Base,#fff));--bccmv-weak:var(--sem-color-surface-neutral-weak,var(--Surface-Neutral-Strong,#f0f1f2));--bccmv-base:var(--sem-color-surface-neutral-base,#e1e1e5);--bccmv-bg:var(--sem-color-background-neutral-base,#fff);--bccmv-text:var(--sem-color-content-neutral-primary,var(--Content-Neutral-Primary,#0e0f10));--bccmv-strong:var(--sem-color-content-neutral-cool-strong,#2e3033);--bccmv-muted:var(--sem-color-content-neutral-cool-base,#4d4d4d);--bccmv-faint:var(--sem-color-content-neutral-cool-weak,#6d6e70);--bccmv-brand:var(--sem-color-content-brand-base,var(--Content-Brand-Strong,#168f5c));--bccmv-brand-fill:var(--sem-color-surface-brand-strongest-static,#00ffa3);--bccmv-brand-soft:var(--sem-color-surface-brand-alpha-weak,#1bb37326);--bccmv-on-brand:var(--sem-color-content-neutral-inverse-static,#0e0f10);--bccmv-line:var(--sem-color-border-neutral-alpha-weaker,#0000001a);--bccmv-line-strong:var(--sem-color-border-neutral-alpha-weak,#00000026);--bccmv-hover:var(--sem-color-surface-interaction-lighten-hovered,#0000000d);--bccmv-shadow:0 6px 6px 0 var(--sem-color-shadow-strong,#0000001a),0 6px 18px 6px var(--sem-color-shadow-base,#0000000d);--bccmv-live:#ff4545;--bccmv-border:var(--sem-color-border-neutral-base,var(--Border-Neutral-Weak,#cdd1d8))}
#${ID}{display:inline-flex;align-self:center;flex:none;margin-right:8px;font:14px/1.4 ${font}}
#${ID}>button{box-sizing:border-box;min-height:34px;margin:0;padding:6px 12px;border:1px solid var(--bccmv-border);border-radius:9999px;background:var(--bccmv-weak);color:var(--bccmv-text);font:inherit;font-size:14px;font-weight:650;line-height:1.4;white-space:nowrap;cursor:pointer}
#${ID}>button:hover{border-color:currentColor}
#${ID}>button:focus-visible{outline:2px solid var(--bccmv-brand);outline-offset:2px}
#${ID}>button[aria-expanded="true"]{color:var(--bccmv-brand);border-color:currentColor}
#${PANEL_ID}{position:fixed;left:${PANEL_MARGIN}px;top:${PANEL_MARGIN + BAR_SPACE}px;z-index:10010;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;max-width:calc(100vw - ${PANEL_MARGIN * 2}px);max-height:calc(100vh - ${PANEL_MARGIN * 2 + BAR_SPACE}px);padding:4px;border:0;border-radius:10px;box-shadow:var(--bccmv-shadow),0 0 0 1px var(--bccmv-line);background:var(--bccmv-surface);color:var(--bccmv-text);font:13px/1.5 ${font};text-align:left;--bccmv-warn:#f08c00}
#${PANEL_ID} *{box-sizing:border-box}
#${PANEL_ID} :is(h2,p,ol,ul){margin:0}
#${PANEL_ID} [hidden]{display:none!important}
#${PANEL_ID} button{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:28px;margin:0;padding:0 10px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;font-size:12px;font-weight:600;line-height:1.4;white-space:nowrap;cursor:pointer}
#${PANEL_ID} button:hover:not(:disabled){background:var(--bccmv-hover)}
#${PANEL_ID} button:disabled{opacity:.4;cursor:default}
#${PANEL_ID} :is(button,input):focus-visible{outline:2px solid var(--bccmv-brand);outline-offset:-2px}
#${PANEL_ID} .bccmv-icon{flex:none;width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
#${PANEL_ID} .bccmv-icon-fill{fill:currentColor;stroke:none}
#${PANEL_ID} .bccmv-icon-button{width:28px;padding:0;color:var(--bccmv-muted)}
#${PANEL_ID} .bccmv-icon-button:hover:not(:disabled){color:var(--bccmv-text)}
#${PANEL_ID} .bccmv-visually-hidden{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
#${PANEL_ID} .bccmv-bar{position:absolute;right:0;bottom:calc(100% + 6px);z-index:6;display:flex;align-items:center;gap:2px;max-width:100%;padding:3px;border-radius:10px;background:var(--bccmv-surface);box-shadow:var(--bccmv-shadow),0 0 0 1px var(--bccmv-line);opacity:0;pointer-events:none;transition:opacity .12s ease}
#${PANEL_ID}[data-corner$="left"] .bccmv-bar{right:auto;left:0}
#${PANEL_ID} .bccmv-bar::after{content:"";position:absolute;left:0;right:0;top:100%;height:8px}
#${PANEL_ID}:hover .bccmv-bar,#${PANEL_ID} .bccmv-bar:focus-within,#${PANEL_ID}[data-bccmv-sheet] .bccmv-bar,#${PANEL_ID}[data-bccmv-empty] .bccmv-bar{opacity:1;pointer-events:auto}
#${PANEL_ID} .bccmv-bar-button{padding:0 8px 0 6px;color:var(--bccmv-muted)}
#${PANEL_ID} .bccmv-bar-button:hover:not(:disabled){color:var(--bccmv-text)}
#${PANEL_ID} .bccmv-bar button[aria-expanded="true"]{background:var(--bccmv-base);color:var(--bccmv-text)}
#${PANEL_ID} .bccmv-count{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
#${PANEL_ID} .bccmv-count:empty{display:none}
#${PANEL_ID} .bccmv-group{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;background:var(--bccmv-weak)}
#${PANEL_ID} .bccmv-group button{min-height:24px;padding:0 10px;border-radius:6px;color:var(--bccmv-muted)}
#${PANEL_ID} .bccmv-group button[data-corner]{width:32px;padding:0}
#${PANEL_ID} .bccmv-group button[aria-pressed="true"]{background:var(--bccmv-base);color:var(--bccmv-text)}
#${PANEL_ID} .bccmv-scale button{width:24px;padding:0}
#${PANEL_ID} .bccmv-scale > .bccmv-icon{margin:0 2px 0 6px;color:var(--bccmv-faint)}
#${PANEL_ID} .bccmv-scale-value{min-width:38px;color:var(--bccmv-strong);font-size:12px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums}
#${PANEL_ID} .bccmv-nav{display:flex;align-items:center;gap:2px;min-width:0;margin-right:2px;padding-right:4px;border-right:1px solid var(--bccmv-line)}
#${PANEL_ID} .bccmv-nav-chips{display:flex;gap:2px;min-width:0;max-width:320px;overflow-x:auto;scrollbar-width:none}
#${PANEL_ID} .bccmv-nav-chip{display:block;flex:none;max-width:110px;min-height:24px;padding:0 10px;overflow:hidden;text-overflow:ellipsis;border-radius:9999px;color:var(--bccmv-muted);line-height:24px}
#${PANEL_ID} .bccmv-nav-chip[aria-current="true"]{background:var(--bccmv-base);color:var(--bccmv-text)}
#${PANEL_ID} .bccmv-sheet{position:absolute;top:4px;right:4px;z-index:5;display:flex;flex-direction:column;gap:8px;width:min(340px,calc(100% - 8px));max-height:calc(100% - 8px);padding:10px;overflow:auto;overscroll-behavior:contain;border-radius:10px;background:var(--bccmv-surface);box-shadow:var(--bccmv-shadow),0 0 0 1px var(--bccmv-line);scrollbar-width:thin}
#${PANEL_ID}[data-corner$="left"] .bccmv-sheet{right:auto;left:4px}
#${PANEL_ID}[data-bccmv-empty] .bccmv-sheet{position:static;width:auto;max-height:none;padding:4px;overflow:visible;background:transparent;box-shadow:none}
#${PANEL_ID} .bccmv-add{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:6px}
#${PANEL_ID} .bccmv-field{position:relative;display:block;min-width:0}
#${PANEL_ID} .bccmv-field .bccmv-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--bccmv-faint)}
#${PANEL_ID} input{width:100%;min-width:0;height:34px;margin:0;padding:0 10px 0 34px;border:1px solid transparent;border-radius:8px;background:var(--bccmv-weak);color:inherit;font:inherit;font-size:13px;outline:none}
#${PANEL_ID} input:focus{border-color:var(--bccmv-brand)}
#${PANEL_ID} input::placeholder{color:var(--bccmv-faint)}
#${PANEL_ID} .bccmv-primary{min-height:34px;padding:0 14px;background:var(--bccmv-brand-fill);color:var(--bccmv-on-brand);font-size:13px;font-weight:700}
#${PANEL_ID} .bccmv-primary:hover:not(:disabled){background:var(--sem-color-surface-brand-stronger-static,#00e693)}
#${PANEL_ID} .bccmv-results{grid-column:1/-1;margin:0;padding:0;list-style:none;max-height:260px;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin}
#${PANEL_ID} .bccmv-result{display:flex;align-items:center;justify-content:flex-start;gap:10px;width:100%;min-height:48px;padding:6px 8px;text-align:left}
#${PANEL_ID} .bccmv-result:disabled{opacity:1}
#${PANEL_ID} .bccmv-avatar{display:grid;place-items:center;flex:none;width:32px;height:32px;overflow:hidden;border-radius:50%;background:var(--bccmv-weak);color:var(--bccmv-muted);font-size:13px;font-weight:700}
#${PANEL_ID} .bccmv-avatar img{grid-area:1/1;display:block;width:100%;height:100%;object-fit:cover}
#${PANEL_ID} .bccmv-result-info{display:flex;flex:1;flex-direction:column;min-width:0}
#${PANEL_ID} :is(.bccmv-result-name,.bccmv-result-detail,.bccmv-cell-name){display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#${PANEL_ID} .bccmv-result-name{font-size:14px;font-weight:600}
#${PANEL_ID} .bccmv-result-detail{color:var(--bccmv-faint);font-size:12px;font-weight:400}
#${PANEL_ID} .bccmv-result-detail[data-live="1"]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:5px;border-radius:50%;background:var(--bccmv-live);vertical-align:1px}
#${PANEL_ID} .bccmv-result-state{flex:none;padding:4px 10px;border-radius:9999px;background:var(--bccmv-brand-soft);color:var(--bccmv-brand);font-size:12px;font-weight:700}
#${PANEL_ID} .bccmv-result:disabled .bccmv-result-state{background:var(--bccmv-weak);color:var(--bccmv-faint)}
#${PANEL_ID} .bccmv-results-hint{padding:6px 8px 2px;color:var(--bccmv-faint);font-size:12px}
#${PANEL_ID} .bccmv-settings{display:flex;flex-direction:column;gap:8px}
#${PANEL_ID} .bccmv-setting{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:30px}
#${PANEL_ID} .bccmv-setting-name{color:var(--bccmv-strong);font-size:13px;font-weight:600}
#${PANEL_ID} .bccmv-setting-help{margin-top:-6px;color:var(--bccmv-faint);font-size:12px}
#${PANEL_ID} .bccmv-switch{position:relative;flex:none;width:38px;min-height:22px;height:22px;padding:0;border-radius:9999px}
#${PANEL_ID} .bccmv-switch,#${PANEL_ID} .bccmv-switch:hover:not(:disabled){background:var(--bccmv-base)}
#${PANEL_ID} .bccmv-switch[aria-checked="true"],#${PANEL_ID} .bccmv-switch[aria-checked="true"]:hover:not(:disabled){background:var(--bccmv-brand-fill)}
#${PANEL_ID} .bccmv-switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px #0000004d;transition:transform .12s ease}
#${PANEL_ID} .bccmv-switch[aria-checked="true"]::after{transform:translateX(16px)}
#${PANEL_ID} .bccmv-message{color:var(--bccmv-muted);font-size:12px;overflow-wrap:anywhere}
#${PANEL_ID} .bccmv-message:empty{display:none}
#${PANEL_ID} > .bccmv-message{position:absolute;left:50%;bottom:10px;z-index:6;max-width:calc(100% - 24px);padding:5px 12px;border-radius:9999px;transform:translateX(-50%);background:var(--bccmv-surface);box-shadow:var(--bccmv-shadow),0 0 0 1px var(--bccmv-line);color:var(--bccmv-text);text-align:center;pointer-events:none}
#${PANEL_ID} .bccmv-empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:100px;padding:16px;border:1px dashed var(--bccmv-line-strong);border-radius:8px;color:var(--bccmv-muted);text-align:center}
#${PANEL_ID} .bccmv-empty .bccmv-icon{width:28px;height:28px;color:var(--bccmv-faint);stroke-width:1.3}
#${PANEL_ID} .bccmv-empty-text{font-size:13px;font-weight:600;color:var(--bccmv-strong)}
#${PANEL_ID} .bccmv-empty-hint{font-size:12px;color:var(--bccmv-faint)}
#${PANEL_ID} .bccmv-grid{flex:1;display:grid;grid-template-columns:repeat(var(--bccmv-columns,1),minmax(var(--bccmv-cell-width,${LIST_CELL_MIN.width}px),1fr));grid-template-rows:repeat(var(--bccmv-rows,1),minmax(var(--bccmv-cell-height,${LIST_CELL_MIN.height}px),1fr));gap:${GRID_GAP}px;min-height:0;padding:0;list-style:none;overflow:auto;overscroll-behavior:contain;border-radius:6px}
#${PANEL_ID} .bccmv-grid:empty{display:none}
#${PANEL_ID} .bccmv-grid::-webkit-scrollbar{width:10px;height:10px}
#${PANEL_ID} .bccmv-grid::-webkit-scrollbar-track{background:var(--bccmv-weak);border-radius:6px}
#${PANEL_ID} .bccmv-grid::-webkit-scrollbar-thumb{background:var(--bccmv-faint);border:2px solid var(--bccmv-weak);border-radius:6px}
#${PANEL_ID} .bccmv-cell{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden;border:1px solid var(--bccmv-line);border-radius:6px;background:var(--bccmv-bg)}
#${PANEL_ID} .bccmv-cell[data-bccmv-active]{border-color:var(--bccmv-brand)}
#${PANEL_ID} .bccmv-cell-head{display:flex;flex:none;align-items:center;gap:4px;height:26px;padding:0 3px 0 8px;border-bottom:1px solid var(--bccmv-line);cursor:grab;user-select:none;touch-action:none}
#${PANEL_ID} .bccmv-empty{cursor:grab}
#${PANEL_ID}[data-bccmv-moving],#${PANEL_ID}[data-bccmv-moving] *{cursor:grabbing!important;user-select:none}
#${PANEL_ID} .bccmv-cell-name{flex:0 1 auto;min-width:0;font-size:12px;font-weight:700}
#${PANEL_ID} .bccmv-cell-note{flex:none;display:inline-grid;place-items:center;width:14px;height:14px;overflow:hidden;border-radius:50%;background:var(--bccmv-warn);font-size:0;line-height:0}
#${PANEL_ID} .bccmv-cell-note::before{content:"!";color:#fff;font-size:10px;font-weight:800;line-height:1}
#${PANEL_ID} .bccmv-cell-actions{display:flex;flex:none;margin-left:auto;opacity:0;transition:opacity .12s ease}
#${PANEL_ID} .bccmv-cell:hover .bccmv-cell-actions,#${PANEL_ID} .bccmv-cell-actions:focus-within{opacity:1}
#${PANEL_ID} .bccmv-cell-actions .bccmv-icon-button{width:22px;min-height:22px;border-radius:5px}
#${PANEL_ID} .bccmv-cell-actions .bccmv-icon{width:14px;height:14px}
#${PANEL_ID} .bccmv-cell-body{position:relative;flex:1;min-height:0;overflow:hidden}
#${PANEL_ID} .bccmv-frame{display:block;width:100%;height:100%;border:0;background:transparent}
#${PANEL_ID}[data-bccmv-scaled] .bccmv-frame{width:calc(100% / var(--bccmv-scale));height:calc(100% / var(--bccmv-scale));transform:scale(var(--bccmv-scale));transform-origin:0 0}
#${PANEL_ID} .bccmv-cell:not([data-state="ready"]):not([data-state="unverified"]) .bccmv-frame{visibility:hidden}
#${PANEL_ID} .bccmv-cell-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px;background:var(--bccmv-bg);color:var(--bccmv-muted);font-size:12px;text-align:center;overflow-wrap:anywhere}
#${PANEL_ID} .bccmv-cell-overlay button{min-height:28px;padding:0 12px;background:var(--bccmv-weak);color:var(--bccmv-text)}
#${PANEL_ID} .bccmv-resize{position:absolute;top:-4px;left:-4px;z-index:7;width:16px;height:16px;cursor:nwse-resize;touch-action:none;opacity:0;transition:opacity .12s ease}
#${PANEL_ID}[data-corner$="left"] .bccmv-resize{left:auto;right:-4px}
#${PANEL_ID}[data-corner^="top"] .bccmv-resize{top:auto;bottom:-4px}
#${PANEL_ID}:is([data-corner="bottom-left"],[data-corner="top-right"]) .bccmv-resize{cursor:nesw-resize}
#${PANEL_ID}:hover .bccmv-resize,#${PANEL_ID}[data-bccmv-resizing] .bccmv-resize{opacity:1}
#${PANEL_ID} .bccmv-resize::before{content:"";position:absolute;top:4px;left:4px;width:8px;height:8px;border-top:2px solid var(--bccmv-faint);border-left:2px solid var(--bccmv-faint);border-top-left-radius:3px}
#${PANEL_ID}[data-corner$="left"] .bccmv-resize::before{left:auto;right:4px;border-left:0;border-right:2px solid var(--bccmv-faint);border-radius:0 3px 0 0}
#${PANEL_ID}[data-corner^="top"] .bccmv-resize::before{top:auto;bottom:4px;border-top:0;border-bottom:2px solid var(--bccmv-faint);border-radius:0 0 0 3px}
#${PANEL_ID}[data-corner="top-left"] .bccmv-resize::before{border-radius:0 0 3px 0}
#${PANEL_ID}[data-bccmv-resizing]{user-select:none}
#${PANEL_ID}:is([data-bccmv-resizing],[data-bccmv-moving],[data-bccmv-dragging]) .bccmv-frame{pointer-events:none}
#${PANEL_ID} .bccmv-drop-cover{display:none;position:absolute;inset:4px;z-index:5;align-items:center;justify-content:center;border:2px dashed var(--bccmv-brand);border-radius:8px;background:color-mix(in srgb,var(--bccmv-surface) 82%,transparent);color:var(--bccmv-brand);font-size:15px;font-weight:700;pointer-events:none}
#${PANEL_ID}[data-bccmv-drop] .bccmv-drop-cover{display:flex}
#${PANEL_ID}[data-bccmv-drop="blocked"] .bccmv-drop-cover{border-color:var(--bccmv-line-strong);color:var(--bccmv-muted)}
#${PANEL_ID}:not([data-bccmv-drop="ready"]) .bccmv-drop-ready,#${PANEL_ID}:not([data-bccmv-drop="blocked"]) .bccmv-drop-blocked{display:none}
@media (hover:none){#${PANEL_ID} .bccmv-bar{opacity:1;pointer-events:auto}#${PANEL_ID} :is(.bccmv-cell-actions,.bccmv-resize){opacity:1}}
@media (prefers-reduced-motion:reduce){#${PANEL_ID} *,#${PANEL_ID} *::after{transition:none!important}}
`;
    }
    window.addEventListener("pagehide", stop);
    window.addEventListener("pageshow", start);
    onReady(start);
})();
