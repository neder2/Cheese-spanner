/** Pure live-edge and buffer calculations. Callers supply all media values and monotonic milliseconds. */
(() => {
    "use strict";
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const utils = (root.utils = root.utils || {});

    // Preserve the multiview delay domain, including its safe tenth-second limit.
    function validDelay(value) {
        return Number.isFinite(value) && value >= 0 && Number.isSafeInteger(Math.round(value * 10));
    }

    // Learn cadence from two advancing edge observations, then compensate for the
    // staircase between updates. This function never reads a media/DOM object.
    function nativeTiming({ edge, currentTime, source }, clock, now) {
        if (!Number.isFinite(edge) || !source || !Number.isFinite(now)) return { clock: null, timing: null };
        const fresh = () => ({ edge, at: now, source, intervals: [] });
        if (!clock || clock.source !== source || now < clock.at || edge < clock.edge) {
            return { clock: fresh(), timing: null };
        }
        const elapsed = (now - clock.at) / 1000;
        const cadence = Math.max(...clock.intervals, 0);
        if (cadence && elapsed > cadence * 3) return { clock: fresh(), timing: null };
        if (edge > clock.edge) {
            if (elapsed <= 0 || edge - clock.edge > (cadence || elapsed) * 3) return { clock: fresh(), timing: null };
            clock = { edge, at: now, source, intervals: [...clock.intervals, elapsed].slice(-3) };
        }
        if (!clock.intervals.length) return { clock, timing: null };
        const estimate = clock.edge + (now - clock.at) / 1000;
        const latency = estimate - currentTime;
        return { clock, timing: validDelay(latency) ? { edge: estimate, latency } : null };
    }

    // null means unobserved; an observed, empty containing range means zero.
    function bufferedSeconds(currentTime, buffered, readyState) {
        if (
            !Number.isFinite(currentTime) ||
            currentTime < 0 ||
            !(readyState > 0) ||
            !Array.isArray(buffered) ||
            buffered.some(
                (range) => !Number.isFinite(range?.start) || !Number.isFinite(range?.end) || range.end < range.start
            )
        )
            return null;
        const range = buffered.find(({ start, end }) => start <= currentTime && currentTime <= end);
        return range ? range.end - currentTime : 0;
    }

    utils.liveTiming = Object.freeze({ nativeTiming, bufferedSeconds });
})();
