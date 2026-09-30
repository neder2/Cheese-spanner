/**
 * Memory-only playback observations; no DOM, clocks, timers, storage or media control.
 * BetterChzzk.streamInfoModel.create({ sampleIntervalMs = 1000, stallThresholdMs = 500 })
 * returns sample(input), event(type, input), read(now), suspend(now, reason = "hidden"),
 * switchSource(now, { preserveHistory = true }), and reset(). All return a detached read view.
 *
 * input: { now: monotonic milliseconds, sourceToken: opaque string|null, currentTime,
 * seekable: [{start,end}], buffered: [{start,end}], readyState, paused, seeking, ended,
 * error, ad, transitioning, hidden, playbackRate, framesSupported,
 * frames: {totalVideoFrames,droppedVideoFrames}|null, mode, onLive: boolean|null }.
 * Pass a complete snapshot to events too. Only sample() appends a graph point.
 * Source changes retain history with a new segment. reset() discards a closed panel
 * or a changed/unverified broadcast. suspend() stops continuity; the next input resumes.
 * Missing numeric values are null; graph points have {at,delay,buffer,mode,segment,gap}.
 */
(() => {
    "use strict";
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const { nativeTiming, bufferedSeconds } = root.utils.liveTiming;
    const WINDOW_MS = 60000;
    const MAX_SAMPLES = 120;
    const MAX_STALLS = 128;
    const validTime = (value) => Number.isFinite(value) && value >= 0;
    const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback);
    const modeOf = (value) => (["low-latency", "standard"].includes(value) ? value : "unknown");
    const overlap = (start, end, cutoff, now) => Math.max(0, Math.min(end, now) - Math.max(start, cutoff));

    function frameCounts(value) {
        const total = value?.totalVideoFrames;
        const dropped = value?.droppedVideoFrames;
        return Number.isSafeInteger(total) && Number.isSafeInteger(dropped) && total >= dropped && dropped >= 0
            ? { total, dropped }
            : null;
    }

    function excluded(input, type) {
        if (input.hidden) return "hidden";
        if (input.ad) return "ad";
        if (input.transitioning || type === "emptied") return "transition";
        if (input.error || type === "error") return "error";
        if (input.ended || type === "ended") return "ended";
        if (input.paused || type === "pause") return "paused";
        if (input.seeking || type === "seeking") return "seeking";
        if (!Number.isFinite(input.playbackRate) || input.playbackRate <= 0) return "invalid-rate";
        if (!(input.readyState > 0) || !validTime(input.currentTime)) return "waiting";
        return null;
    }

    function create({ sampleIntervalMs = 1000, stallThresholdMs = 500 } = {}) {
        const maxGap = positive(sampleIntervalMs, 1000) * 3;
        const threshold = positive(stallThresholdMs, 500);
        let samples, stalls, observed, frameIntervals;
        let previous, frameBaseline, clock, candidate, current;
        let progressed, source, segment, pendingGap, lastNow, lastSampleAt, framesSupported, fps;

        function reset() {
            samples = [];
            stalls = [];
            observed = [];
            frameIntervals = [];
            previous = frameBaseline = clock = candidate = null;
            progressed = false;
            source = undefined;
            segment = 0;
            pendingGap = true;
            lastNow = lastSampleAt = null;
            framesSupported = null;
            fps = null;
            current = {
                delay: null,
                buffer: null,
                mode: "unknown",
                onLive: null,
                playbackRate: null,
                state: "waiting",
            };
            return view(0);
        }

        function prune(now) {
            const cutoff = now - WINDOW_MS;
            samples = samples.filter((item) => item.at >= cutoff).slice(-MAX_SAMPLES);
            stalls = stalls
                .filter((item) => item.end > cutoff)
                .slice(-(MAX_STALLS - Number(Boolean(candidate?.recognized))));
            observed = observed.filter((item) => item.end > cutoff).slice(-MAX_STALLS);
            frameIntervals = frameIntervals.filter((item) => item.start >= cutoff).slice(-MAX_SAMPLES);
        }

        function recordObserved(start, end) {
            if (!(end > start)) return;
            const last = observed.at(-1);
            if (last?.end === start) last.end = end;
            else observed.push({ start, end });
        }

        function finishStall(at) {
            if (candidate?.recognized && at > candidate.start) {
                stalls.push({ start: candidate.start, end: at });
                stalls = stalls.slice(-MAX_STALLS);
            }
            candidate = null;
        }

        function breakSampleContinuity() {
            frameBaseline = clock = null;
            fps = null;
            if (!pendingGap) segment += 1;
            pendingGap = true;
        }

        function breakContinuity(at) {
            finishStall(at);
            previous = null;
            progressed = false;
            breakSampleContinuity();
        }

        function acceptTime(now) {
            if (!validTime(now)) return false;
            if (lastNow !== null && now < lastNow) reset();
            lastNow = now;
            prune(now);
            return true;
        }

        function view(now) {
            const cutoff = now - WINDOW_MS;
            const activeEnd = previous?.at ?? now;
            const active = candidate?.recognized ? { start: candidate.start, end: activeEnd } : null;
            const visibleStalls = [...stalls, ...(active ? [active] : [])].filter(
                (item) => overlap(item.start, item.end, cutoff, now) > 0
            );
            let total = 0;
            let dropped = 0;
            for (const item of frameIntervals) {
                total += item.total;
                dropped += item.dropped;
            }
            const supported = framesSupported !== false;
            return {
                now,
                windowMs: WINDOW_MS,
                samples: samples.map((item) => ({ ...item })),
                current: { ...current },
                observedSeconds:
                    observed.reduce((sum, item) => sum + overlap(item.start, item.end, cutoff, now), 0) / 1000,
                stalls: {
                    count: visibleStalls.length,
                    seconds:
                        visibleStalls.reduce((sum, item) => sum + overlap(item.start, item.end, cutoff, now), 0) / 1000,
                    ongoing: Boolean(active),
                },
                frames: {
                    state: !supported ? "unsupported" : total > 0 ? "ready" : "waiting",
                    dropped: supported ? dropped : null,
                    total: supported ? total : null,
                    percent: supported && total > 0 ? (dropped / total) * 100 : null,
                    fps: supported ? fps : null,
                    intervalCount: frameIntervals.length,
                },
            };
        }

        function read(now = lastNow ?? 0) {
            if (!acceptTime(now)) return view(lastNow ?? 0);
            if (previous && now - previous.at > maxGap) {
                breakContinuity(previous.at);
                current = { ...current, delay: null, buffer: null, state: "waiting" };
                prune(now);
            }
            return view(now);
        }

        function suspend(now, reason = "hidden") {
            if (!acceptTime(now)) return view(lastNow ?? 0);
            // An explicit boundary can settle an already observed wait until this
            // instant, but cannot promote a short/unconfirmed candidate or a long gap.
            const at = previous && now - previous.at <= maxGap ? now : (previous?.at ?? now);
            if (candidate?.recognized && previous) recordObserved(previous.at, at);
            breakContinuity(at);
            current = { ...current, delay: null, buffer: null, state: reason };
            prune(now);
            return view(now);
        }

        function switchSource(now, { preserveHistory = true } = {}) {
            if (!preserveHistory) reset();
            source = undefined;
            return suspend(now, "transition");
        }

        function observe(input, type, append) {
            const now = input?.now;
            if (!acceptTime(now)) return view(lastNow ?? 0);
            const nextSource = typeof input.sourceToken === "string" && input.sourceToken ? input.sourceToken : null;
            const reason = excluded(input, type);
            const changed = source !== undefined && source !== nextSource;
            const gap = previous && now - previous.at > maxGap;
            const reversed = previous && input.currentTime < previous.currentTime;
            if (changed || gap || reversed) breakContinuity(previous?.at ?? now);
            source = nextSource;
            framesSupported =
                input.framesSupported === true || (input.framesSupported !== false && input.frames != null);
            const supportedFrames = framesSupported ? frameCounts(input.frames) : null;
            if (
                !supportedFrames ||
                (frameBaseline &&
                    (supportedFrames.total < frameBaseline.total ||
                        supportedFrames.dropped < frameBaseline.dropped ||
                        supportedFrames.dropped - frameBaseline.dropped > supportedFrames.total - frameBaseline.total))
            ) {
                frameBaseline = null;
                fps = null;
            }
            const prior = previous;
            const advancing = prior && input.currentTime > prior.currentTime;
            let measured = false;
            if (reason) {
                if (candidate?.recognized && prior) recordObserved(prior.at, now);
                breakContinuity(now);
            } else {
                if (advancing) {
                    progressed = true;
                    if (candidate?.confirmed && now - candidate.start >= threshold) candidate.recognized = true;
                    finishStall(now);
                } else if (candidate && prior) {
                    candidate.confirmed = true;
                    if (now - candidate.start >= threshold) candidate.recognized = true;
                }
                measured = Boolean(prior && now > prior.at && (advancing || (progressed && candidate?.confirmed)));
                if (measured) recordObserved(prior.at, now);
                if (type === "waiting" && progressed && !candidate) {
                    candidate = { start: now, confirmed: false, recognized: false };
                }
                previous = { at: now, currentTime: input.currentTime };
            }

            if (append) {
                // Events can continue observing playback while periodic sampling
                // is delayed. Keep those observations, but never bridge its graph
                // or frame interval across the independent sampling gap.
                if (lastSampleAt !== null && now - lastSampleAt > maxGap) breakSampleContinuity();
                lastSampleAt = now;
                fps = null;
                if (!reason && supportedFrames) {
                    // A media event may already have observed this instant's
                    // progress. Frame intervals belong to consecutive samples,
                    // while every exclusion/source change clears their baseline.
                    if (frameBaseline && progressed && now > frameBaseline.at) {
                        const total = supportedFrames.total - frameBaseline.total;
                        const dropped = supportedFrames.dropped - frameBaseline.dropped;
                        if (total >= 0 && dropped >= 0 && dropped <= total) {
                            frameIntervals.push({ start: frameBaseline.at, end: now, total, dropped });
                            fps = (total - dropped) / ((now - frameBaseline.at) / 1000);
                        }
                    }
                    frameBaseline = { at: now, ...supportedFrames };
                } else frameBaseline = null;

                const ranges = (Array.isArray(input.seekable) ? input.seekable : []).filter(
                    (range) => Number.isFinite(range?.start) && Number.isFinite(range?.end) && range.end > range.start
                );
                const edge = ranges.at(-1)?.end;
                const timing = !reason
                    ? nativeTiming({ edge, currentTime: input.currentTime, source }, clock, now)
                    : { clock: null, timing: null };
                clock = timing.clock;
                current = {
                    delay: timing.timing?.latency ?? null,
                    buffer: reason ? null : bufferedSeconds(input.currentTime, input.buffered, input.readyState),
                    mode: modeOf(input.mode),
                    onLive: typeof input.onLive === "boolean" ? input.onLive : null,
                    playbackRate: Number.isFinite(input.playbackRate) ? input.playbackRate : null,
                    state: reason || (candidate ? "buffering" : progressed ? "measuring" : "waiting"),
                };
                samples.push({
                    at: now,
                    delay: current.delay,
                    buffer: current.buffer,
                    mode: current.mode,
                    segment,
                    gap: pendingGap || Boolean(reason),
                });
                if (!reason) pendingGap = false;
            } else if (reason || changed || gap || reversed) {
                current = { ...current, delay: null, buffer: null, state: reason || "waiting" };
            }
            prune(now);
            return view(now);
        }

        reset();
        return Object.freeze({
            sample: (input) => observe(input, "sample", true),
            event: (type, input) => observe(input, type, false),
            read,
            suspend,
            switchSource,
            reset,
        });
    }

    root.streamInfoModel = Object.freeze({ create });
})();
