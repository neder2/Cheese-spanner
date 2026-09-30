/** history.html의 파일 선택·다운로드·확인 화면. 기록 계산과 쓰기는 background에 요청해요. */
(() => {
    "use strict";

    const MESSAGE_TYPE = "betterchzzk:watch-history-backup";
    const RESPONSE_TIMEOUT_MS = 30000;
    let initialized = false;

    function init({ reload }) {
        if (initialized) return;
        initialized = true;
        const api = globalThis.BetterChzzkWatchHistoryBackup;
        const element = (suffix) => document.getElementById(`historyBackup${suffix}`);
        const area = element("");
        const exportButton = element("Export");
        const importButton = element("Import");
        const fileInput = element("File");
        const preview = element("Preview");
        const applyButton = element("Apply");
        const cancelButton = element("Cancel");
        const status = element("Status");
        let generation = 0;
        let active = true;
        let phase = "idle";
        let candidate = null;
        let filename = "";
        let result = null;
        let reader = null;
        const pending = new Set();
        const downloadUrls = new Map();

        function current(id) {
            return active && id === generation;
        }

        function showStatus(message, error = false) {
            status.textContent = message;
            status.dataset.error = String(error);
        }

        function setPhase(next) {
            phase = next;
            const busy = !["idle", "preview"].includes(phase);
            area.dataset.phase = phase;
            preview.setAttribute("aria-busy", String(busy));
            exportButton.disabled = busy;
            importButton.disabled = busy;
            fileInput.disabled = busy;
            applyButton.disabled =
                phase !== "preview" || !result || result.summary.added + result.summary.updated === 0;
            cancelButton.hidden = !["reading", "checking", "preview"].includes(phase);
            cancelButton.disabled = cancelButton.hidden;
        }

        function clearPreview() {
            candidate = null;
            result = null;
            filename = "";
            preview.hidden = true;
        }

        function abandon() {
            generation++;
            reader?.abort();
            reader = null;
            for (const cancel of pending) cancel();
            clearPreview();
            fileInput.value = "";
        }

        function request(action, fields = {}) {
            return new Promise((resolve, reject) => {
                let settled = false;
                const finish = (error, value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    pending.delete(cancel);
                    if (error) reject(error);
                    else resolve(value);
                };
                const cancel = () => finish(new Error("요청 확인을 중단했어요."));
                pending.add(cancel);
                const lost = () => finish(new Error("응답을 확인하지 못했어요. 다시 시도해 주세요."));
                const timer = setTimeout(lost, RESPONSE_TIMEOUT_MS);
                try {
                    chrome.runtime.sendMessage({ type: MESSAGE_TYPE, version: 1, action, ...fields }, (response) => {
                        const runtimeError = chrome.runtime.lastError;
                        if (runtimeError) return lost();
                        if (response?.ok === false && typeof response.error?.message === "string") {
                            const error = new Error(response.error.message);
                            error.confirmedFailure = true;
                            return finish(error);
                        }
                        if (!response?.ok || !response.result) return lost();
                        finish(null, response.result);
                    });
                } catch {
                    lost();
                }
            });
        }

        function readFile(file) {
            if (typeof file.text === "function")
                return Promise.resolve()
                    .then(() => file.text())
                    .catch(() => {
                        throw new Error("파일을 읽지 못했어요. 원본 파일을 다시 선택해 주세요.");
                    });
            return new Promise((resolve, reject) => {
                const fileReader = new FileReader();
                reader = fileReader;
                const finish = () => {
                    if (reader === fileReader) reader = null;
                };
                fileReader.onload = () => {
                    finish();
                    resolve(fileReader.result);
                };
                fileReader.onerror = () => {
                    finish();
                    reject(new Error("파일을 읽지 못했어요. 원본 파일을 다시 선택해 주세요."));
                };
                fileReader.onabort = () => {
                    finish();
                    reject(new Error("파일 읽기를 취소했어요."));
                };
                fileReader.readAsText(file, "UTF-8");
            });
        }

        function formatTime(value) {
            return new Intl.DateTimeFormat("ko-KR", {
                timeZone: "Asia/Seoul",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: false,
            }).format(new Date(value));
        }

        function showPreview(outcome) {
            result = outcome;
            const summary = outcome.summary;
            const values = [
                ["파일 생성 시각 (한국 시간)", formatTime(summary.exportedAt)],
                [
                    "기록 기간 (한국 시간)",
                    summary.periodStartAt === null
                        ? "기록 없음"
                        : `${formatTime(summary.periodStartAt)} ~ ${formatTime(summary.periodEndAt)}`,
                ],
                ["방송", `${summary.records.toLocaleString("ko-KR")}개`],
                ["보관된 채팅 본문", `${summary.storedChats.toLocaleString("ko-KR")}개`],
                ["누적 채팅", `${summary.totalChats.toLocaleString("ko-KR")}개`],
                [
                    "적용 결과",
                    `추가 ${summary.added}개 · 갱신 ${summary.updated}개 · 동일 ${summary.unchanged}개 · 건너뜀 ${summary.skipped}개`,
                ],
            ];
            element("Filename").textContent = filename;
            const fragment = document.createDocumentFragment();
            for (const [label, value] of values) {
                const group = document.createElement("div");
                const term = document.createElement("dt");
                const description = document.createElement("dd");
                term.textContent = label;
                description.textContent = value;
                group.append(term, description);
                fragment.append(group);
            }
            element("Summary").replaceChildren(fragment);
            element("Restore").textContent = summary.restored
                ? `삭제했던 기록이 있는 방송 ${summary.restored}개의 시청 기록·내 채팅을 복원해요. 이 내용을 확인한 뒤 기록 합치기를 눌러 주세요.`
                : "삭제했던 기록의 복원 대상은 없어요.";
            const skipped = outcome.items.filter((item) => item.disposition === "skipped");
            const list = element("SkippedList");
            list.replaceChildren();
            for (const item of skipped) {
                const row = document.createElement("li");
                const reason =
                    item.reason === "identity-conflict"
                        ? "방송 식별 정보가 충돌해 정확히 합칠 수 없어요."
                        : "기존 기록의 상세 정보가 부족해 중복을 확인할 수 없어요.";
                row.textContent = `${item.title || "제목 없는 방송"} · ${item.channelName || "채널 이름 없음"} — ${reason}`;
                list.append(row);
            }
            element("Skipped").hidden = skipped.length === 0;
            element("SkippedTitle").textContent = `건너뛸 방송 ${skipped.length}개 · 현재 기록을 유지해요`;
            preview.hidden = false;
            setPhase("preview");
            if (outcome.status === "reconfirm") {
                showStatus("현재 기록이나 확인 유효 시간이 바뀌었어요. 새 미리보기를 확인한 뒤 다시 합쳐 주세요.");
            } else if (summary.records === 0) {
                showStatus("빈 백업 파일이에요. 적용할 기록이 없어요.");
            } else if (summary.added + summary.updated === 0) {
                showStatus(
                    summary.skipped
                        ? "동일하거나 정확히 합칠 수 없는 기록만 있어요. 현재 기록은 변경하지 않아요."
                        : "모든 기록이 현재 기록과 같아요. 변경할 내용이 없어요."
                );
            } else {
                showStatus(
                    "파일 검사가 끝났어요. 복원·건너뜀 내용을 확인한 뒤 기록을 합쳐 주세요. 아직 저장하지 않았어요."
                );
            }
            element("PreviewTitle").focus({ preventScroll: true });
        }

        importButton.addEventListener("click", () => {
            if (!["idle", "preview"].includes(phase)) return;
            fileInput.value = "";
            fileInput.click();
        });

        fileInput.addEventListener("change", async () => {
            if (!active || ["exporting", "importing", "refreshing"].includes(phase)) return;
            const file = fileInput.files?.[0];
            if (!file) return;
            abandon();
            const id = generation;
            filename = file.name;
            setPhase("reading");
            showStatus("백업 파일을 읽고 있어요.");
            try {
                if (file.size > api.LIMITS.maxBytes)
                    throw new Error("16 MiB 이하의 백업 파일을 선택해 주세요. 기록은 변경하지 않았어요.");
                const text = await readFile(file);
                if (!current(id)) return;
                setPhase("checking");
                showStatus("파일 내용과 현재 기록에 합칠 결과를 확인하고 있어요.");
                candidate = api.parseBackup(text);
                const outcome = await request("preview", { backup: candidate });
                if (!current(id)) return;
                if (outcome.status !== "preview")
                    throw new Error("미리보기 응답을 확인하지 못했어요. 파일을 다시 선택해 주세요.");
                showPreview(outcome);
            } catch (error) {
                if (!current(id)) return;
                clearPreview();
                setPhase("idle");
                showStatus(error.message || "백업 파일을 확인하지 못했어요. 다시 선택해 주세요.", true);
                importButton.focus({ preventScroll: true });
            }
        });

        cancelButton.addEventListener("click", () => {
            if (!["reading", "checking", "preview"].includes(phase)) return;
            abandon();
            setPhase("idle");
            showStatus("불러오기를 취소했어요. 기록은 변경하지 않았어요.");
            importButton.focus({ preventScroll: true });
        });

        area.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && !cancelButton.hidden && !cancelButton.disabled) {
                event.preventDefault();
                cancelButton.click();
            }
        });

        applyButton.addEventListener("click", async () => {
            if (phase !== "preview" || applyButton.disabled || !candidate) return;
            const id = generation;
            setPhase("importing");
            showStatus("최신 기록을 확인하고 합치고 있어요.");
            try {
                const outcome = await request("import", {
                    backup: candidate,
                    confirmationToken: result.confirmationToken,
                });
                if (!current(id)) return;
                if (outcome.status === "reconfirm") {
                    showPreview(outcome);
                    return;
                }
                if (!["applied", "unchanged"].includes(outcome.status)) throw new Error("응답을 확인하지 못했어요.");
                clearPreview();
                setPhase("refreshing");
                showStatus(
                    outcome.status === "applied"
                        ? "기록을 합쳤어요. 화면을 새로 읽고 있어요."
                        : "기록이 같아 변경하지 않았어요. 화면을 새로 읽고 있어요."
                );
                let refreshed = false;
                try {
                    refreshed = await reload();
                } catch {
                    // 저장 결과와 화면 재조회 결과를 분리해 안내해요.
                }
                if (!current(id)) return;
                setPhase("idle");
                const saved = outcome.status === "applied" ? "기록을 합쳤어요." : "기록이 같아 변경하지 않았어요.";
                showStatus(
                    refreshed
                        ? `${saved} 추가 ${outcome.summary.added}개 · 갱신 ${outcome.summary.updated}개 · 동일 ${outcome.summary.unchanged}개 · 건너뜀 ${outcome.summary.skipped}개.`
                        : `${saved} 화면을 다시 읽지 못했어요. 새로고침 버튼으로 현재 기록을 확인해 주세요.`,
                    !refreshed
                );
                importButton.focus({ preventScroll: true });
            } catch (error) {
                if (!current(id)) return;
                clearPreview();
                setPhase("idle");
                showStatus(
                    error.confirmedFailure
                        ? error.message
                        : "합치기 결과를 확인하지 못했어요. 새로고침으로 현재 기록을 확인해 주세요. 같은 파일을 다시 불러와도 중복해서 합치지 않아요.",
                    true
                );
                importButton.focus({ preventScroll: true });
            }
        });

        function releaseUrl(url) {
            clearTimeout(downloadUrls.get(url));
            downloadUrls.delete(url);
            URL.revokeObjectURL(url);
        }

        exportButton.addEventListener("click", async () => {
            if (!active || !["idle", "preview"].includes(phase)) return;
            abandon();
            const id = generation;
            setPhase("exporting");
            showStatus("전체 기간의 시청 기록과 내 채팅으로 백업 파일을 만들고 있어요.");
            try {
                const outcome = await request("export");
                if (!current(id)) return;
                if (outcome.status !== "exported") throw new Error("백업 응답을 확인하지 못했어요.");
                const file = api.validateBackup(outcome.backup);
                const blob = new Blob([JSON.stringify(file)], { type: "application/json;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                downloadUrls.set(
                    url,
                    setTimeout(() => releaseUrl(url), 1000)
                );
                const link = document.createElement("a");
                const parts = new Intl.DateTimeFormat("sv-SE", {
                    timeZone: "Asia/Seoul",
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                    hour12: false,
                }).formatToParts(new Date(file.createdAt));
                const part = (type) => parts.find((value) => value.type === type).value;
                link.download = `cheese-spanner-history-${part("year")}${part("month")}${part("day")}-${part("hour")}${part("minute")}${part("second")}.json`;
                link.href = url;
                link.hidden = true;
                document.body.append(link);
                try {
                    link.click();
                } finally {
                    link.remove();
                }
                setPhase("idle");
                showStatus("백업 파일 다운로드를 시작했어요. 브라우저의 다운로드 목록에서 저장 결과를 확인해 주세요.");
                exportButton.focus({ preventScroll: true });
            } catch (error) {
                if (!current(id)) return;
                setPhase("idle");
                showStatus(error.message || "백업 파일을 만들지 못했어요. 다시 시도해 주세요.", true);
            }
        });

        window.addEventListener("pagehide", () => {
            active = false;
            abandon();
            for (const url of downloadUrls.keys()) releaseUrl(url);
        });
        window.addEventListener("pageshow", (event) => {
            if (!event.persisted) return;
            active = true;
            setPhase("idle");
            showStatus("현재 기록을 새로고침하고 백업 파일을 다시 선택해 주세요.");
        });
        setPhase("idle");
    }

    globalThis.BetterChzzkHistoryBackup = Object.freeze({ init });
})();
