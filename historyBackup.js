/** history.html의 파일 선택·다운로드·확인 화면. 기록 계산과 쓰기는 background에 요청해요. */
(() => {
    "use strict";

    const MESSAGE_TYPE = "cheese-spanner:watch-history-backup";
    const RESPONSE_TIMEOUT_MS = 30000;
    let initialized = false;

    function init({ reload }) {
        if (initialized) return;
        initialized = true;
        const api = globalThis.CheeseSpannerWatchHistoryBackup;
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
                const cancel = () => finish(new Error("요청 확인 중단"));
                pending.add(cancel);
                const lost = () => finish(new Error("응답 확인 실패. 다시 시도."));
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
                        throw new Error("파일 읽기 실패. 원본 파일 다시 선택.");
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
                    reject(new Error("파일 읽기 실패. 원본 파일 다시 선택."));
                };
                fileReader.onabort = () => {
                    finish();
                    reject(new Error("파일 읽기 취소"));
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
                ? `삭제한 기록이 있는 방송 ${summary.restored}개의 시청 기록·내 채팅 복원 예정. 확인 후 ‘기록 합치기’ 선택.`
                : "복원할 삭제 기록 없음";
            const skipped = outcome.items.filter((item) => item.disposition === "skipped");
            const list = element("SkippedList");
            list.replaceChildren();
            for (const item of skipped) {
                const row = document.createElement("li");
                const reason =
                    item.reason === "identity-conflict"
                        ? "방송 식별 정보 충돌로 병합 불가"
                        : "기존 기록의 상세 정보가 부족해 중복 확인 불가";
                row.textContent = `${item.title || "제목 없는 방송"} · ${item.channelName || "채널 이름 없음"} — ${reason}`;
                list.append(row);
            }
            element("Skipped").hidden = skipped.length === 0;
            element("SkippedTitle").textContent = `건너뛸 방송 ${skipped.length}개 · 현재 기록 유지`;
            preview.hidden = false;
            setPhase("preview");
            if (outcome.status === "reconfirm") {
                showStatus("기록이 바뀌었거나 확인 시간이 만료됨. 새 미리보기 확인 후 다시 합치기.");
            } else if (summary.records === 0) {
                showStatus("빈 백업 파일. 적용할 기록 없음.");
            } else if (summary.added + summary.updated === 0) {
                showStatus(
                    summary.skipped
                        ? "같은 기록 또는 정확히 합칠 수 없는 기록만 있음. 현재 기록 유지."
                        : "백업과 현재 기록이 같아 변경 없음"
                );
            } else {
                showStatus("파일 검사 완료. 복원·건너뜀 항목 확인 후 ‘기록 합치기’ 선택. 아직 저장 전.");
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
            showStatus("백업 파일 읽는 중");
            try {
                if (file.size > api.LIMITS.maxBytes)
                    throw new Error("백업 파일은 16 MiB 이하만 선택 가능. 현재 기록 유지.");
                const text = await readFile(file);
                if (!current(id)) return;
                setPhase("checking");
                showStatus("파일 내용과 병합 미리보기 확인 중");
                candidate = api.parseBackup(text);
                const outcome = await request("preview", { backup: candidate });
                if (!current(id)) return;
                if (outcome.status !== "preview") throw new Error("미리보기 응답 확인 실패. 파일 다시 선택.");
                showPreview(outcome);
            } catch (error) {
                if (!current(id)) return;
                clearPreview();
                setPhase("idle");
                showStatus(error.message || "백업 파일 확인 실패. 파일 다시 선택.", true);
                importButton.focus({ preventScroll: true });
            }
        });

        cancelButton.addEventListener("click", () => {
            if (!["reading", "checking", "preview"].includes(phase)) return;
            abandon();
            setPhase("idle");
            showStatus("불러오기 취소. 현재 기록 유지.");
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
            showStatus("최신 기록 확인 후 합치는 중");
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
                if (!["applied", "unchanged"].includes(outcome.status)) throw new Error("응답 확인 실패");
                clearPreview();
                setPhase("refreshing");
                showStatus(
                    outcome.status === "applied"
                        ? "기록 합치기 완료. 화면 갱신 중."
                        : "같은 기록이라 변경 없음. 화면 갱신 중."
                );
                let refreshed = false;
                try {
                    refreshed = await reload();
                } catch {
                    // 저장 결과와 화면 재조회 결과를 분리해 안내해요.
                }
                if (!current(id)) return;
                setPhase("idle");
                const saved = outcome.status === "applied" ? "기록 합치기 완료." : "같은 기록이라 변경 없음.";
                showStatus(
                    refreshed
                        ? `${saved} 추가 ${outcome.summary.added}개 · 갱신 ${outcome.summary.updated}개 · 동일 ${outcome.summary.unchanged}개 · 건너뜀 ${outcome.summary.skipped}개.`
                        : `${saved} 화면 갱신 실패. ‘새로고침’으로 현재 기록 확인.`,
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
                        : "기록 합치기 결과 확인 실패. ‘새로고침’으로 현재 기록 확인. 같은 파일을 다시 불러와도 중복 없음.",
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
            showStatus("전체 기간의 시청 기록·내 채팅 백업 중");
            try {
                const outcome = await request("export");
                if (!current(id)) return;
                if (outcome.status !== "exported") throw new Error("백업 응답 확인 실패");
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
                showStatus("백업 파일 다운로드 시작. 브라우저 다운로드 목록에서 저장 결과 확인.");
                exportButton.focus({ preventScroll: true });
            } catch (error) {
                if (!current(id)) return;
                setPhase("idle");
                showStatus(error.message || "백업 파일 만들기 실패. 다시 시도.", true);
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
            showStatus("현재 기록을 새로고침한 뒤 백업 파일 다시 선택");
        });
        setPhase("idle");
    }

    globalThis.CheeseSpannerHistoryBackup = Object.freeze({ init });
})();
