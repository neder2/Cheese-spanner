(() => {
    "use strict";

    const native = window.CheeseSpannerVodNative;
    const COMMAND = "cheese-spanner:vod-multiview:command";
    const STATUS = "cheese-spanner:vod-multiview:status";
    const REFERENCE = "cheese-spanner:vod-multiview:reference";
    const AUXILIARY = "cheese-spanner:vod-multiview:auxiliary";
    const MEDIA = "video.webplayer-internal-video";
    const HOST = "#player_layout.chzzk_player.type_vod";
    const MAIN_EVENTS = [
        "loadstart",
        "emptied",
        "playing",
        "pause",
        "waiting",
        "seeking",
        "seeked",
        "ratechange",
        "timeupdate",
        "ended",
    ];
    const SUB_EVENTS = [
        "loadstart",
        "emptied",
        "loadedmetadata",
        "canplay",
        "playing",
        "waiting",
        "seeking",
        "seeked",
        "play",
        "pause",
        "error",
        "ended",
    ];
    const NATIVE_PLAY_BUTTONS =
        ".pzp-pc__playback-switch, .pzp-pc__center-playback-switch, .pzp-pc__brand-playback-button";
    const TOLERANCE = 0.5;
    const PREPARATION_TIMEOUT = 15000;
    const MAX_SEEK_LEAD = 6;
    const sessions = new Map();
    let main = null;
    let mainEpoch = 0;
    let timer = null;

    function videoNo() {
        return /^\/video\/([1-9]\d{0,14})\/?$/.exec(location.pathname)?.[1];
    }

    function readTimeline(value) {
        if (
            typeof value?.videoNo !== "string" ||
            !/^[1-9]\d{0,14}$/.test(value.videoNo) ||
            typeof value.id !== "string" ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) ||
            !Number.isFinite(value.startMs) ||
            value.startMs <= 0 ||
            !Number.isFinite(value.duration) ||
            value.duration <= 0 ||
            value.duration >= 17 * 3600 - 120 ||
            value.endMs !== value.startMs + value.duration * 1000
        )
            return null;
        const { videoNo, id, startMs, duration, endMs } = value;
        return { videoNo, id, startMs, duration, endMs };
    }

    function show(session, status) {
        if (sessions.get(session.request) !== session || session.status === status) return;
        session.status = status;
        session.panel.dispatchEvent(new CustomEvent(STATUS, { detail: { request: session.request, status } }));
    }

    function listen(target, events, handler, signal) {
        for (const type of events) target.addEventListener(type, handler, { signal });
    }

    function current(session) {
        return (
            sessions.get(session.request) === session &&
            session.panel.parentElement === session.host &&
            session.panel.isConnected &&
            session.mount.parentElement === session.panel &&
            session.mainInfo.videoNo === videoNo()
        );
    }

    function boundMain(session) {
        const binding = main;
        return (
            binding?.root.parentElement === session.host &&
            session.host.querySelector(":scope > .pzp-pc") === binding.root &&
            binding.player.shadowRoot === binding.root &&
            native.ownsMedia(binding.player, binding.video, session.mainInfo.id)
        );
    }

    function findMain(session) {
        if (boundMain(session)) return main;
        main?.listeners.abort();
        main = null;

        const root = session.host.querySelector(":scope > .pzp-pc");
        const video = root?.querySelector(MEDIA);
        const player = native.find(session.host, video);
        if (!player || !native.ownsMedia(player, video, session.mainInfo.id)) return null;
        if (!native.canAllocate(player)) {
            fail(session, "unsupported");
            return null;
        }
        const listeners = new AbortController();
        const binding = {
            player,
            root,
            video,
            listeners,
            started: video.played.length > 0,
            waiting: false,
            epoch: ++mainEpoch,
        };
        main = binding;
        for (const session of sessions.values()) resetAlignment(session);
        listen(
            video,
            MAIN_EVENTS,
            (event) => {
                if (main !== binding) return;
                if (event.type === "loadstart" || event.type === "emptied") {
                    binding.started = false;
                    binding.waiting = true;
                }
                if (["loadstart", "emptied", "seeking"].includes(event.type)) {
                    binding.epoch = ++mainEpoch;
                    for (const session of sessions.values()) resetAlignment(session);
                }
                if (event.type === "waiting") {
                    binding.waiting = true;
                } else if (
                    event.type === "playing" ||
                    (event.type === "timeupdate" && video.readyState >= 3 && !video.seeking)
                ) {
                    binding.waiting = false;
                    // The site's first play can seek to its own resume position. Wait for an actual
                    // progress sample and let seeking/seeked supersede it.
                    if (event.type === "timeupdate" && video.played.length > 0) binding.started = true;
                }
                tickAll();
            },
            listeners.signal
        );
        const adObserver = new MutationObserver(() => {
            if (root.classList.contains("pzp-pc--adbreak") !== binding.ad) {
                binding.ad = root.classList.contains("pzp-pc--adbreak");
                tickAll();
            }
        });
        binding.ad = root.classList.contains("pzp-pc--adbreak");
        adObserver.observe(root, { attributes: true, attributeFilter: ["class"] });
        listeners.signal.addEventListener("abort", () => adObserver.disconnect(), { once: true });
        return binding;
    }

    function durationMatches(info, video) {
        return Number.isFinite(video.duration) && Math.abs(video.duration - info.duration) <= 2;
    }

    function reference(session) {
        const main = findMain(session);
        if (!main) return { status: "waiting-main" };
        const { video, root } = main;
        if (
            root.classList.contains("pzp-pc--adbreak") ||
            session.host.classList.contains("pip_mode") ||
            main.waiting ||
            video.seeking ||
            video.readyState < 2 ||
            !main.started
        )
            return { status: "waiting-main" };
        if (!durationMatches(session.mainInfo, video)) return { status: "unknown-time" };
        const time = video.currentTime;
        if (!Number.isFinite(time) || time < 0) return { status: "waiting-main" };
        if (time >= video.duration || video.ended) return { status: "main-ended" };
        const sub = session.subInfo;
        const broadcastMs = session.mainInfo.startMs + time * 1000;
        const media = session.slot?.media;
        const endMs =
            media?.readyState >= 1 && durationMatches(sub, media) ? sub.startMs + media.duration * 1000 : sub.endMs;
        if (broadcastMs < sub.startMs || broadcastMs >= endMs) return { status: "out-of-range" };
        return { time: (broadcastMs - sub.startMs) / 1000, playing: !video.paused, rate: video.playbackRate };
    }

    function pause(session) {
        const slot = session.slot;
        if (!slot) return;
        const request = session.play;
        const pending = request && !request.canceled;
        if (pending) request.canceled = true;
        if (pending || !slot.player.paused || !slot.media.paused) slot.player.pause();
    }

    function detach(session) {
        session.subListeners?.abort();
        const slot = session.slot;
        session.slot = null;
        session.source = null;
        if (slot) {
            delete slot.root.dataset.bcvmVideoNo;
            try {
                native.release(slot, session.play?.promise);
            } catch {
                // A failed release quarantines the slot for the rest of this document.
                slot.idle = Promise.resolve(false);
            }
            document.dispatchEvent(new Event(AUXILIARY));
        }
    }

    function stop(session) {
        sessions.delete(session.request);
        detach(session);
        if (sessions.size) return;
        main?.listeners.abort();
        main = null;
        clearInterval(timer);
        timer = null;
    }

    function fail(session, status) {
        if (sessions.get(session.request) !== session) return;
        session.failed = true;
        detach(session);
        show(session, status);
    }

    function togglePause(session) {
        if (!current(session) || session.failed) return;
        session.manualPause = !session.manualPause;
        resetAlignment(session);
        tick(session);
    }

    function resetAlignment(session) {
        session.seekFailures = 0;
        session.seekLead = 0;
        session.leadEpoch = null;
        session.alignDeadline = null;
    }

    function finishSeek(session, media) {
        const seek = session.seek;
        session.seek = null;
        if (!seek || seek.epoch !== main?.epoch) return;
        if (Math.abs(media.currentTime - seek.time) > TOLERANCE) {
            session.seekFailures++;
            session.leadEpoch = null;
            return;
        }
        session.seekFailures = 0;
        session.seekLead = Math.min(MAX_SEEK_LEAD, (performance.now() - seek.started) / 1000);
        session.leadEpoch = seek.lead ? seek.epoch : null;
    }

    function bindSub(session, slot) {
        const { root, media, player } = slot;
        const { signal } = (session.subListeners = new AbortController());
        root.addEventListener(
            "click",
            (event) => {
                if (!event.target.closest?.(NATIVE_PLAY_BUTTONS)) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                togglePause(session);
            },
            { capture: true, signal }
        );
        root.addEventListener(
            "keydown",
            (event) => {
                if (event.target !== root && event.target !== media) return;
                if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
                if (event.code === "Space" || event.code === "KeyM") {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (event.repeat) return;
                    if (event.code === "Space") togglePause(session);
                    else player.muted = !player.muted;
                    return;
                }
                // Let the native volume, menu and other focused widgets handle their own keys.
                if (["ArrowLeft", "ArrowRight", "Home", "End", "BracketLeft", "BracketRight"].includes(event.code)) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }
            },
            { capture: true, signal }
        );
        listen(
            media,
            SUB_EVENTS,
            (event) => {
                if (session.slot !== slot) return;
                if (event.type === "emptied" || event.type === "loadstart") {
                    session.sourceEpoch++;
                    session.seek = null;
                    resetAlignment(session);
                    if (session.play) session.play.canceled = true;
                }
                if (event.type === "seeked" && !media.seeking) finishSeek(session, media);
                tick(session);
            },
            signal
        );
        const onPlayerError = () => {
            if (current(session) && session.slot === slot && player.error) fail(session, "load-error");
        };
        player.addEventListener("error", onPlayerError);
        signal.addEventListener("abort", () => player.removeEventListener("error", onPlayerError), { once: true });
    }

    function mountSub(session) {
        if (session.mounting) {
            if (performance.now() >= session.mountDeadline) fail(session, "cleanup-error");
            return;
        }
        const slot = native.acquire(main.player, session.index);
        if (!slot) {
            fail(session, "unsupported");
            return;
        }
        session.mounting = true;
        session.mountDeadline = performance.now() + PREPARATION_TIMEOUT;
        slot.idle
            .then((idle) => {
                session.mounting = false;
                if (!current(session) || session.failed) return;
                if (!idle) {
                    fail(session, "cleanup-error");
                    return;
                }
                if (reference(session).status || session.manualPause) return;
                session.slot = slot;
                session.loadDeadline = performance.now() + PREPARATION_TIMEOUT;
                slot.root.dataset.bcvmVideoNo = session.subInfo.videoNo;
                session.mount.appendChild(slot.root);
                bindSub(session, slot);
                const { key, aes } = session.source;
                session.source = null;
                native.assign(slot, session.subInfo.id, key, aes);
                document.dispatchEvent(new Event(AUXILIARY));
                tick(session);
            })
            .catch(() => fail(session, "load-error"));
    }

    function startPlay(session) {
        if (session.play) return;
        const slot = session.slot;
        const request = { epoch: session.sourceEpoch, canceled: false, promise: null };
        session.play = request;
        request.promise = Promise.resolve(slot.player.play());
        function finish(error) {
            if (!current(session) || session.slot !== slot || session.play !== request) return;
            session.play = null;
            const latest = reference(session);
            if (latest.status || !latest.playing || session.manualPause) {
                pause(session);
                return;
            }
            if (request.canceled || request.epoch !== session.sourceEpoch) return;
            if (error) {
                if (error.name === "AbortError" && (slot.media.seeking || slot.media.readyState < 3)) return;
                fail(session, "load-error");
                return;
            }
            tick(session);
        }
        request.promise.then(() => finish(null), finish).catch(() => fail(session, "load-error"));
    }

    function align(session, target) {
        const { player, media } = session.slot;
        if (media.error || player.error || !native.ownsMedia(player, media, session.subInfo.id))
            return fail(session, "load-error");
        if (media.readyState < 1) {
            if (performance.now() >= session.loadDeadline) return fail(session, "load-error");
            return show(session, "loading");
        }
        if (!durationMatches(session.subInfo, media)) return fail(session, "unknown-time");
        if (target.time >= media.duration) {
            pause(session);
            return show(session, "out-of-range");
        }
        if (session.seek || media.seeking) {
            if (session.seek && performance.now() >= session.seek.deadline) return fail(session, "load-error");
            return show(session, "syncing");
        }
        if (session.seekFailures >= 3) {
            pause(session);
            return show(session, "resync");
        }
        const drift = target.time - media.currentTime;
        if (media.readyState < 3 && !media.paused && !media.ended) return show(session, "loading");
        if (media.ended || Math.abs(drift) > TOLERANCE) {
            pause(session);
            const now = performance.now();
            session.alignDeadline ??= now + PREPARATION_TIMEOUT;
            if (now >= session.alignDeadline) return show(session, "resync");
            // A successful seek can land behind a moving main after buffering. Prepare ahead by
            // the measured seek time and let the main catch up before playing the sub.
            if (target.playing && drift < 0 && session.leadEpoch === main?.epoch) return show(session, "syncing");
            const rate = Number.isFinite(target.rate) ? Math.max(0, target.rate) : 0;
            const lead = target.playing && drift > 0 ? Math.min(MAX_SEEK_LEAD, session.seekLead * rate) : 0;
            const time = Math.min(target.time + lead, Math.max(target.time, media.duration - TOLERANCE));
            session.seek = {
                time,
                lead: time > target.time,
                epoch: main?.epoch,
                started: now,
                deadline: now + PREPARATION_TIMEOUT,
            };
            player.currentTime = time;
            return show(session, "syncing");
        }
        if (media.readyState < 3) return show(session, "loading");
        session.seekFailures = 0;
        session.alignDeadline = session.leadEpoch = null;
        if (media.playbackRate !== target.rate) player.playbackRate = target.rate;
        if (!target.playing) {
            pause(session);
            return show(session, "main-paused");
        }
        if (media.paused || session.play) {
            if (media.paused) startPlay(session);
            return show(session, "syncing");
        }
        show(session, "synced");
    }

    function tick(session) {
        if (sessions.get(session.request) !== session || session.ticking) return;
        if (!current(session)) {
            stop(session);
            return;
        }
        if (session.failed) return;
        session.ticking = true;
        try {
            const target = reference(session);
            if (session.failed) return;
            if (target.status || session.manualPause) {
                pause(session);
                if (target.status === "waiting-main" && !main && performance.now() >= session.mainDeadline)
                    fail(session, "unsupported");
                else show(session, target.status || "paused");
                return;
            }
            if (!target.playing) pause(session);
            if (session.slot) align(session, target);
            else {
                show(session, "loading");
                mountSub(session);
            }
        } catch {
            fail(session, "load-error");
        } finally {
            session.ticking = false;
        }
    }

    function tickAll() {
        for (const session of sessions.values()) tick(session);
    }

    function onCommand(event) {
        const panel = event.target;
        const command = event.detail;
        if (!(panel instanceof HTMLElement) || panel.id !== "cheese-spanner-vod-multiview") return;
        if (command?.action === "stop" || command?.action === "resync") {
            const session = sessions.get(command.request);
            if (session?.panel !== panel) return;
            if (command.action === "stop") stop(session);
            else {
                session.manualPause = false;
                resetAlignment(session);
                tick(session);
            }
            return;
        }
        const host = panel.parentElement;
        if (!panel.isConnected || !host?.matches(HOST) || !host.contains(panel)) return;
        const mainInfo = readTimeline(command?.main);
        if (!mainInfo || mainInfo.videoNo !== videoNo()) return;
        if (command.action === "reference") {
            const root = host.querySelector(":scope > .pzp-pc");
            const video = root?.querySelector(MEDIA);
            if (
                !video ||
                video.seeking ||
                video.readyState < 1 ||
                host.classList.contains("pip_mode") ||
                root.classList.contains("pzp-pc--adbreak") ||
                !durationMatches(mainInfo, video)
            )
                return;
            const player = native.find(host, video);
            if (!player || !native.ownsMedia(player, video, mainInfo.id)) return;
            const time = video.currentTime;
            const at = mainInfo.startMs + time * 1000;
            if (Number.isFinite(time) && time >= 0 && at < mainInfo.endMs)
                panel.dispatchEvent(new CustomEvent(REFERENCE, { detail: at }));
            return;
        }
        if (command.action !== "start") return;
        const index = command.slot;
        if (!Number.isInteger(index) || index < 0 || index >= native.maxAuxiliary) return;
        const mount = panel.querySelector(`:scope > [data-bcmv-video='1'][data-bcvm-slot='${index}']`);
        const subInfo = readTimeline(command.sub);
        if (
            !mount ||
            !subInfo ||
            mainInfo.videoNo === subInfo.videoNo ||
            mainInfo.id === subInfo.id ||
            typeof command.key !== "string" ||
            !/^[A-Za-z0-9_-]{1,512}$/.test(command.key) ||
            typeof command.aes !== "boolean" ||
            !Number.isSafeInteger(command.request) ||
            command.request <= 0 ||
            sessions.has(command.request)
        )
            return;
        for (const session of sessions.values()) {
            if (!current(session)) stop(session);
            else if (
                session.index === index ||
                session.subInfo.videoNo === subInfo.videoNo ||
                session.subInfo.id === subInfo.id
            )
                return;
        }
        const session = {
            panel,
            host,
            mount,
            index,
            mainInfo,
            subInfo,
            request: command.request,
            source: { key: command.key, aes: command.aes },
            sourceEpoch: 0,
            seekFailures: 0,
            seekLead: 0,
            mainDeadline: performance.now() + PREPARATION_TIMEOUT,
        };
        sessions.set(session.request, session);
        if (timer === null) timer = setInterval(tickAll, 500);
        tick(session);
    }

    document.addEventListener(COMMAND, onCommand, true);
    window.addEventListener("cheese-spanner:routechange", tickAll, true);
    window.addEventListener(
        "pagehide",
        () => {
            for (const session of sessions.values()) stop(session);
        },
        true
    );
})();
