/** 멀티뷰 플레이어·미디어 이벤트·딜레이 저장 큐의 수명주기를 소유해요. */
(() => {
    const root = (window.BetterChzzk = window.BetterChzzk || {});
    const model = root.multiviewModel;
    const { fetchJson, storageGet, storageSet, normalizeChzzkMediaUrl } = root.utils;
    const MEDIA_EVENTS = [
        "loadedmetadata",
        "durationchange",
        "progress",
        "canplay",
        "seeked",
        "timeupdate",
        "emptied",
        "error",
        "ended",
        "play",
        "pause",
        "resize",
    ];
    const STATES = {
        waiting: "복원 대기",
        range: "복원 대기 · 재생 범위 부족",
        seeking: "딜레이 적용 중",
        applied: "적용 완료",
        unsupported: "적용 불가",
        changed: "재생 위치 변경 · 다시 적용 가능",
    };

    function create({ state, onChange: updatePlayerUi, onGeometry: positionCells, persistSession }) {
        const players = new Map();
        let active = false,
            routeId = null,
            native = null,
            oldMedia = null;
        let applyingSlotAudio = false,
            saveQueue = Promise.resolve();
        function current(player) {
            return active && state.active && players.get(player.id) === player && !player.abort.signal.aborted;
        }
        function captureAudio(player) {
            if (applyingSlotAudio) return;
            const entry = state.channels.find((item) => item.id === player.id);
            if (!entry || !player.video) return;
            if (entry.volume === player.video.volume && entry.muted === player.video.muted) {
                updatePlayerUi(player);
                return;
            }
            entry.volume = player.video.volume;
            entry.muted = player.video.muted;
            persistSession();
            updatePlayerUi(player);
        }
        function transferSlotAudio(assignments) {
            // Entries cache the sound of the occupied slot; take every source before changing any occupant.
            const sounds = new Map(
                state.channels.map((entry) => {
                    const player = players.get(entry.id);
                    const video = player && current(player) && player.video;
                    return [
                        entry.id,
                        { volume: video ? video.volume : entry.volume, muted: video ? video.muted : entry.muted },
                    ];
                })
            );
            const changed = [];
            for (const [id, previousId] of assignments) {
                const entry = state.channels.find((item) => item.id === id);
                if (!entry) continue;
                const sound = sounds.get(previousId) || { volume: 0.3, muted: true };
                entry.volume = sound.volume;
                entry.muted = sound.muted;
                changed.push(entry);
            }
            // Volume setters can synchronously emit volumechange; never capture an intermediate assignment.
            applyingSlotAudio = true;
            try {
                // Silence outgoing occupants before enabling the sound of incoming ones.
                for (const entry of changed) {
                    const player = players.get(entry.id);
                    if (player && current(player) && player.video && entry.muted) player.video.muted = true;
                }
                for (const entry of changed) {
                    const player = players.get(entry.id);
                    if (!player || !current(player) || !player.video) continue;
                    player.video.volume = entry.volume;
                    player.video.muted = entry.muted;
                    updatePlayerUi(player);
                }
            } finally {
                applyingSlotAudio = false;
            }
        }
        function moveSlotAudio(before, after, source, target, side) {
            if (side === "center") {
                const oldSlots = new Map(model.treeLayout(before).cells.map((cell) => [cell.path, cell.id]));
                transferSlotAudio(
                    model
                        .treeLayout(after)
                        .cells.filter((cell) => cell.id)
                        .map((cell) => [cell.id, oldSlots.get(cell.path)])
                );
            } else {
                // Splitting a destination or moving a group exchanges the two selected places.
                transferSlotAudio([
                    [source, target],
                    [target, source],
                ]);
            }
        }
        const qualityKey = (id) => `betterChzzkMultiviewQuality:${id}`;
        const readQuality = (value) => (Number.isInteger(value) && value > 0 && value <= 8640 ? value : 0);
        function qualityLevels(player) {
            const levels = new Map();
            for (const [index, level] of (player.hls?.levels || []).entries()) {
                const height = readQuality(level.height);
                if (height > 360) levels.set(height, index);
            }
            return levels;
        }
        function applyQuality(player) {
            if (!current(player) || !player.hls) return;
            const index = qualityLevels(player).get(player.quality);
            player.hls.capLevelToPlayerSize = index === undefined;
            player.hls.nextLevel = index ?? -1;
            updatePlayerUi(player);
        }
        function setQuality(player, height) {
            if (
                !current(player) ||
                player.main ||
                !player.qualityLoaded ||
                (height !== 0 && !qualityLevels(player).has(height))
            )
                return;
            player.quality = height;
            player.qualitySaving = true;
            player.qualityError = "";
            const revision = ++player.qualityRevision;
            applyQuality(player);
            saveQueue = saveQueue
                .catch(() => {})
                .then(() =>
                    storageSet(chrome.storage.local, {
                        [qualityKey(player.id)]: height,
                    })
                )
                .then(() => {
                    if (player.qualityRevision === revision) player.qualitySaving = false;
                })
                .catch(() => {
                    if (player.qualityRevision === revision) {
                        player.qualitySaving = false;
                        player.qualityError = "화질 저장 실패 · 이번 재생에만 적용돼요. 다시 선택해 주세요.";
                    }
                })
                .finally(() => {
                    if (current(player)) updatePlayerUi(player);
                });
        }
        function isAd(player) {
            return player.main && Boolean(native?.querySelector(".pzp-pc--adbreak"));
        }
        function measureTiming(player) {
            const video = player.video;
            if (
                !video ||
                !video.readyState ||
                Number.isFinite(video.duration) ||
                video.error ||
                video.ended ||
                isAd(player)
            ) {
                player.liveClock = null;
                return null;
            }
            if (!player.main) return model.hlsTiming(video, player.hls?.latestLevelDetails);
            const observation = model.nativeTiming(video, player.liveClock, performance.now());
            player.liveClock = observation.clock;
            return observation.timing;
        }
        function applyDelay(player, eventType) {
            if (!current(player) || !player.loaded || !player.video) return;
            const video = player.video;
            if (eventType === "emptied") player.liveClock = null;
            const timing = measureTiming(player);
            if (video.error || video.ended) {
                player.pending = null;
                player.status = "unsupported";
                player.applied = true;
                updatePlayerUi(player);
                return;
            }
            if (isAd(player)) {
                player.status = "waiting";
                updatePlayerUi(player);
                return;
            }
            if (eventType === "emptied") {
                player.applied = false;
                player.pending = null;
            }
            if (player.pending) {
                if (eventType === "seeked" || (!video.seeking && eventType === "timeupdate")) {
                    const elapsed = video.paused ? 0 : (performance.now() - player.pending.at) / 1000;
                    const arrived = Math.abs(video.currentTime - player.pending.time - elapsed) < 0.75;
                    player.status = arrived ? "applied" : "unsupported";
                    player.applied = true;
                    player.pending = null;
                }
                updatePlayerUi(player);
                return;
            }
            if (player.applied) {
                if (video.error || video.ended) player.status = "unsupported";
                updatePlayerUi(player);
                return;
            }
            if (player.delay > 0 && player.delayBasis !== "legacy" && !timing) {
                player.status = "waiting";
                updatePlayerUi(player);
                return;
            }
            const result = model.seekTarget(
                video,
                player.delay,
                player.hls?.liveSyncPosition,
                player.delay > 0 && player.delayBasis !== "legacy" ? timing?.edge : undefined
            );
            if (result.state !== "ready") {
                player.status = result.state;
                updatePlayerUi(player);
                return;
            }
            try {
                player.pending = { time: result.target, at: performance.now() };
                player.status = "seeking";
                video.currentTime = result.target;
            } catch {
                player.pending = null;
                player.applied = true;
                player.status = "unsupported";
            }
            updatePlayerUi(player);
        }
        function tuneHls(player) {
            if (!player.hls) return;
            // Hls.targetLatency is a public setter; keep automatic catch-up from undoing the chosen delay.
            if (player.delay > 0) player.hls.targetLatency = player.delay;
            else if (Number.isFinite(player.defaultLatency)) player.hls.targetLatency = player.defaultLatency;
        }
        function setDelay(player, value, basis = "live-edge-clock") {
            if (!player?.loaded || !model.validDelay(value)) return;
            const rounded = Math.round(value * 10) / 10;
            if (!model.validDelay(rounded)) return;
            player.delay = rounded;
            player.delayBasis = basis;
            player.applied = false;
            player.pending = null;
            player.saveError = "";
            player.saving = true;
            const delay = player.delay,
                revision = ++player.revision;
            tuneHls(player);
            applyDelay(player);
            saveQueue = saveQueue
                .catch(() => {})
                .then(async () => {
                    if (!chrome.storage?.local) throw new Error("저장소를 사용할 수 없어요.");
                    await storageSet(chrome.storage.local, {
                        [model.delayKey(player.id)]:
                            basis === "legacy"
                                ? { version: 1, delaySeconds: delay }
                                : { version: 2, basis: "live-edge-clock", delaySeconds: delay },
                    });
                })
                .then(() => {
                    if (player.revision !== revision) return;
                    player.savedDelay = delay;
                    player.savedBasis = basis;
                    player.saving = false;
                    if (current(player)) updatePlayerUi(player);
                })
                .catch(() => {
                    if (player.revision !== revision) return;
                    player.saving = false;
                    player.saveError =
                        "딜레이 저장 실패 · 조절 값은 이번 재생에만 적용돼요. 다시 저장을 눌러 저장할 수 있어요.";
                    if (current(player)) updatePlayerUi(player);
                });
        }
        function bindVideo(player, video) {
            if (player.video === video) return;
            player.unbind?.();
            player.video = video;
            player.liveClock = null;
            player.applied = false;
            player.pending = null;
            if (!video) return;
            const entry = state.channels.find((item) => item.id === player.id);
            video.volume = entry.volume;
            video.muted = entry.muted;
            const onMedia = (event) => {
                if (!current(player) || player.video !== video) return;
                applyDelay(player, event.type);
                if (event.type === "loadedmetadata" || event.type === "resize") positionCells();
            };
            const onVolume = () => {
                if (current(player)) captureAudio(player);
            };
            const onSeeking = () => {
                if (current(player) && player.applied && !player.pending) {
                    player.status = "changed";
                    updatePlayerUi(player);
                }
            };
            for (const type of MEDIA_EVENTS) video.addEventListener(type, onMedia);
            video.addEventListener("volumechange", onVolume);
            video.addEventListener("seeking", onSeeking);
            player.unbind = () => {
                for (const type of MEDIA_EVENTS) video.removeEventListener(type, onMedia);
                video.removeEventListener("volumechange", onVolume);
                video.removeEventListener("seeking", onSeeking);
            };
            applyDelay(player);
        }
        async function play(player) {
            try {
                await player.video?.play();
                if (current(player)) {
                    player.error = "";
                    updatePlayerUi(player);
                }
            } catch {
                if (current(player)) {
                    player.error = "재생 버튼을 눌러 시작해 주세요.";
                    updatePlayerUi(player);
                }
            }
        }
        async function loadPlayer(player) {
            const key = model.delayKey(player.id);
            try {
                if (!chrome.storage?.local) throw new Error("저장소 없음");
                const record = await storageGet(chrome.storage.local, [key, qualityKey(player.id)]);
                if (!current(player)) return;
                player.delay = player.savedDelay = model.readDelay(record[key]);
                player.delayBasis = player.savedBasis = model.delayBasis(record[key]);
                player.loaded = true;
                player.quality = readQuality(record[qualityKey(player.id)]);
                player.qualityLoaded = true;
            } catch {
                if (!current(player)) return;
                player.saveError = "저장된 딜레이를 읽지 못했어요. 재생 재시도로 다시 불러올 수 있어요.";
            }
            if (!current(player)) return;
            updatePlayerUi(player);
            try {
                const response = await fetchJson(
                    `https://api.chzzk.naver.com/service/v3/channels/${player.id}/live-detail`,
                    { signal: player.abort.signal, timeoutMs: 10000 }
                );
                if (!current(player)) return;
                const content = response?.content;
                if (content?.channel?.channelId !== player.id)
                    throw new Error("요청한 방송의 정보를 확인하지 못했어요.");
                player.name = content.channel.channelName;
                if (player.main) {
                    player.metaReady = content.status === "OPEN";
                    if (!player.metaReady) throw new Error("방송이 종료되었거나 시청할 수 없어요.");
                    syncNative();
                } else {
                    const source = model.source(content, normalizeChzzkMediaUrl);
                    if (!window.Hls?.isSupported?.())
                        throw new Error("이 환경에서는 보조 방송 재생을 지원하지 않아요.");
                    const hls = new window.Hls({
                        enableWorker: false,
                        lowLatencyMode: source.lowLatency,
                        capLevelToPlayerSize: true,
                        maxBufferLength: 30,
                        backBufferLength: 60,
                        liveDurationInfinity: true,
                        maxLiveSyncPlaybackRate: 1,
                        liveSyncOnStallIncrease: 0,
                    });
                    player.hls = hls;
                    const events = window.Hls.Events;
                    hls.on(events.MANIFEST_PARSED, () => {
                        if (current(player)) {
                            applyQuality(player);
                            play(player);
                        }
                    });
                    hls.on(events.LEVEL_UPDATED, () => {
                        if (!current(player)) return;
                        if (!Number.isFinite(player.defaultLatency) && Number.isFinite(hls.targetLatency))
                            player.defaultLatency = hls.targetLatency;
                        tuneHls(player);
                        applyDelay(player, "progress");
                    });
                    hls.on(events.ERROR, (_event, data) => {
                        if (!data?.fatal || !current(player)) return;
                        player.error = "방송 재생에 실패했어요. 재생 재시도를 눌러 주세요.";
                        player.status = "unsupported";
                        player.pending = null;
                        player.applied = true;
                        hls.stopLoad();
                        updatePlayerUi(player);
                    });
                    hls.attachMedia(player.video);
                    hls.loadSource(source.url);
                }
                updatePlayerUi(player);
            } catch (error) {
                if (!current(player)) return;
                player.error = error?.message || "방송 정보를 불러오지 못했어요.";
                player.status = "unsupported";
                updatePlayerUi(player);
            }
        }
        function dispose(player) {
            player.abort.abort();
            player.unbind?.();
            player.hls?.destroy();
            if (!player.main && player.video) {
                player.video.pause();
                player.video.removeAttribute("src");
                player.video.load();
                player.video.remove();
            }
            players.delete(player.id);
        }
        function ensurePlayers() {
            for (const player of [...players.values()]) {
                if (!state.channels.some((entry) => entry.id === player.id) || player.main !== (player.id === routeId))
                    dispose(player);
            }
            for (const entry of state.channels) {
                if (players.has(entry.id)) continue;
                const player = {
                    id: entry.id,
                    main: entry.id === routeId,
                    abort: new AbortController(),
                    video: null,
                    loaded: false,
                    savedDelay: 0,
                    delay: 0,
                    status: "waiting",
                    revision: 0,
                    quality: 0,
                    qualityRevision: 0,
                    qualityLoaded: false,
                    error: "",
                };
                players.set(entry.id, player);
                if (!player.main) {
                    const video = document.createElement("video");
                    video.setAttribute("data-bcmv-video", "1");
                    video.playsInline = true;
                    bindVideo(player, video);
                }
                void loadPlayer(player);
            }
            syncNative();
        }
        function syncNative(node = native) {
            native = node;
            const player = players.get(routeId);
            if (!player?.metaReady || !native?.isConnected) return;
            const video = native.querySelector("video.webplayer-internal-video");
            if (!video || (oldMedia?.video === video && oldMedia.src === video.currentSrc)) return;
            oldMedia = null;
            bindVideo(player, video);
            applyDelay(player);
        }
        function storageChanged(changes, area) {
            if (area !== "local") return;
            for (const player of players.values()) {
                const qualityChange = changes[qualityKey(player.id)];
                if (qualityChange && player.qualityLoaded && !player.qualitySaving) {
                    player.quality = readQuality(qualityChange.newValue);
                    applyQuality(player);
                }
                const change = changes[model.delayKey(player.id)];
                if (!change || player.saving || !player.loaded) continue;
                player.savedDelay = player.delay = model.readDelay(change.newValue);
                player.delayBasis = player.savedBasis = model.delayBasis(change.newValue);
                player.pending = null;
                player.applied = false;
                tuneHls(player);
                applyDelay(player);
            }
        }

        function reconcile(mainId, node) {
            if (!active) chrome.storage?.onChanged?.addListener(storageChanged);
            active = true;
            routeId = mainId;
            native = node;
            ensurePlayers();
        }
        function prepareRoute() {
            for (const player of players.values()) if (current(player) && player.video) captureAudio(player);
            const video = players.get(routeId)?.video;
            oldMedia = video ? { video, src: video.currentSrc } : null;
        }
        function clear(clearMediaGuard) {
            active = false;
            chrome.storage?.onChanged?.removeListener(storageChanged);
            for (const player of [...players.values()]) dispose(player);
            native = null;
            if (clearMediaGuard) oldMedia = null;
        }
        return {
            get: (id) => players.get(id),
            values: () => players.values(),
            get size() {
                return players.size;
            },
            current,
            reconcile,
            syncNative,
            prepareRoute,
            clear,
            dispose,
            play,
            measureTiming,
            setDelay,
            setQuality,
            qualityLevels,
            captureAudio,
            transferSlotAudio,
            moveSlotAudio,
        };
    }
    root.multiviewPlayback = { create, STATES };
})();
