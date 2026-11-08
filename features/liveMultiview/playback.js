/** 멀티뷰 플레이어·미디어 이벤트·딜레이 저장 큐의 수명주기를 소유해요. */
(() => {
    const root = (window.CheeseSpanner = window.CheeseSpanner || {});
    const model = root.multiviewModel;
    // Delay/quality choices are written through the worker's settings lock (settings restore boundary).
    const { fetchJson, storageGet, settingsStoreSet, normalizeChzzkMediaUrl } = root.utils;
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
        uncertain: "적용 확인 불가 · 다시 적용 가능",
    };
    // 딜레이 탐색의 도착 판정 허용 오차(초)와, 탐색 중 페이지가 계속 응답했는지 보는 관찰 간격(ms)이에요.
    const ARRIVAL_TOLERANCE = 0.75;
    const SEEK_WATCH_MS = 100;
    const SEEK_WATCH_GAP_MS = 250;
    // Chrome이 허용하는 최대 재생 배속이에요. 배속을 알 수 없는 구간의 진행 상한으로만 써요.
    const RATE_LIMIT = 16;
    // 탐색 도중이나 완료 뒤 재생 진행을 바꿀 수 있는 알림이에요. 그 밖의 알림은 판정을 마무리하는 신호로만 써요.
    const PLAYBACK_CHANGES = { ratechange: "rate", play: "play", pause: "stop", waiting: "stop", seeking: "seek" };
    const PLAYBACK_ONLY_EVENTS = ["ratechange", "waiting"];

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
                    settingsStoreSet("local", {
                        [qualityKey(player.id)]: height,
                    })
                )
                .then(() => {
                    if (player.qualityRevision === revision) player.qualitySaving = false;
                })
                .catch(() => {
                    if (player.qualityRevision === revision) {
                        player.qualitySaving = false;
                        player.qualityError = "화질 저장 실패 · 이번 재생에만 적용(재선택 필요).";
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
        // 탐색 대기를 재생 진행과 나누려고, 탐색 중에만 짧은 간격으로 요소를 지켜봐요. 직전 관찰부터 지금까지 페이지가
        // 제때 응답했는데도 아직 seeking이면, 그 사이 끝난 탐색의 완료 알림이 처리됐을 것이므로 재생 재개는 직전 관찰
        // 뒤예요(since). Chrome은 페이지가 멈춘 동안에도 탐색을 끝내고 재생을 이어 가며, 그동안 seeking은 true이고
        // currentTime은 목표를 돌려줘요(r3 실측). 그래서 늦게 실행된 관찰(간격 SEEK_WATCH_GAP_MS 초과)은 하한을 올리지
        // 않아요. 관찰은 이 탐색이 판정되거나 바뀌면 스스로 멈춰요.
        function watchSeek(player, pending) {
            const tick = () => {
                if (player.pending !== pending || !current(player) || player.video !== pending.video) return;
                if (pending.judgment || !pending.video.seeking) return;
                const now = performance.now();
                if (now - pending.seen <= SEEK_WATCH_GAP_MS) pending.since = pending.seen;
                pending.seen = now;
                setTimeout(tick, SEEK_WATCH_MS);
            };
            setTimeout(tick, SEEK_WATCH_MS);
        }
        // 지금 배속이에요. Chrome은 0 배속을 받아들이고, 그때는 재생 중(paused=false)이어도 진행하지 않아요(r5 m1 실측).
        // 그래서 0은 그대로 쓰고, 유한한 0 이상이 아닌 값은 배속을 모르는 것으로(null) 봐요.
        const playbackRate = (video) =>
            Number.isFinite(video.playbackRate) && video.playbackRate >= 0 ? video.playbackRate : null;
        // 알림이 만들어진 시각(event.timeStamp)이에요. 다른 시간 기준이거나 앞으로의 시각이면 쓰지 않아요.
        function createdAt(event) {
            const stamp = event?.timeStamp;
            return Number.isFinite(stamp) && stamp <= performance.now() ? stamp : null;
        }
        // 실제 도착 뒤 판정 시각까지 재생이 나아갔을 수 있는 범위 [최소, 최대](초)예요. 재생 상태는 지금 값을 과거로
        // 소급하지 않고, 알림으로 확인한 이력만 써요. Chrome은 한 요소의 미디어 알림을 만든 순서대로 전달해요(r4 m1 실측:
        // 완료 처리 뒤에 전달된 pause·play·ratechange의 timeStamp는 조작한 시각이었어요). 그래서 완료 이벤트보다 먼저 만든
        // 알림은 판정 전에 받았고(pending.changes), 완료 이벤트가 만들어진 뒤의 변경은 판정 뒤에 와요(changes, 아직 모르면
        // null). 재생 구간을 알 수 없으면 최소는 0이고, 배속 변경이 있었거나 배속을 모르는 구간의 최대는 RATE_LIMIT로
        // 잡아요. 완료 이벤트가 만들어진 뒤 변경 알림이 없으면 그 구간은 판정 때의 상태·배속 그대로였어요. 최소는 그 구간을
        // 그 배속으로 재생했음이 확인될 때만 그 경과로 잡아요(r3 실측: Chrome은 재생을 이어 간 뒤 완료 이벤트를 만들었어요).
        function progressRange(pending, judgment, changes) {
            const unknown = !changes,
                anyRate = Math.max(RATE_LIMIT, pending.rate ?? 0, judgment.rate ?? 0);
            const rateBefore = pending.changes.has("rate") || pending.rate === null ? anyRate : pending.rate,
                rateAfter = unknown || changes.has("rate") || judgment.rate === null ? anyRate : judgment.rate;
            const playedBefore = !pending.paused || pending.changes.has("play");
            if (!playedBefore && !unknown && !changes.has("play")) return [0, 0];
            const start = judgment.created ?? pending.since;
            const before = playedBefore ? ((start - pending.since) / 1000) * rateBefore : 0,
                after = ((judgment.at - start) / 1000) * rateAfter;
            if (unknown || changes.size) return [0, before + after];
            if (judgment.paused) return [0, before];
            return [judgment.created !== null && judgment.ready && judgment.rate !== null ? after : 0, before + after];
        }
        // 도착 범위 전체가 목표 근처면 적용 완료, 전체가 벗어나면 적용 불가, 걸치면 확인 불가예요.
        function judge(pending, judgment, changes) {
            const [least, most] = progressRange(pending, judgment, changes);
            const earliest = judgment.offset - most,
                latest = judgment.offset - least;
            return earliest > -ARRIVAL_TOLERANCE && latest < ARRIVAL_TOLERANCE
                ? "applied"
                : latest <= -ARRIVAL_TOLERANCE || earliest >= ARRIVAL_TOLERANCE
                  ? "unsupported"
                  : "uncertain";
        }
        function settle(player, judgment) {
            const pending = player.pending;
            if (!pending || pending.judgment !== judgment || !current(player) || player.video !== pending.video) return;
            player.status = judge(pending, judgment, judgment.changes);
            player.applied = true;
            player.pending = null;
            updatePlayerUi(player);
        }
        // 탐색 중과 판정 대기 중의 미디어 알림을 기록해요. 판정 시각 뒤에 만든 알림이 오면 그보다 먼저 만든 알림은 모두
        // 받았으므로 판정을 마무리해요. 완료 뒤 다른 탐색이 시작됐으면 도착을 되짚을 수 없으니 바로 마무리하고, 이어지는
        // seeking 처리가 '재생 위치 변경'으로 표시해요.
        function notePlayback(player, event) {
            const pending = player.pending,
                change = PLAYBACK_CHANGES[event.type];
            if (!pending || pending.video !== player.video) return;
            const judgment = pending.judgment;
            if (!judgment) {
                if (change === "rate" || change === "play") pending.changes.add(change);
                return;
            }
            const created = createdAt(event);
            if (created !== null && created > judgment.at) return settle(player, judgment);
            if (!change) return;
            judgment.changes.add(change);
            if (change === "seek") settle(player, judgment);
        }
        function applyDelay(player, eventType, event) {
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
                const pending = player.pending;
                if (!pending.judgment && (eventType === "seeked" || (!video.seeking && eventType === "timeupdate"))) {
                    // 처음 받는 완료 이벤트에서 지금 위치로부터 도착 위치의 범위를 되짚어요. 지켜본 탐색 대기는 재생 진행이
                    // 아니므로 허용 오차로 세지 않고, 완료 이벤트가 만들어진 뒤의 진행은 도착 오차로 세지 않아요. 페이지가
                    // 멈춰 대기와 재생을 나눌 수 없어 범위가 걸치면 어느 쪽으로도 확정하지 않아요.
                    const at = performance.now(),
                        created = createdAt(event);
                    const judgment = {
                        offset: video.currentTime - pending.time,
                        at,
                        created: created !== null && created >= pending.since && created <= at ? created : null,
                        paused: video.paused,
                        ready: video.readyState >= 3,
                        rate: playbackRate(video),
                        changes: new Set(),
                    };
                    // 완료 이벤트가 만들어진 뒤의 상태 변경 알림은 아직 오지 않았을 수 있어요. 어떤 변경이 있었든 같은
                    // 판정이면 바로 확정하고, 아니면 그 알림을 받은 뒤(판정 뒤에 만든 알림 또는 짧은 타이머)에 확정해요.
                    const status = judge(pending, judgment, null);
                    if (status === judge(pending, judgment, new Set())) {
                        player.status = status;
                        player.applied = true;
                        player.pending = null;
                    } else {
                        pending.judgment = judgment;
                        setTimeout(() => settle(player, judgment), SEEK_WATCH_MS);
                    }
                }
                updatePlayerUi(player);
                return;
            }
            if (player.applied) {
                if (video.error || video.ended) player.status = "unsupported";
                updatePlayerUi(player);
                return;
            }
            // 메인의 0초 목표는 네이티브 플레이어의 기본 라이브 위치예요. 메인에는 hls의 라이브 위치가 없어 보정하지
            // 않은 탐색 끝으로 옮기게 되므로, 켜기·소스 교체 때 사용자가 고른 메인 재생 위치를 바꾸지 않아요.
            if (player.main && player.delay === 0) {
                player.status = "applied";
                player.applied = true;
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
                const at = performance.now();
                player.pending = {
                    time: result.target,
                    video,
                    since: at,
                    seen: at,
                    rate: playbackRate(video),
                    paused: video.paused,
                    changes: new Set(),
                    judgment: null,
                };
                watchSeek(player, player.pending);
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
                    if (!chrome.storage?.local) throw new Error("저장소 사용 불가.");
                    await settingsStoreSet("local", {
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
                    player.saveError = "딜레이 저장 실패 · 이번 재생에만 적용(다시 저장 가능).";
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
                notePlayback(player, event);
                applyDelay(player, event.type, event);
                if (event.type === "loadedmetadata" || event.type === "resize") positionCells();
            };
            const onVolume = () => {
                if (current(player)) captureAudio(player);
            };
            const onPlayback = (event) => {
                if (current(player) && player.video === video) notePlayback(player, event);
            };
            const onSeeking = (event) => {
                if (current(player) && player.video === video) notePlayback(player, event);
                if (current(player) && player.applied && !player.pending) {
                    player.status = "changed";
                    updatePlayerUi(player);
                }
            };
            for (const type of MEDIA_EVENTS) video.addEventListener(type, onMedia);
            video.addEventListener("volumechange", onVolume);
            video.addEventListener("seeking", onSeeking);
            for (const type of PLAYBACK_ONLY_EVENTS) video.addEventListener(type, onPlayback);
            player.unbind = () => {
                for (const type of MEDIA_EVENTS) video.removeEventListener(type, onMedia);
                video.removeEventListener("volumechange", onVolume);
                video.removeEventListener("seeking", onSeeking);
                for (const type of PLAYBACK_ONLY_EVENTS) video.removeEventListener(type, onPlayback);
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
                    player.error = "재생 버튼 클릭 필요.";
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
                player.saveError = "저장된 딜레이 읽기 실패(재생 재시도로 다시 불러오기 가능).";
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
                if (content?.channel?.channelId !== player.id) throw new Error("요청 방송 정보 확인 불가.");
                player.name = content.channel.channelName;
                if (player.main) {
                    player.metaReady = content.status === "OPEN";
                    if (!player.metaReady) throw new Error("방송 종료 또는 시청 불가.");
                    syncNative();
                } else {
                    const source = model.source(content, normalizeChzzkMediaUrl);
                    if (!window.Hls?.isSupported?.()) throw new Error("이 환경에서는 보조 방송 재생 미지원.");
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
                        player.error = "방송 재생 실패. 재생 재시도 클릭 필요.";
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
                player.error = error?.message || "방송 정보 불러오기 실패.";
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
