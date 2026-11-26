(() => {
    "use strict";
    const list = document.getElementById("native-list");
    const sentinel = list.firstElementChild;
    const vod = location.pathname.startsWith("/video/");
    if (vod) {
        document.querySelector("aside").id = "vod-aside";
        list.className = "_list_tdctj_127";
        sentinel.className = "_list_bottom_tdctj_154";
    }
    const roles = { broadcaster: "방송자", manager: "운영자", partner: "파트너", challenger: "챌린저" };
    const roomRoleCodes = { broadcaster: "streamer", manager: "streaming_chat_manager" };
    const normalTexts = ["안녕하세요!", "오늘 방송 재밌네요", "오 좋네요", "ㅋㅋㅋㅋ", "반갑습니다"];
    const nodes = new Map();
    const messagesForNodes = new WeakMap();
    const state = (value, dispatch = () => {}) => ({ memoizedState: value, queue: { dispatch }, next: null });
    let messages = [];
    let metrics = null;
    let frame = 0;
    let observer = null;
    let panelObserver = null;
    let targetNode = null;
    let running = false;
    let stopRequested = false;
    let hasRun = false;
    let lastResult = null;
    let startedAt = 0;
    const startButton = document.getElementById("start-chat");
    const stopButton = document.getElementById("stop-chat");
    const speedSelect = document.getElementById("chat-speed");
    const roleSelect = document.getElementById("target-role");
    const NEXT_RUN_KEY = "cheese-spanner:chat-stress-next-run";
    const mounted = new WeakSet();
    const filtered = new WeakSet();
    const insertedAt = new WeakMap();
    const limit = state(Math.ceil(list.clientHeight / 31), (value) => {
        queueMicrotask(() => {
            limit.memoizedState = value;
            render();
        });
    });
    const baseLimit = limit.memoizedState;
    const paused = state(false);
    const backlog = state(messages);
    const rendered = state([]);
    const ref = { memoizedState: { current: list }, next: null };
    const effect = { memoizedState: { deps: [], create: () => {} }, next: null };
    const hooks = [limit, paused, backlog, rendered, ref, effect];
    hooks.forEach((hook, index) => (hook.next = hooks[index + 1] || null));
    const root = { tag: 3, stateNode: {} };
    root.stateNode.current = root;
    // Synthetic native-list ownership, matching the existing list-layout fixture's measured hook contract.
    list.__reactFiber$stress = { tag: 5, stateNode: list, return: { tag: 0, memoizedState: hooks[0], return: root } };

    function createRow(message) {
        const node = document.createElement("div");
        node.className = "_item_1li40_7";
        node.dataset.chatId = message.key;
        const container = document.createElement("div");
        container.className = "_chatting_message_jbnq0_1";
        const author = document.createElement("button");
        author.className = "_nickname_jbnq0_33";
        author.type = "button";
        author.setAttribute("aria-haspopup", "true");
        author.setAttribute("aria-expanded", "false");
        const name = document.createElement("span");
        name.className = "_nickname_1pcsq_1";
        name.textContent = message.target ? "검증 계정" : "시청자";
        const user = message.target ? "fixture-target" : "fixture-viewer";
        const grade = message.role === "partner" || message.role === "challenger" ? message.role.toUpperCase() : null;
        // The MAIN bridge reads the same message that this fixture renders into the row.
        const chatMessage = {
            key: message.key,
            user,
            time: message.time,
            status: "NORMAL",
            originalContent: message.text,
            profile: {
                nickname: name.textContent,
                userIdHash: user,
                userRoleCode: roomRoleCodes[message.role] || "common_user",
                verifiedMark: Boolean(grade),
                verifiedMarkType: grade,
            },
        };
        container.__reactProps$stress = { children: { props: { chatMessage } } };
        author.append(name);
        container.append(author);
        if (message.role === "broadcaster" || message.role === "manager") {
            const badge = document.createElement("img");
            badge.alt = message.role === "broadcaster" ? "스트리머" : "채팅 운영자";
            badge.src =
                "data:image/svg+xml," +
                encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14"><circle cx="7" cy="7" r="6" fill="#00e5a8"/></svg>'
                );
            container.append(badge);
        } else if (message.role) {
            const badge = document.createElement("i");
            badge.className = `_mark_1pcsq_81 _is_${message.role}_1pcsq_${message.role === "partner" ? 81 : 84}`;
            name.append(badge);
        }
        const text = document.createElement("span");
        text.className = "_text_jbnq0_1";
        text.textContent = message.text;
        container.append(text);
        node.append(container);
        messagesForNodes.set(node, message);
        if (message.target) targetNode = node;
        return node;
    }

    function render() {
        backlog.memoizedState = messages;
        rendered.memoizedState = messages.slice(0, limit.memoizedState);
        effect.memoizedState.deps = [messages, limit.memoizedState, paused.memoizedState];
        const visibleKeys = new Set(rendered.memoizedState.map((message) => message.key));
        for (const node of [...list.children]) {
            if (node !== sentinel && !visibleKeys.has(node.dataset.chatId)) node.remove();
        }
        let previous = sentinel;
        for (const message of rendered.memoizedState) {
            let node = nodes.get(message.key);
            if (!node) {
                node = createRow(message);
                nodes.set(message.key, node);
            }
            if (metrics && !message.warmup && !mounted.has(node)) {
                mounted.add(node);
                metrics.mountedMessages++;
                insertedAt.set(node, performance.now());
                if (message.target) metrics.targetMountedAt = performance.now();
            }
            if (previous.nextElementSibling !== node) previous.after(node);
            previous = node;
        }
        const retained = new Set(messages.map((message) => message.key));
        for (const key of nodes.keys()) if (!retained.has(key)) nodes.delete(key);
        if (metrics && targetNode && !targetNode.isConnected && metrics.targetEvictedAt === null)
            metrics.targetEvictedAt = performance.now();
    }

    function push(batch) {
        const receivedAt = Date.now();
        for (const message of batch) message.time = receivedAt;
        messages = [...batch].reverse().concat(messages).slice(0, 500);
        render();
        const raw = document.getElementById("raw");
        raw.replaceChildren(
            ...messages.slice(0, 20).map((message) => {
                const line = document.createElement("div");
                line.className = `raw-line${message.target ? " raw-line--target" : message.blocked ? " raw-line--blocked" : ""}`;
                const label = message.target ? `${roles[message.role]} · 예외` : message.blocked ? "숨김 대상" : "일반";
                line.textContent = `[${label}] ${message.text}`;
                return line;
            })
        );
    }

    function panelRows() {
        return [...document.querySelectorAll(".bcct-moderator-row")];
    }

    function checkCollection() {
        if (!metrics) return;
        const rows = panelRows();
        const matching = rows.filter((row) => row.textContent.includes(metrics.targetText));
        if (matching.length && metrics.collectedAt === null) metrics.collectedAt = performance.now();
        metrics.maximumTargetCopies = Math.max(metrics.maximumTargetCopies, matching.length);
        metrics.unexpectedCollected = Math.max(metrics.unexpectedCollected, rows.length - matching.length);
    }

    function checkFrame(now) {
        if (!metrics) return;
        metrics.frames++;
        if (metrics.lastFrameAt !== null)
            metrics.maximumFrameGapMs = Math.max(metrics.maximumFrameGapMs, now - metrics.lastFrameAt);
        metrics.lastFrameAt = now;
        let exposed = false;
        let wronglyHidden = false;
        for (const node of list.children) {
            const message = messagesForNodes.get(node);
            if (!message || message.warmup) continue;
            const hidden = getComputedStyle(node).display === "none" || node.getClientRects().length === 0;
            metrics.rowFrameChecks++;
            if (message.target) {
                if (hidden) metrics.targetHiddenFrames++;
                else metrics.targetVisibleFrames++;
            } else if (message.blocked) {
                if (!hidden) {
                    exposed = true;
                    metrics.blockedExposedRows.add(message.key);
                }
            } else if (hidden) {
                wronglyHidden = true;
                metrics.normalHiddenRows.add(message.key);
            } else {
                metrics.normalVisibleRows.add(message.key);
            }
        }
        if (exposed) metrics.blockedExposedFrames++;
        if (wronglyHidden) metrics.normalHiddenFrames++;
        checkCollection();
        document.getElementById("sent").textContent = metrics.sent.toLocaleString() + "개";
        document.getElementById("exposed").textContent = metrics.blockedExposedFrames + "회";
        document.getElementById("wrongly-hidden").textContent = metrics.normalHiddenFrames + "회";
        document.getElementById("collected").textContent = metrics.collectedAt !== null ? "1개 확인" : "대기";
        const elapsed = performance.now() - startedAt;
        if (elapsed > 0)
            document.getElementById("speed").textContent =
                Math.round((metrics.sent * 1000) / elapsed).toLocaleString() + "개/초";
        frame = requestAnimationFrame(checkFrame);
    }

    async function runScenario({ total, batchSize, intervalMs, role, negativeControl = false }) {
        const targetIndex = Math.floor(total / 2);
        const targetText = `숨김검증 · 대상 한 줄 #${targetIndex}`;
        metrics = {
            total,
            batchSize,
            intervalMs,
            role,
            negativeControl,
            sent: 0,
            normalSent: 0,
            blockedSent: 0,
            mountedMessages: 0,
            frames: 0,
            rowFrameChecks: 0,
            targetText,
            targetMountedAt: null,
            targetEvictedAt: null,
            collectedAt: null,
            maximumTargetCopies: 0,
            unexpectedCollected: 0,
            blockedExposedFrames: 0,
            blockedExposedRows: new Set(),
            normalHiddenFrames: 0,
            normalHiddenRows: new Set(),
            normalVisibleRows: new Set(),
            normalFilterWrites: 0,
            targetHiddenFrames: 0,
            targetVisibleFrames: 0,
            targetFilterWrites: 0,
            latencies: [],
            maximumFrameGapMs: 0,
            lastFrameAt: null,
        };
        document.getElementById("description").textContent =
            `일반 채팅과 숨김 대상을 1:1로 섞고, ${targetIndex + 1}번째에 ${roles[role]} 한 줄을 넣습니다. 이 대상도 ‘숨김검증’을 포함하지만 예외로 남아야 합니다.`;
        observer = new MutationObserver((records) => {
            for (const record of records) {
                const node = record.target;
                const message = messagesForNodes.get(node);
                if (!message || message.warmup) continue;
                const hidden = node.getAttribute("data-bcct-keyword-filtered") === "1";
                if (message.target && (hidden || record.oldValue === "1")) metrics.targetFilterWrites++;
                if (!message.blocked && (hidden || record.oldValue === "1")) metrics.normalFilterWrites++;
                if (hidden && message.blocked && !message.target && !filtered.has(node)) {
                    filtered.add(node);
                    metrics.latencies.push(performance.now() - insertedAt.get(node));
                }
            }
        });
        observer.observe(list, {
            attributes: true,
            attributeFilter: ["data-bcct-keyword-filtered"],
            attributeOldValue: true,
            subtree: true,
        });
        const panel = document.querySelector(".bcct-moderator-box");
        if (panel) {
            panelObserver = new MutationObserver(checkCollection);
            panelObserver.observe(panel, { childList: true, characterData: true, subtree: true });
        }
        frame = requestAnimationFrame(checkFrame);
        const started = performance.now();
        startedAt = started;
        let nextBatchAt = started;
        while (metrics.sent < total && !stopRequested) {
            const batch = [];
            for (let index = 0; index < batchSize && metrics.sent < total; index++) {
                const number = metrics.sent++;
                const target = number === targetIndex;
                const blocked = target || number % 2 === 0;
                if (!target) {
                    if (blocked) metrics.blockedSent++;
                    else metrics.normalSent++;
                }
                batch.push({
                    key: `m-${number}`,
                    target,
                    blocked,
                    role: target ? role : "",
                    text: target
                        ? targetText
                        : blocked
                          ? `숨김검증 · 숨김 대상 메시지 #${number}`
                          : `${normalTexts[Math.floor(number / 2) % normalTexts.length]} #${number}`,
                });
            }
            push(batch);
            nextBatchAt += intervalMs;
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextBatchAt - performance.now())));
        }
        const inputEnded = performance.now();
        // Observe beyond the collection throttle and native replenishment after the last input.
        await new Promise((resolve) => setTimeout(resolve, 500));
        cancelAnimationFrame(frame);
        observer.disconnect();
        panelObserver?.disconnect();
        checkCollection();
        const latencies = metrics.latencies.sort((a, b) => a - b);
        const round = (value) => Number(value.toFixed(2));
        const result = {
            role,
            batchSize,
            intervalMs,
            path: location.pathname,
            total: metrics.sent,
            plannedTotal: total,
            stopped: stopRequested,
            targetIndex,
            nominalPerSecond: (batchSize * 1000) / intervalMs,
            actualPerSecond: round((metrics.sent * 1000) / (inputEnded - started)),
            inputDurationMs: round(inputEnded - started),
            mountedMessages: metrics.mountedMessages,
            normalSent: metrics.normalSent,
            blockedSent: metrics.blockedSent,
            frames: metrics.frames,
            rowFrameChecks: metrics.rowFrameChecks,
            blockedExposedFrames: metrics.blockedExposedFrames,
            blockedExposedRows: metrics.blockedExposedRows.size,
            normalHiddenFrames: metrics.normalHiddenFrames,
            normalHiddenRows: metrics.normalHiddenRows.size,
            normalVisibleRows: metrics.normalVisibleRows.size,
            normalFilterWrites: metrics.normalFilterWrites,
            targetHiddenFrames: metrics.targetHiddenFrames,
            targetVisibleFrames: metrics.targetVisibleFrames,
            targetFilterWrites: metrics.targetFilterWrites,
            targetMounted: metrics.targetMountedAt !== null,
            targetEvicted: metrics.targetEvictedAt !== null,
            targetCopies: panelRows().filter((row) => row.textContent.includes(targetText)).length,
            maximumTargetCopies: metrics.maximumTargetCopies,
            unexpectedCollected: metrics.unexpectedCollected,
            targetCollectionDelayMs:
                metrics.collectedAt === null ? null : round(metrics.collectedAt - metrics.targetMountedAt),
            targetMountedDurationMs:
                metrics.targetEvictedAt === null ? null : round(metrics.targetEvictedAt - metrics.targetMountedAt),
            measuredHides: latencies.length,
            medianHideMs: latencies.length ? round(latencies[Math.floor(latencies.length / 2)]) : null,
            p95HideMs: latencies.length ? round(latencies[Math.floor(latencies.length * 0.95)]) : null,
            maximumFrameGapMs: round(metrics.maximumFrameGapMs),
            finalNativeLimit: limit.memoizedState,
            negativeControl,
        };
        document.getElementById("speed").textContent = Math.round(result.actualPerSecond).toLocaleString() + "개/초";
        document.getElementById("collected").textContent = result.targetCopies
            ? `${result.targetCopies}개 확인`
            : result.targetMounted
              ? "0개 · 미수집"
              : result.stopped
                ? "등장 전 중지"
                : "표시 전 밀림";
        document.getElementById("status").textContent =
            `${result.stopped ? "재현 중지" : "재현 완료"} · 일반 ${result.normalSent.toLocaleString()}개 + 숨김 대상 ${result.blockedSent.toLocaleString()}개 · 모아보기 수집 ${result.targetCopies}개 · 실제 ${Math.round(result.actualPerSecond).toLocaleString()}개/초. ‘채팅 띄우기’로 새로 시작합니다.`;
        return result;
    }

    async function run(config) {
        if (running) throw new Error("A chat reproduction is already running");
        running = true;
        hasRun = true;
        stopRequested = false;
        lastResult = null;
        startButton.disabled = true;
        stopButton.disabled = false;
        speedSelect.disabled = true;
        roleSelect.disabled = true;
        document.getElementById("status").textContent =
            "일반 채팅과 숨김 대상을 섞어 띄우고 있습니다. 가운데에 모아보기 대상 한 줄이 등장합니다.";
        try {
            lastResult = await runScenario(config);
            return lastResult;
        } finally {
            cancelAnimationFrame(frame);
            observer?.disconnect();
            panelObserver?.disconnect();
            running = false;
            startButton.disabled = false;
            stopButton.disabled = true;
            speedSelect.disabled = false;
            roleSelect.disabled = false;
        }
    }

    function startManual(config) {
        const trigger = document.querySelector(".bcct-moderator-trigger");
        if (trigger && trigger.getAttribute("aria-expanded") !== "true") trigger.click();
        run(config).catch(() => {
            document.getElementById("status").textContent =
                "재현 중 오류가 발생했습니다. 다시 눌러 새로 시작해 주세요.";
        });
    }

    function manualConfig(rate, role) {
        const batchSize = Math.min(10, rate / 50);
        return { total: rate * 8, batchSize, intervalMs: (batchSize * 1000) / rate, role };
    }

    startButton.addEventListener("click", () => {
        if (running || startButton.disabled) return;
        const rate = Number(speedSelect.value);
        const config = manualConfig(rate, roleSelect.value);
        if (hasRun) {
            // Reload only this controlled fixture so collection records and row identities start fresh.
            sessionStorage.setItem(NEXT_RUN_KEY, JSON.stringify(config));
            location.reload();
        } else startManual(config);
    });
    stopButton.addEventListener("click", () => {
        stopRequested = true;
        stopButton.disabled = true;
        document.getElementById("status").textContent = "채팅을 멈추고 마지막 결과를 확인하고 있습니다.";
    });

    push(
        Array.from({ length: 500 }, (_, index) => ({
            key: `warm-${index}`,
            warmup: true,
            blocked: index % 2 === 0,
            text: index % 2 === 0 ? `숨김검증 · 준비 #${index}` : `일반 채팅 · 준비 #${index}`,
            role: "",
        }))
    );
    window.CheeseSpannerChatStress = {
        run,
        get running() {
            return running;
        },
        get lastResult() {
            return lastResult;
        },
        ready: () => {
            const rows = [...list.children].filter((node) => messagesForNodes.has(node));
            return (
                rows.filter((node) => !messagesForNodes.get(node).blocked).length >= baseLimit &&
                rows.every(
                    (node) => node.hasAttribute("data-bcct-keyword-filtered") === messagesForNodes.get(node).blocked
                )
            );
        },
    };
    const preparingAt = performance.now();
    function enableControls() {
        if (running || hasRun) return;
        if (!window.CheeseSpannerChatStress.ready()) {
            if (performance.now() - preparingAt < 20000) setTimeout(enableControls, 50);
            else
                document.getElementById("status").textContent =
                    "확장 준비를 확인하지 못했습니다. 테스트 창을 다시 열어 주세요.";
            return;
        }
        startButton.disabled = false;
        document.getElementById("sent").textContent = "0개";
        document.getElementById("status").textContent =
            "준비됐습니다. ‘채팅 띄우기’를 누르면 8초 분량의 채팅이 올라옵니다. 실제 방송으로 전송되지 않습니다.";
        const next = sessionStorage.getItem(NEXT_RUN_KEY);
        sessionStorage.removeItem(NEXT_RUN_KEY);
        if (next) {
            try {
                const config = JSON.parse(next);
                const rate = (config.batchSize * 1000) / config.intervalMs;
                if (![100, 500, 2000, 5000].includes(rate) || !Object.hasOwn(roles, config.role)) return;
                speedSelect.value = String(rate);
                roleSelect.value = config.role;
                startManual(manualConfig(rate, config.role));
            } catch (_) {
                // An interrupted or outdated run does not prevent starting a new one.
            }
        }
    }
    enableControls();
})();
