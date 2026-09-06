/** 멀티뷰의 입력·탭 구성·채널별 영구 딜레이와 탐색 범위 계산. */
(() => {
    const root = (globalThis.BetterChzzk = globalThis.BetterChzzk || {});
    const CHANNEL = /^[a-f0-9]{32}$/;
    const DELAY_PREFIX = "betterChzzkMultiviewDelay:";
    const SESSION_KEY = "betterChzzkMultiviewSession";
    const DEFAULT_SPLITS = [1 / 3, 2 / 3];
    function channelFromUrl(value) {
        try {
            const url = new URL(value);
            const match = url.pathname.match(/^\/live\/([a-f0-9]{32})\/?$/);
            return url.protocol === "https:" &&
                url.hostname === "chzzk.naver.com" &&
                !url.port &&
                !url.username &&
                !url.password &&
                match
                ? match[1]
                : null;
        } catch {
            return null;
        }
    }
    function validDelay(value) {
        return typeof value === "number" && Number.isFinite(value) && value >= 0;
    }
    function splits(value) {
        return Array.isArray(value) &&
            value.length === 2 &&
            value.every(Number.isFinite) &&
            value[0] >= 0.15 &&
            value[1] - value[0] >= 0.15 &&
            value[1] <= 0.85
            ? [...value]
            : [...DEFAULT_SPLITS];
    }
    function session(value) {
        const channels = [];
        if (value?.version === 1 && Array.isArray(value.channels)) {
            for (const entry of value.channels) {
                if (!CHANNEL.test(entry?.id) || channels.some((item) => item.id === entry.id)) continue;
                channels.push({
                    id: entry.id,
                    volume: Number.isFinite(entry.volume) ? Math.min(1, Math.max(0, entry.volume)) : 0.3,
                    muted: entry.muted !== false,
                    position: [0, 1].map((axis) => {
                        const coordinate = entry.position?.[axis];
                        return Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 1 ? coordinate : 0.5;
                    }),
                });
                if (channels.length === 6) break;
            }
        }
        const hasDockTree = value?.layoutVersion === 3 && validTree(value.dockTree, channels);
        return {
            version: 1,
            layoutVersion: 3,
            active: value?.version === 1 && value.active === true,
            channels,
            columns: value?.layoutVersion === 2 ? splits(value.columns) : autoSplits(channels.length).columns,
            rows: value?.layoutVersion === 2 ? splits(value.rows) : autoSplits(channels.length).rows,
            dockTree: hasDockTree
                ? value.dockTree
                : defaultTree(
                      channels,
                      value?.layoutVersion === 2 ? splits(value.columns) : DEFAULT_SPLITS,
                      value?.layoutVersion === 2 ? splits(value.rows) : DEFAULT_SPLITS
                  ),
            customLayout:
                value?.layoutVersion === 3 ? hasDockTree && value.customLayout === true : value?.layoutVersion === 2,
        };
    }
    const branch = (axis, ratio, a, b) => ({ axis, ratio, a, b });
    function defaultTree(channels, columns = DEFAULT_SPLITS, rows = DEFAULT_SPLITS) {
        const ids = channels.map((entry) => entry.id);
        if (ids.length < 2) return ids[0] || null;
        const [x1, x2] = columns,
            [y1, y2] = rows;
        const right = branch("rows", y1 / y2, ids[1], ids[2] || null);
        const bottom = branch(
            "columns",
            x2,
            branch("columns", x1 / x2, ids[3] || null, ids[4] || null),
            ids[5] || null
        );
        return branch("rows", y2, branch("columns", x2, ids[0], right), bottom);
    }
    function validTree(tree, channels) {
        const ids = new Set();
        let count = 0,
            blanks = 0;
        function visit(node, depth) {
            if (++count > 31 || depth > 10) return false;
            if (node === null) return ++blanks <= 5;
            if (typeof node === "string") {
                if (!CHANNEL.test(node) || ids.has(node)) return false;
                ids.add(node);
                return true;
            }
            return (
                node &&
                ["columns", "rows"].includes(node.axis) &&
                Number.isFinite(node.ratio) &&
                node.ratio >= 0.05 &&
                node.ratio <= 0.95 &&
                visit(node.a, depth + 1) &&
                visit(node.b, depth + 1)
            );
        }
        return Boolean(visit(tree, 0) && ids.size === channels.length && channels.every((entry) => ids.has(entry.id)));
    }
    function treeLayout(tree) {
        const cells = [],
            handles = [];
        const units = (n, axis) =>
            n && typeof n === "object"
                ? n.axis === axis
                    ? units(n.a, axis) + units(n.b, axis)
                    : Math.max(units(n.a, axis), units(n.b, axis))
                : 1;
        function visit(node, rect, path) {
            if (!node || typeof node === "string") {
                cells.push({ id: node, rect, path });
                return;
            }
            const [x, y, w, h] = rect,
                vertical = node.axis === "columns",
                r = node.ratio;
            const span = vertical ? w : h,
                a = units(node.a, node.axis),
                b = units(node.b, node.axis),
                min = Math.min(0.06, span / (a + b));
            handles.push({
                key: path,
                axis: node.axis,
                value: r,
                region: rect,
                position: vertical ? x + w * r : y + h * r,
                start: vertical ? y : x,
                length: vertical ? h : w,
                lower: Math.max(0.05, (a * min) / span),
                upper: Math.min(0.95, 1 - (b * min) / span),
            });
            visit(node.a, vertical ? [x, y, w * r, h] : [x, y, w, h * r], path + "a");
            visit(node.b, vertical ? [x + w * r, y, w * (1 - r), h] : [x, y + h * r, w, h * (1 - r)], path + "b");
        }
        visit(tree, [0, 0, 1, 1], "r");
        return { cells, handles };
    }
    function mapTree(tree, fn) {
        return tree && typeof tree === "object"
            ? { ...tree, a: mapTree(tree.a, fn), b: mapTree(tree.b, fn) }
            : fn(tree);
    }
    function removeTree(tree, id) {
        if (!tree || typeof tree === "string") return tree === id ? undefined : tree;
        const a = removeTree(tree.a, id),
            b = removeTree(tree.b, id);
        if (a === undefined) return b;
        if (b === undefined) return a;
        return { ...tree, a, b };
    }
    function resizeTree(tree, path, ratio) {
        if (path === "r") return tree && typeof tree === "object" ? { ...tree, ratio } : tree;
        const side = path[1];
        return tree && typeof tree === "object" && (side === "a" || side === "b")
            ? { ...tree, [side]: resizeTree(tree[side], "r" + path.slice(2), ratio) }
            : tree;
    }
    function replaceTree(tree, path, replacement) {
        if (path === "r") return replacement;
        const side = path[1];
        return tree && typeof tree === "object"
            ? { ...tree, [side]: replaceTree(tree[side], "r" + path.slice(2), replacement) }
            : tree;
    }
    function compactTree(tree) {
        if (!tree || typeof tree === "string") return tree;
        const a = compactTree(tree.a),
            b = compactTree(tree.b);
        return a === undefined ? b : b === undefined ? a : { ...tree, a, b };
    }
    function dockTree(tree, source, target, side, mainId, targetPath) {
        if (source === target) return tree;
        const leaves = treeLayout(tree).cells;
        if (!leaves.some((leaf) => leaf.id === source) || !leaves.some((leaf) => leaf.id === target)) return tree;
        if (side === "center") {
            const ids = leaves.map((leaf) => leaf.id).filter((id) => id && id !== mainId);
            const from = ids.indexOf(source),
                to = ids.indexOf(target);
            if (from < 0 || to < 0) return tree;
            const ordered = [...ids];
            ordered.splice(to, 0, ordered.splice(from, 1)[0]);
            return mapTree(tree, (id) => (ids.includes(id) ? ordered[ids.indexOf(id)] : id));
        }
        if (target === null) {
            const from = leaves.find((leaf) => leaf.id === source);
            return compactTree(replaceTree(replaceTree(tree, from.path, undefined), targetPath, source));
        }
        if (!["left", "right", "top", "bottom"].includes(side)) return tree;
        const axis = side === "left" || side === "right" ? "columns" : "rows";
        const before = side === "left" || side === "top";
        return mapTree(removeTree(tree, source), (id) =>
            id === target ? branch(axis, 0.5, before ? source : target, before ? target : source) : id
        );
    }
    function moveMainTree(tree, mainId, targetId, targetPath) {
        const leaves = treeLayout(tree).cells,
            main = leaves.find((leaf) => leaf.id === mainId),
            target = leaves.find((leaf) => leaf.id === targetId && (targetId !== null || leaf.path === targetPath));
        if (!main || !target || main === target) return null;
        let length = 1;
        while (main.path[length] === target.path[length]) length++;
        const path = main.path.slice(0, length);
        let node = tree;
        for (const side of path.slice(1)) node = node[side];
        // Translate whole sibling regions; their internal splits and dimensions stay intact.
        const moved = { ...node, ratio: 1 - node.ratio, a: node.b, b: node.a };
        const after = main.path[length] === "a";
        const side = node.axis === "rows" ? (after ? "bottom" : "top") : after ? "right" : "left";
        return { tree: replaceTree(tree, path, moved), path, side };
    }
    function addTree(tree, id, mainId) {
        if (!tree) return id;
        const leaves = treeLayout(tree).cells;
        const empty = leaves.find((leaf) => leaf.id === null);
        if (empty) return replaceTree(tree, empty.path, id);
        const candidates = leaves.filter((leaf) => leaf.id !== mainId);
        const target = (candidates.length ? candidates : leaves).reduce((a, b) =>
            a.rect[2] * a.rect[3] >= b.rect[2] * b.rect[3] ? a : b
        );
        return mapTree(tree, (item) =>
            item === target.id ? branch(target.rect[2] > target.rect[3] ? "columns" : "rows", 0.5, item, id) : item
        );
    }
    function equalizeTree(tree, id, mainId, viewportRatio = 16 / 9) {
        const layout = treeLayout(tree),
            selected = layout.cells.find((cell) => cell.id === id),
            main = layout.cells.find((cell) => cell.id === mainId);
        if (!selected || !main || id === mainId) return null;
        // Find the largest shared secondary region without changing a main boundary.
        let path = "r";
        while (main.path.startsWith(path)) path = selected.path.slice(0, path.length + 1);
        const cells = layout.cells.filter((cell) => cell.id && cell.path.startsWith(path));
        if (cells.length < 2) return null;
        const region = layout.handles.find((handle) => handle.key === path).region;
        const ratio = Number.isFinite(viewportRatio) && viewportRatio > 0 ? viewportRatio : 16 / 9;
        const axis = (region[2] * ratio) / region[3] > 16 / 9 ? "columns" : "rows";
        cells.sort((a, b) => (Math.abs(a.rect[1] - b.rect[1]) > 1e-7 ? a.rect[1] - b.rect[1] : a.rect[0] - b.rect[0]));
        const ids = cells.map((cell) => cell.id);
        const divide = (items) =>
            items.length === 1 ? items[0] : branch(axis, 1 / items.length, items[0], divide(items.slice(1)));
        return { tree: replaceTree(tree, path, divide(ids)), ids, axis };
    }
    function snapRatio(handle, raw, pixels, locked, origin) {
        const value = Math.min(handle.upper, Math.max(handle.lower, raw));
        if (!(pixels > 0) || !Number.isFinite(value)) return { value: handle.value, locked: null };
        if (locked !== null && Math.abs(value - locked) * pixels <= 14) return { value: locked, locked };
        const points = [handle.lower, handle.upper, origin, 1 / 3, 0.5, 2 / 3].filter(
            (n) => n >= handle.lower && n <= handle.upper
        );
        const nearest = points.reduce((a, b) => (Math.abs(a - value) <= Math.abs(b - value) ? a : b));
        return Math.abs(value - nearest) * pixels <= 8 ? { value: nearest, locked: nearest } : { value, locked: null };
    }
    function autoSplits() {
        return { columns: [...DEFAULT_SPLITS], rows: [...DEFAULT_SPLITS] };
    }
    function readSession(storage) {
        try {
            return session(JSON.parse(storage.getItem(SESSION_KEY)));
        } catch {
            return session(null);
        }
    }
    function readDelay(record) {
        return (record?.version === 1 || (record?.version === 2 && record.basis === "live-edge-clock")) &&
            validDelay(record.delaySeconds)
            ? record.delaySeconds
            : 0;
    }
    function delayBasis(record) {
        return record?.version === 1 && validDelay(record.delaySeconds) ? "legacy" : "live-edge-clock";
    }
    // Keep the playlist's age in the same time coordinate as its edge. Do not use a
    // previously cached Hls.latency value: its timeupdate listener may run after ours.
    function hlsTiming(video, details) {
        if (
            !details?.live ||
            !Number.isFinite(details.edge) ||
            !Number.isFinite(details.age) ||
            details.age < 0 ||
            !Number.isFinite(details.advancedDateTime) ||
            details.advancedDateTime <= 0 ||
            !Number.isFinite(details.targetduration) ||
            details.targetduration <= 0 ||
            details.age > details.targetduration * 3
        )
            return null;
        const edge = details.edge + details.age;
        const latency = edge - video.currentTime;
        return validDelay(latency) ? { edge, latency } : null;
    }
    // The native player does not expose its Hls instance. Learn the cadence from
    // advancing seekable boundaries, then advance that boundary on a monotonic clock.
    // No estimate is published until a second advancing observation is available.
    function nativeTiming(video, clock, now) {
        const available = ranges(video);
        const edge = available[available.length - 1]?.end;
        if (!Number.isFinite(edge) || !video.currentSrc || !Number.isFinite(now)) return { clock: null, timing: null };
        const fresh = () => ({ edge, at: now, source: video.currentSrc, intervals: [] });
        if (!clock || clock.source !== video.currentSrc || now < clock.at || edge < clock.edge) {
            return { clock: fresh(), timing: null };
        }
        const elapsed = (now - clock.at) / 1000;
        const cadence = Math.max(...clock.intervals, 0);
        if (cadence && elapsed > cadence * 3) return { clock: fresh(), timing: null };
        if (edge > clock.edge) {
            if (elapsed <= 0 || edge - clock.edge > (cadence || elapsed) * 3) return { clock: fresh(), timing: null };
            clock = { edge, at: now, source: video.currentSrc, intervals: [...clock.intervals, elapsed].slice(-3) };
        }
        if (!clock.intervals.length) return { clock, timing: null };
        const estimate = clock.edge + (now - clock.at) / 1000;
        const latency = estimate - video.currentTime;
        return { clock, timing: validDelay(latency) ? { edge: estimate, latency } : null };
    }
    // Per-channel keys avoid lost updates when different tabs adjust different channels.
    function delayKey(id) {
        if (!CHANNEL.test(id)) throw new Error("잘못된 채널입니다.");
        return DELAY_PREFIX + id;
    }
    function ranges(video) {
        const result = [];
        try {
            for (let i = 0; i < video.seekable.length; i += 1) {
                const start = video.seekable.start(i),
                    end = video.seekable.end(i);
                if (Number.isFinite(start) && Number.isFinite(end) && end > start) result.push({ start, end });
            }
        } catch {
            return [];
        }
        return result;
    }
    function seekTarget(video, delay, livePosition, estimatedEdge) {
        if (!validDelay(delay)) return { state: "unsupported" };
        if (video.error || video.ended || (video.readyState > 0 && Number.isFinite(video.duration))) {
            return { state: "unsupported" };
        }
        const available = ranges(video);
        if (!video.readyState || !available.length) return { state: "waiting" };
        const edge = Number.isFinite(estimatedEdge) ? estimatedEdge : available[available.length - 1].end;
        // Zero means the playable live position, not the not-yet-decodable end timestamp.
        const target = delay === 0 && Number.isFinite(livePosition) ? livePosition : edge - Math.max(0.1, delay);
        if (!available.some(({ start, end }) => target >= start && target < end)) return { state: "range", edge };
        return { state: "ready", target, edge };
    }
    function source(content, normalizeUrl) {
        if (content?.status !== "OPEN") throw new Error("방송이 종료되었거나 시청할 수 없어요.");
        let playback;
        try {
            playback = JSON.parse(content.livePlaybackJson);
        } catch {
            throw new Error("라이브 재생 정보를 확인할 수 없어요.");
        }
        const media = Array.isArray(playback?.media) ? playback.media : [];
        const selected = media.find((item) => item.mediaId === "LLHLS") || media.find((item) => item.mediaId === "HLS");
        const url = selected && normalizeUrl(selected.path);
        if (!url) throw new Error("지원하는 라이브 재생 소스가 없어요.");
        return {
            url,
            lowLatency: selected.mediaId === "LLHLS",
            name: String(content.channel?.channelName || ""),
            title: String(content.liveTitle || ""),
            liveId: String(content.liveId || ""),
        };
    }
    root.multiviewModel = {
        channelFromUrl,
        validDelay,
        splits,
        autoSplits,
        defaultTree,
        validTree,
        treeLayout,
        mapTree,
        removeTree,
        resizeTree,
        dockTree,
        moveMainTree,
        addTree,
        equalizeTree,
        snapRatio,
        replaceTree,
        session,
        readSession,
        readDelay,
        delayBasis,
        hlsTiming,
        nativeTiming,
        delayKey,
        DELAY_PREFIX,
        SESSION_KEY,
        ranges,
        seekTarget,
        source,
    };
})();
