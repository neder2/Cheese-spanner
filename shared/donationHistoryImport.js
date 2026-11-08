/** User-triggered importer. Requests are cancellable, authenticated, and committed by the history writer. */
(() => {
    "use strict";
    function install({ chrome, readHistory, writeHistory }) {
        const data = globalThis.CheeseSpannerDonationHistory;
        const { fetchJson } = globalThis.CheeseSpanner.utils;
        let active = null;

        async function identifyInTab(tabId) {
            const results = await chrome.scripting.executeScript({
                target: { tabId, frameIds: [0] },
                world: "ISOLATED",
                func: async () => {
                    if (location.origin !== "https://chzzk.naver.com") return null;
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), 8000);
                    try {
                        const response = await fetch("https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus", {
                            credentials: "include",
                            cache: "no-store",
                            signal: controller.signal,
                        });
                        if (!response.ok) return null;
                        const json = await response.json();
                        return json?.code === 200 && json.content?.loggedIn === true ? json.content.userIdHash : null;
                    } finally {
                        clearTimeout(timer);
                    }
                },
            });
            return results?.[0]?.result;
        }

        chrome.runtime.onConnect?.addListener((port) => {
            if (port.name !== data.PORT_NAME) return;
            const sender = port.sender;
            if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("history.html")) {
                port.disconnect();
                return;
            }
            let connected = true;
            let used = false;
            let job = null;
            const send = (message) => {
                if (!connected) return;
                try {
                    port.postMessage(message);
                } catch {
                    connected = false;
                    if (job && !job.saving) job.controller.abort();
                }
            };
            port.onDisconnect.addListener(() => {
                connected = false;
                if (job && !job.saving) job.controller.abort();
            });
            port.onMessage.addListener((message) => {
                if (message?.type === "cancel") {
                    if (job && !job.saving) job.controller.abort();
                    return;
                }
                if (message?.type !== "start" || used) return;
                used = true;
                if (active) {
                    send({ type: "error", message: "다른 시청 기록 창에서 가져오는 중." });
                    return;
                }
                job = { controller: new AbortController(), saving: false };
                active = job;
                void (async () => {
                    try {
                        if (sender.tab?.incognito) throw new Error("일반 브라우저 창에서 후원 내역 가져오기 필요.");
                        const tabs = await chrome.tabs.query({ url: "https://chzzk.naver.com/*" });
                        const tab = tabs
                            .filter((tab) => Number.isInteger(tab.id) && !tab.discarded && !tab.incognito)
                            .sort(
                                (a, b) =>
                                    Number(b.active) - Number(a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0)
                            )[0];
                        if (!tab) throw new Error("치지직 로그인 탭을 열어 둔 뒤 다시 가져오기 필요.");
                        const previous = data.normalizeLedger((await readHistory())?.donationImport);
                        const identify = async () => {
                            const owner = await identifyInTab(tab.id);
                            if (previous.owner && owner && previous.owner !== owner)
                                throw new Error("다른 계정의 후원 내역 저장됨. 가져온 내역 삭제 후 다시 시도 필요.");
                            return owner;
                        };
                        const snapshot = await data.collect({
                            previous,
                            identify,
                            signal: job.controller.signal,
                            onProgress: (progress) => send({ type: "progress", ...progress }),
                            requestPage: (month, page, size, signal) => {
                                const [year, monthNumber] = month.split("-").map(Number);
                                const query = new URLSearchParams({
                                    page: String(page),
                                    size: String(size),
                                    searchYear: String(year),
                                    searchMonth: String(monthNumber),
                                });
                                return fetchJson(
                                    `https://api.chzzk.naver.com/commercial/v1/product/purchase/history?${query}`,
                                    { signal, timeoutMs: 10000, cache: "no-store" }
                                );
                            },
                        });
                        if (job.controller.signal.aborted) throw new Error("가져오기 취소됨.");
                        job.saving = true;
                        send({ type: "saving" });
                        const result = await writeHistory({ kind: "replaceDonationMonths", snapshot });
                        if (result.reason === "deleted") throw new Error("가져오는 중 기록이 삭제되어 저장 안 됨.");
                        send({
                            type: "done",
                            count: Object.values(snapshot.months).reduce((sum, rows) => sum + rows.length, 0),
                            monthCount: Object.keys(snapshot.months).length,
                        });
                    } catch (error) {
                        const message = job.controller.signal.aborted
                            ? "가져오기 취소됨(저장 내역 유지)."
                            : /HTTP (401|403)/.test(error?.message || "")
                              ? "치지직 재로그인 후 다시 가져오기 필요."
                              : error?.name === "AbortError"
                                ? "조회 시간 초과. 잠시 후 다시 가져오기 필요."
                                : error?.message || "후원 내역 가져오기 실패.";
                        send({ type: "error", message });
                    } finally {
                        if (active === job) active = null;
                    }
                })();
            });
        });
    }
    globalThis.CheeseSpannerDonationHistoryImport = { install };
})();
