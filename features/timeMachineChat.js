/** 뒤로 감은 라이브에서 수신 시각을 확인한 일반 채팅만 본영상 시간에 맞춰 표시한다. */
(() => {
    "use strict";
    if (window.top !== window) return;
    const utils = window.CheeseSpanner.utils;
    const LOG = "aside#aside-chatting [role='log']";
    const OVERLAY = "cheese-spanner-time-machine-chat";
    const STYLE = OVERLAY + "-style";
    const MASK = "data-bctm-chat-masked";
    const CURRENT = "data-bctm-chat-current";
    const POSITION = "data-bctm-chat-position";
    const SAMPLE = "data-bctm-chat-sample";
    const MAX_ROWS = 128;
    const MAX_VISIBLE = 24;
    const TTL_MS = 120000;
    const CSS = `
        [${MASK}] ${LOG}{clip-path:inset(50%)!important;pointer-events:none!important;}
        [${MASK}] ${LOG}:not([${CURRENT}]){visibility:hidden!important;}
        [${POSITION}]{position:relative!important;}
        #${OVERLAY}{position:absolute;z-index:1;box-sizing:border-box;overflow:auto;
            background:var(--bct-surface);color:var(--bct-text);padding:12px;
            white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;}
    `;
    const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
    const mediaEvents = ["timeupdate", "seeking", "seeked", "ratechange", "pause", "progress", "emptied", "loadstart"];
    let options = {};
    let keywords = [];
    let session = null;
    let view = null;
    let watchLog = null;
    let watchedLog = null;
    let timer = 0;
    let removeRoute = null;
    let channel = currentChannel();
    // No chat is observed while off. This single flag also catches A -> B -> A
    // while disabled; the immutable navigation entry covers a late script load.
    const navigationUrl = performance.getEntriesByType?.("navigation")[0]?.name;
    let uncertainRoute = Boolean(navigationUrl && new URL(navigationUrl).pathname !== location.pathname);
    function noteIdleNavigation() {
        if (!timer && currentChannel() !== channel) uncertainRoute = true;
    }
    window.addEventListener("cheese-spanner:routechange", noteIdleNavigation, true);
    window.addEventListener("popstate", noteIdleNavigation, true);

    // Keep a bounded, document-local ownership check across OFF and BFCache.
    // Eviction could let an old source acquire a different channel after remount.
    const sourceOwners = new Map();
    const MAX_SOURCES = 32;
    const unidentifiedVideos = new WeakSet();
    let suspended = false;

    function restoreLog() {
        if (!view) return;
        view.overlay.remove();
        document.documentElement.removeAttribute(MASK);
        view.log.removeAttribute(CURRENT);
        if (!view.wasInert) view.log.inert = false;
        if (view.positioned) view.parent.removeAttribute(POSITION);
        view = null;
    }

    function display(log, text) {
        const parent = log.parentElement;
        if (!parent) return;
        if (view && (view.log !== log || view.parent !== parent)) restoreLog();
        if (!view) {
            utils.ensureUiTheme?.();
            utils.injectStyleOnce(STYLE, CSS);
            const overlay = document.createElement("div");
            overlay.id = OVERLAY;
            overlay.setAttribute("role", "region");
            overlay.setAttribute("aria-label", "타임머신 채팅");
            const positioned = getComputedStyle(parent).position === "static";
            if (positioned) parent.setAttribute(POSITION, "");
            view = { log, overlay, parent, positioned, wasInert: log.inert };
            document.documentElement.setAttribute(MASK, "");
            log.setAttribute(CURRENT, "");
            log.inert = true;
            log.after(overlay);
        }
        const overlay = view.overlay;
        overlay.style.left = log.offsetLeft + "px";
        overlay.style.top = log.offsetTop + "px";
        overlay.style.width = log.offsetWidth + "px";
        overlay.style.height = log.offsetHeight + "px";
        if (overlay.textContent !== text) {
            overlay.textContent = text;
            overlay.scrollTop = overlay.scrollHeight;
        }
    }

    function sample(log) {
        log.removeAttribute(SAMPLE);
        try {
            log.dispatchEvent(new CustomEvent("cheese-spanner:time-machine-chat-sample", { bubbles: true }));
            const raw = log.getAttribute(SAMPLE);
            if (!raw || raw.length > 256000) return null;
            const [owner, rows] = JSON.parse(raw);
            if (!Number.isSafeInteger(owner) || owner <= 0 || !Array.isArray(rows) || rows.length > MAX_ROWS)
                return null;
            return { owner, rows };
        } catch {
            return null;
        } finally {
            log.removeAttribute(SAMPLE);
        }
    }

    function keywordHidden(text) {
        const normalized = text.trim().replace(/\s+/g, " ").normalize("NFC").toLowerCase();
        return keywords.some(({ phrase, matchMode }) =>
            matchMode === "exact" ? normalized === phrase : normalized.includes(phrase)
        );
    }

    function getEdge(video) {
        try {
            if (video.readyState < 2 || !video.currentSrc || !video.seekable.length) return null;
            // A seek into a gap can briefly expose the requested cursor before the
            // player chooses the closest buffered position. Wait for its final cursor.
            const cursor = video.currentTime;
            for (let i = 0; i < video.seekable.length; i++) {
                if (cursor >= video.seekable.start(i) && cursor <= video.seekable.end(i)) {
                    const edge = video.seekable.end(video.seekable.length - 1);
                    return Number.isFinite(edge) && edge > video.seekable.start(i) ? edge : null;
                }
            }
            return null;
        } catch {
            return null;
        }
    }

    // Keep times only for rows whose text and NORMAL state can still be verified.
    // A row redisplayed by scrolling must not be stamped as a new arrival.
    function updateRows(state, rows, edge, now, mono) {
        const fresh = new Map();
        const received = [];
        for (const row of rows) {
            if (!Array.isArray(row) || (row.length !== 3 && !(row.length === 4 && row[3] === true))) continue;
            const [key, time, visibleText, keywordExempt] = row;
            const old = state.entries.get(key);
            const text = visibleText === null ? old?.text : visibleText;
            if (
                typeof key !== "string" ||
                key.length > 1024 ||
                !Number.isSafeInteger(time) ||
                typeof text !== "string" ||
                !text ||
                text.length > 500 ||
                (!keywordExempt && keywordHidden(text))
            )
                continue;
            if (
                old &&
                old.text === text &&
                mono >= old.received &&
                mono - old.received < TTL_MS &&
                now >= old.receivedWall &&
                now - old.receivedWall < TTL_MS
            ) {
                fresh.set(key, old);
            } else if (
                !old &&
                edge !== null &&
                (time > state.watermark ||
                    (time === state.watermark &&
                        state.seenAtWatermark.size < MAX_ROWS &&
                        !state.seenAtWatermark.has(key))) &&
                time >= state.since &&
                time <= now + 1000 &&
                now - time < 10000
            ) {
                received.push({ key, time, text });
            }
        }
        received.sort((a, b) => a.time - b.time);
        const newest = received.at(-1)?.time || 0;
        for (const { key, time, text } of received) {
            fresh.set(key, {
                time,
                text,
                received: mono,
                receivedWall: now,
                at: Math.max(state.entryEdge, state.lastAt, edge - (newest - time) / 1000),
            });
        }
        if (newest) state.lastAt = edge;
        for (const row of rows) {
            if (!Array.isArray(row)) continue;
            const [key, time] = row;
            if (!Number.isSafeInteger(time) || time > now + 1000 || time < state.watermark) continue;
            if (time > state.watermark) {
                state.watermark = time;
                state.seenAtWatermark.clear();
            }
            // If one millisecond fills the sample limit, stop accepting ties.
            if (state.seenAtWatermark.size < MAX_ROWS) state.seenAtWatermark.add(key);
        }
        if (now - state.watermark >= 10000 || state.watermark > now + 1000) {
            state.seenAtWatermark.clear();
            state.watermark = now - 10000;
        }
        state.entries = fresh;
    }

    function observeLog(log) {
        if (watchedLog === log) return;
        watchLog?.disconnect();
        watchedLog = log;
        watchLog = null;
        if (!log) return;
        watchLog = new MutationObserver(() => {
            if (log.isConnected) schedule();
            else sync();
        });
        if (log.parentElement) watchLog.observe(log.parentElement, { childList: true });
        watchLog.observe(log, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: [
                "hidden",
                "aria-hidden",
                "class",
                "style",
                "data-bcct-keyword-filtered",
                "data-bcct-blind-masked",
            ],
        });
    }

    function clearSession() {
        session = null;
        window.dispatchEvent(new Event("cheese-spanner:time-machine-chat-clear"));
    }

    function mainCandidates() {
        return Array.from(document.querySelectorAll("#live_player_layout .pzp-pc video")).filter(
            (video) => !utils.isExtensionPreviewVideo(video) && !video.closest(utils.NATIVE_AD_MEDIA_SELECTOR)
        );
    }

    function quarantineUnknownSources() {
        for (const video of mainCandidates()) {
            const sources = [video.currentSrc, video.getAttribute("src") ? video.src : ""].filter(Boolean);
            if (!sources.length) unidentifiedVideos.add(video);
            for (const source of sources) {
                if (!sourceOwners.has(source) && sourceOwners.size < MAX_SOURCES) sourceOwners.set(source, null);
            }
        }
        uncertainRoute = false;
    }

    function sync() {
        if (!timer || suspended) return;
        if (channel !== currentChannel()) return refresh();
        const logs = document.querySelectorAll(LOG);
        const log = logs[0];
        observeLog(log);
        const candidates = mainCandidates();
        const video = candidates.length === 1 ? candidates[0] : null;
        if (logs.length !== 1 || !video?.currentSrc || utils.isNativeAdBreakActive()) {
            clearSession();
            if (log) display(log, "방송 재생 위치를 확인하는 중입니다.");
            else if (view) view.overlay.textContent = "채팅 목록을 확인하는 중입니다.";
            return;
        }
        const source = video.currentSrc;
        const knownSource = sourceOwners.has(source);
        if (
            unidentifiedVideos.has(video) ||
            (knownSource ? sourceOwners.get(source) !== channel : sourceOwners.size >= MAX_SOURCES)
        ) {
            clearSession();
            display(log, "채팅과 방송을 확인하는 중입니다. 계속되면 이 방송을 새로고침해 주세요.");
            return;
        }
        if (session && (session.video !== video || session.log !== log || session.source !== video.currentSrc))
            clearSession();

        const rawEdge = getEdge(video);
        const data = session || rawEdge !== null ? sample(log) : null;
        if (!data || (session && data.owner !== session.owner)) {
            clearSession();
            display(log, "채팅과 방송을 확인하는 중입니다.");
            return;
        }
        if (!knownSource) sourceOwners.set(source, channel);
        const now = Date.now();
        const mono = performance.now();
        if (video.seeking || rawEdge === null) {
            // Keep only still-authorized, unexpired rows. There is no reliable edge
            // at which to stamp new arrivals or reliable cursor to display them.
            if (session) updateRows(session, data.rows, null, now, mono);
            display(log, "방송 재생 위치를 확인하는 중입니다.");
            return;
        }
        const first =
            !session || rawEdge < session.rawEdge || rawEdge - session.rawEdge > 15 + (mono - session.mono) / 1000;
        if (first) {
            session = {
                log,
                video,
                source: video.currentSrc,
                owner: data.owner,
                entryEdge: rawEdge,
                since: now,
                lastAt: rawEdge,
                entries: new Map(),
                watermark: 0,
                seenAtWatermark: new Set(),
                clock: null,
            };
        }
        const { clock, timing } = utils.liveTiming.nativeTiming(
            { edge: rawEdge, currentTime: video.currentTime, source: video.currentSrc },
            session.clock,
            mono
        );
        session.clock = clock;
        session.rawEdge = rawEdge;
        session.mono = mono;
        const edge = Math.max(session.lastAt, timing?.edge ?? rawEdge);
        updateRows(session, data.rows, first ? null : edge, now, mono);
        if (edge - video.currentTime <= 3) return restoreLog();
        if (video.currentTime < session.entryEdge)
            return display(log, "입장 또는 수집 시작 전 구간입니다. 실시간 채팅을 가리고 있어요.");
        const lines = Array.from(session.entries.values())
            .filter((row) => row.at <= video.currentTime)
            .sort((a, b) => a.at - b.at || a.time - b.time)
            .slice(-MAX_VISIBLE)
            .map((row) => (options.chatTimestampEnabled ? clockFormat.format(row.time) + "  " + row.text : row.text));
        display(log, lines.length ? lines.join("\n") : "이 시점에 확인할 수 있는 채팅이 없습니다.");
    }
    const schedule = utils.createThrottledDomSync(sync, 120);

    function onMedia(event) {
        if (!(event.target instanceof HTMLVideoElement)) return;
        if (event.type === "emptied" || event.type === "loadstart") {
            if (session?.video === event.target) {
                clearSession();
                if (view) display(view.log, "방송 재생 위치를 확인하는 중입니다.");
            }
        }
        if (event.type === "seeking" || event.type === "seeked") sync();
        else schedule();
    }

    function stop() {
        if (timer) {
            clearInterval(timer);
            window.dispatchEvent(new Event("cheese-spanner:time-machine-chat-clear"));
        }
        timer = 0;
        schedule.cancel();
        observeLog(null);
        for (const event of mediaEvents) document.removeEventListener(event, onMedia, true);
        session = null;
        restoreLog();
        document.getElementById(STYLE)?.remove();
    }

    function currentChannel() {
        return /^\/live\/([a-f0-9]{32})\/?$/.exec(location.pathname)?.[1] || "";
    }

    function refresh() {
        const next = currentChannel();
        if (channel !== next) {
            uncertainRoute = true;
            stop();
            channel = next;
        }
        if (!options.timeMachineChatEnabled || suspended || document.hidden || !channel) return stop();
        if (uncertainRoute) quarantineUnknownSources();
        if (!timer) {
            for (const event of mediaEvents) document.addEventListener(event, onMedia, true);
            timer = window.setInterval(sync, 1000);
        }
        sync();
    }

    function onHide() {
        suspended = true;
        stop();
    }
    function onShow() {
        suspended = false;
        refresh();
    }
    utils.bindFeatureOptions((next) => {
        options = next;
        keywords = next.chatKeywordFilterEnabled
            ? CheeseSpannerSettings.getChatKeywordFilterRules(next).map((rule) => ({
                  ...rule,
                  phrase: rule.phrase.toLowerCase(),
              }))
            : [];
        if (next.timeMachineChatEnabled && !removeRoute) {
            removeRoute = utils.startPageChangeDetection(refresh);
            document.addEventListener("visibilitychange", refresh);
            window.addEventListener("focus", refresh);
            window.addEventListener("pagehide", onHide);
            window.addEventListener("pageshow", onShow);
        } else if (!next.timeMachineChatEnabled && removeRoute) {
            removeRoute();
            removeRoute = null;
            document.removeEventListener("visibilitychange", refresh);
            window.removeEventListener("focus", refresh);
            window.removeEventListener("pagehide", onHide);
            window.removeEventListener("pageshow", onShow);
            suspended = false;
        }
        refresh();
    });
})();
