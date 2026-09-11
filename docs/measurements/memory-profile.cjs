/* global require, process, global, __filename, setImmediate */
const fs = require("fs"),
    path = require("path"),
    vm = require("vm"),
    cp = require("child_process");
const repo = path.resolve(process.argv[2] || process.cwd()),
    scenario = process.argv[3];
const read = (f) => fs.readFileSync(path.join(repo, f), "utf8");
const gc = () => {
    for (let i = 0; i < 3; i++) global.gc();
};
const scenarios = [
    "index-600",
    "index-2400",
    "index-8x2400",
    "month-60",
    "month-8x120",
    "chat-100",
    "chat-200",
    "chat-stream-2000",
];
function dataRoot(folder) {
    const c = vm.createContext({ AbortController, DOMException, URLSearchParams, setTimeout, clearTimeout });
    vm.runInContext(read("shared/data.js"), c);
    c.BetterChzzk.utils.normSpace = c.BetterChzzk.utils.compactSpaces;
    for (const f of ["model", "repository"]) vm.runInContext(read(`features/${folder}/${f}.js`), c);
    return c.BetterChzzk;
}
function row(channel, index) {
    return {
        videoNo: `${channel}-${index}`,
        videoTitle: `프로파일용 방송 ${channel} ${index} - ${"한글 제목과 게임 방송 내용 ".repeat(3)}`,
        thumbnailImageUrl: `https://nng-phinf.pstatic.net/profile-${channel}-${index}.jpg`,
        duration: 10800,
        liveOpenDate: "2026-09-01 12:00:00",
        publishDate: "2026-09-01 15:00:00",
        videoType: "REPLAY",
        readCount: 10000,
        watchTimeline: { lastPlaybackTime: index % 100 },
    };
}
async function run() {
    let keep,
        clear,
        details = {};
    if (scenario.startsWith("index")) {
        const root = dataRoot("videoSearch");
        const repoObj = root.videoSearchRepository.createRepository({
            fetchJson: async (url) => {
                const u = new URL(url),
                    page = Number(u.searchParams.get("page")),
                    channel = u.pathname.split("/")[4];
                return {
                    content: { data: Array.from({ length: 30 }, (_, i) => row(channel, page * 30 + i)), last: false },
                };
            },
            fetchChzzkCommentPage: async () => ({}),
            onLoading() {},
            onIndexStart() {},
            onIndexProgress() {},
            onIndexSettled() {},
            onCommentProgress() {},
        });
        const channels = scenario === "index-8x2400" ? 8 : 1,
            pages = scenario === "index-600" ? 20 : 80;
        keep = repoObj;
        clear = () => repoObj.clearIndex();
        details = { channels, records: channels * pages * 30, comments: false };
        return measure(
            async () => {
                for (let i = 0; i < channels; i++) {
                    repoObj.setContext(`ch${i}`, "프로파일", { videoSearchEnabled: true, videoSearchMaxPages: pages });
                    await repoObj.buildIndex(`ch${i}`);
                }
            },
            clear,
            () => keep,
            details
        );
    }
    if (scenario.startsWith("month")) {
        const root = dataRoot("monthlyBroadcastTime");
        const repoObj = root.monthlyBroadcastRepository.createRepository({
            fetchJson: async (url) => {
                const u = new URL(url),
                    page = Number(u.searchParams.get("page")),
                    channel = u.pathname.split("/")[4];
                return {
                    code: 200,
                    message: null,
                    content: {
                        data: Array.from({ length: 30 }, (_, i) => row(channel, page * 30 + i)),
                        page: { size: 30, page },
                        last: false,
                    },
                };
            },
        });
        const channels = scenario === "month-8x120" ? 8 : 1,
            pages = scenario === "month-8x120" ? 120 : 60;
        keep = repoObj;
        clear = () => repoObj.clearPages();
        details = { channels, pages: channels * pages, rawRows: channels * pages * 30 };
        return measure(
            async () => {
                await Promise.all(
                    Array.from({ length: channels }, (_, ch) =>
                        Promise.all(Array.from({ length: pages }, (_, p) => repoObj.fetchVideoPageCached(`ch${ch}`, p)))
                    )
                );
            },
            clear,
            () => keep,
            details
        );
    }
    const { JSDOM } = require(path.join(repo, "node_modules/jsdom"));
    const dom = new JSDOM('<body><div role="log" id="chat"></div></body>', {
        url: "https://chzzk.naver.com/live/test",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    for (const f of [
        "shared/data.js",
        "content.js",
        "features/chatTools/parser.js",
        "features/chatTools/messageStore.js",
    ])
        dom.window.eval(read(f));
    const rootEl = dom.window.document.getElementById("chat");
    const count = scenario === "chat-200" ? 200 : 100,
        total = scenario === "chat-stream-2000" ? 2000 : count;
    for (let i = 0; i < count; i++) {
        const el = dom.window.document.createElement("div");
        el.className = "chat-row";
        el.innerHTML =
            '<span aria-label="매니저" class="badge"></span><span class="nickname">운영자</span><span class="message"></span>';
        rootEl.appendChild(el);
    }
    let snapshot;
    const store = dom.window.BetterChzzk.chatTools.createMessageStore({
        onChange: (value) => {
            snapshot = value;
        },
    });
    store.configure({ enabled: true, maximum: count });
    store.adoptRoot(rootEl);
    keep = { dom, store };
    clear = () => {
        store.clear();
        store.resetRoot();
        snapshot = null;
    };
    details = { retainedMessages: count, incomingMessages: total, includesPanel: false, domEmulation: "jsdom" };
    const result = await measure(
        async () => {
            for (let i = 0; i < total; i++) {
                const el = rootEl.children[i % count];
                el.setAttribute("data-chat-id", `chat-${i}`);
                el.querySelector(".nickname").textContent = `운영자${i % 5}`;
                el.querySelector(".message").textContent = `프로파일 안내 메시지 ${i}: ` + "채팅 본문 ".repeat(12);
                store.noteMutation(el);
                store.collect(store.parseChatMessage(el));
            }
            store.finishScan(true);
            details.publishedMessages = snapshot?.length || 0;
        },
        clear,
        () => keep,
        details
    );
    dom.window.close();
    return result;
}
async function measure(work, clear, hold, details) {
    await new Promise((r) => setImmediate(r));
    gc();
    const before = process.memoryUsage().heapUsed,
        cpu = process.cpuUsage(),
        start = performance.now();
    await work();
    const elapsed = performance.now() - start,
        usedCpu = process.cpuUsage(cpu);
    await new Promise((r) => setImmediate(r));
    gc();
    const retained = process.memoryUsage().heapUsed - before;
    clear();
    await new Promise((r) => setImmediate(r));
    gc();
    const afterClear = process.memoryUsage().heapUsed - before;
    hold();
    return {
        scenario,
        ...details,
        retainedMiB: retained / 1048576,
        afterClearMiB: afterClear / 1048576,
        cpuMs: (usedCpu.user + usedCpu.system) / 1000,
        elapsedMs: elapsed,
    };
}
if (scenario) {
    run()
        .then((r) => console.log(JSON.stringify(r)))
        .catch((e) => {
            console.error(e);
            process.exitCode = 1;
        });
} else {
    const output = [];
    for (const name of scenarios) {
        for (let repeat = 0; repeat < 3; repeat++) {
            const p = cp.spawnSync(process.execPath, ["--expose-gc", __filename, repo, name], {
                encoding: "utf8",
                maxBuffer: 1024 * 1024,
            });
            if (p.status) throw new Error(p.stderr || p.stdout);
            output.push(JSON.parse(p.stdout));
        }
        console.log(JSON.stringify({ scenario: name, samples: output.filter((r) => r.scenario === name) }));
    }
    fs.writeFileSync(
        path.join(require("os").tmpdir(), "betterchzzk-memory-profile-results.json"),
        JSON.stringify(
            {
                date: new Date().toISOString(),
                node: process.version,
                platform: process.platform,
                fixture: "synthetic representative metadata, no real networking/decoder/GPU",
                samples: output,
            },
            null,
            2
        )
    );
}
