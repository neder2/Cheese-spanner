const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { createFakeChrome, readRepoFile } = require("./helpers/extension-page-fixture.js");

const channel = "a".repeat(32);
const overlayId = "cheese-spanner-time-machine-chat";

async function fixture(t, initialChannel = channel) {
    const dom = new JSDOM(
        '<main id="live_player_layout"><div class="pzp-pc"><video></video></div></main><aside id="aside-chatting"><div role="log"></div></aside>',
        { url: "https://chzzk.naver.com/live/" + initialChannel, runScripts: "outside-only", pretendToBeVisual: true }
    );
    t.after(() => dom.window.close());
    const w = dom.window;
    const doc = w.document;
    let video = doc.querySelector("video");
    const log = doc.querySelector("[role=log]");
    const client = { config: { streamingChannelId: initialChannel }, messageList: [] };
    log.__reactFiber$chat = { memoizedProps: { gameChatClient: client } };
    w.HTMLElement.prototype.checkVisibility = function () {
        return !this.closest("[hidden]");
    };
    let edge = 100;
    const epoch = Date.UTC(2026, 10, 1);
    w.Date.now = () => epoch + edge * 1000;
    w.performance.now = () => edge * 1000;
    function prepareVideo(source) {
        Object.defineProperties(video, {
            currentTime: { writable: true, value: edge },
            currentSrc: { writable: true, value: source },
            readyState: { writable: true, value: 4 },
            seeking: { writable: true, value: false },
            seekable: { writable: true, value: { length: 1, start: () => 0, end: () => edge } },
        });
    }
    prepareVideo("blob:fixture-a");
    let mainRows;
    log.addEventListener("cheese-spanner:time-machine-chat-sample", () => {
        mainRows = JSON.parse(log.getAttribute("data-bctm-chat-sample") || "null")?.[1];
    });
    w.chrome = createFakeChrome();
    const files = [
        "features/chatTimestampPage.js",
        "shared/settings.js",
        "shared/data.js",
        "content.js",
        "shared/liveTiming.js",
        "features/timeMachineChat.js",
    ];
    for (const file of files) w.eval(readRepoFile(file));
    await new Promise((resolve) => w.CheeseSpannerSettings.getOptions(resolve));
    function change(options) {
        const changes = Object.fromEntries(Object.entries(options).map(([key, newValue]) => [key, { newValue }]));
        for (const listener of w.chrome.testState.storageChangeListeners) listener(changes, "sync");
    }
    function tick(newEdge, cursor) {
        edge = newEdge;
        video.currentTime = cursor;
        video.dispatchEvent(new w.Event("seeked"));
    }
    function append(key, text, fields = {}) {
        const row = doc.createElement("div");
        row.innerHTML =
            '<button class="_nickname_test" aria-haspopup="true">시청자</button><span class="_text_test"></span>';
        row.lastChild.textContent = text;
        const message = {
            key,
            user: "reader",
            type: 1,
            time: w.Date.now(),
            status: "NORMAL",
            originalContent: text,
            ...fields,
        };
        row.__reactProps$chat = { children: { props: { chatMessage: message } } };
        client.messageList.push(message);
        log.append(row);
        return { row, message };
    }
    function replaceVideo(source) {
        const replacement = doc.createElement("video");
        video.replaceWith(replacement);
        video = replacement;
        prepareVideo(source);
    }
    return {
        w,
        doc,
        get video() {
            return video;
        },
        log,
        client,
        change,
        tick,
        append,
        replaceVideo,
        mainRows: () => mainRows,
        overlay: () => doc.getElementById(overlayId),
    };
}

test("opt-in rewind follows media time on pause, seek, double speed and live return", async (t) => {
    const f = await fixture(t);
    f.append("old", "입장하기 전 채팅");
    f.tick(100, 80);
    assert.equal(f.overlay(), null);
    f.change({ timeMachineChatEnabled: true });
    assert.match(f.overlay().textContent, /수집 시작 전/);
    f.tick(101, 101);
    assert.equal(f.overlay(), null);
    f.append("a", "첫 번째");
    f.tick(101, 101);
    f.tick(104, 104);
    f.append("b", "두 번째");
    f.tick(104, 104);
    f.tick(110, 101);
    assert.equal(f.overlay().textContent, "첫 번째");
    assert.equal(f.log.inert, true);
    f.video.dispatchEvent(new f.w.Event("pause"));
    f.tick(112, 101);
    assert.equal(f.overlay().textContent, "첫 번째");
    f.video.playbackRate = 2;
    f.video.dispatchEvent(new f.w.Event("ratechange"));
    f.tick(114, 105);
    assert.equal(f.overlay().textContent, "첫 번째\n두 번째");
    f.tick(115, 90);
    assert.match(f.overlay().textContent, /수집 시작 전/);
    f.tick(115, 115);
    assert.equal(f.overlay(), null);
    assert.equal(f.log.inert, false);
    assert.equal(f.w.chrome.testState.runtimeMessages.length, 0);
});

test("current native membership, moderation, DOM reuse and filters limit replay", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    const a = f.append("visible", "확인된 메시지");
    const b = f.append("hidden", "나중에 숨긴 메시지");
    const c = f.append("filtered", "금지 문구");
    f.append("donation", "후원 본문", { type: 10 });
    f.append("never", "기존 블라인드", { status: "HIDDEN" });
    f.tick(101, 101);
    f.tick(108, 102);
    assert.equal(f.overlay().textContent, "확인된 메시지\n나중에 숨긴 메시지\n금지 문구");
    // Native row props lag behind latest list state.
    f.client.messageList[1] = { ...b.message, status: "HIDDEN" };
    f.change({ chatKeywordFilterEnabled: true, chatKeywordFilterWords: "금지" });
    assert.equal(f.overlay().textContent, "확인된 메시지");
    a.row.remove();
    f.tick(109, 102);
    assert.equal(f.overlay().textContent, "확인된 메시지", "a verified, virtualized NORMAL row can replay");
    f.client.messageList[0] = { ...a.message, status: "HIDDEN" };
    f.tick(109, 102);
    assert.match(f.overlay().textContent, /확인할 수 있는 채팅이 없습니다/);
    c.row.lastChild.textContent = "가상화 재사용에서 혼입된 본문";
    f.log.append(a.row);
    f.tick(110, 102);
    assert.doesNotMatch(f.overlay().textContent, /확인된 메시지|혼입|후원|블라인드|금지/);
    f.change({ timeMachineChatEnabled: false });
    assert.equal(f.overlay(), null);
    assert.equal(f.log.inert, false);
});

test("loading, native client replacement, route and pagehide retire the session", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("a", "이전 방송 채팅");
    f.tick(101, 101);
    f.tick(110, 102);
    assert.equal(f.overlay().textContent, "이전 방송 채팅");
    f.video.readyState = 0;
    f.tick(110, 102);
    assert.match(f.overlay().textContent, /확인하는 중/);
    f.video.readyState = 4;
    f.log.__reactFiber$chat.memoizedProps.gameChatClient = { config: f.client.config, messageList: [] };
    f.tick(110, 102);
    assert.doesNotMatch(f.overlay().textContent, /이전 방송/);
    f.w.history.pushState(null, "", "/live/" + "b".repeat(32));
    f.w.dispatchEvent(new f.w.Event("popstate"));
    f.tick(110, 102);
    assert.doesNotMatch(f.overlay().textContent, /이전 방송/);
    f.w.dispatchEvent(new f.w.Event("pagehide"));
    assert.equal(f.overlay(), null);
    assert.equal(f.doc.documentElement.hasAttribute("data-bctm-chat-masked"), false);
    f.tick(111, 102);
    assert.equal(f.overlay(), null);
    f.w.dispatchEvent(new f.w.Event("pageshow"));
    assert.match(f.overlay().textContent, /확인하는 중/);
    f.w.history.pushState(null, "", "/");
    f.w.dispatchEvent(new f.w.Event("popstate"));
    f.tick(111, 102);
    assert.equal(f.overlay(), null);
});

test("a new chat client cannot use another channel's still-mounted media after a failed sample", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(100, 95);
    f.video.readyState = 0;
    f.tick(101, 95);
    const nextChannel = "b".repeat(32);
    f.w.history.pushState(null, "", "/live/" + nextChannel);
    f.client.config.streamingChannelId = nextChannel;
    f.w.dispatchEvent(new f.w.Event("popstate"));
    f.video.readyState = 4;
    f.tick(102, 95);
    assert.match(f.overlay().textContent, /채팅과 방송을 확인/);
    f.append("b", "새 채널 채팅");
    f.tick(104, 102);
    f.tick(111, 103);
    assert.doesNotMatch(f.overlay().textContent, /새 채널/);
    f.video.currentSrc = "blob:fixture-b";
    f.tick(111, 102);
    assert.match(f.overlay().textContent, /수집 시작 전/);
});

test("an empty or ambiguous log cannot authorize old rows, including during native log replacement", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    const a = f.append("a", "사라진 행");
    f.tick(101, 101);
    f.tick(110, 102);
    a.row.remove();
    f.tick(111, 102);
    assert.match(f.overlay().textContent, /확인할 수 있는 채팅이 없습니다/);
    const replacement = f.log.cloneNode(false);
    f.log.replaceWith(replacement);
    assert.equal(f.doc.documentElement.hasAttribute("data-bctm-chat-masked"), true);
    f.tick(112, 102);
    assert.doesNotMatch(f.overlay().textContent, /사라진 행/);
    f.change({ timeMachineChatEnabled: false });
    assert.equal(f.doc.documentElement.hasAttribute("data-bctm-chat-masked"), false);
});

test("a rolling 25-row log keeps at most 128 eligible arrivals and displays at most 24 lines", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    for (let index = 1; index <= 140; index++) {
        const edge = 100 + index / 2;
        f.tick(edge, edge);
        f.append(String(index), "메시지 " + index);
        if (f.log.childElementCount > 25) f.log.firstElementChild.remove();
        f.tick(edge, edge);
    }
    assert.equal(f.log.childElementCount, 25);
    assert.equal(f.client.messageList.length, 140);
    f.tick(180, 106);
    assert.match(f.overlay().textContent, /확인할 수 있는 채팅이 없습니다/);
    f.tick(180, 106.5);
    assert.equal(f.overlay().textContent, "메시지 13", "the earliest retained row has left the native DOM");
    f.tick(180, 170);
    assert.deepEqual(
        f.overlay().textContent.split("\n"),
        Array.from({ length: 24 }, (_, i) => "메시지 " + (i + 117))
    );
});

test("a seek gap masks the provisional cursor, preserves valid arrivals and follows the settled position", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("a", "첫 구간");
    f.tick(101, 101);
    f.tick(104, 104);
    f.append("b", "다음 구간");
    f.tick(104, 104);
    f.tick(112, 102);
    assert.equal(f.overlay().textContent, "첫 구간");

    const normal = f.video.seekable;
    f.video.seeking = true;
    f.tick(112, 106);
    assert.match(
        f.overlay().textContent,
        /확인하는 중/,
        "a provisional position inside a valid range also stays masked"
    );
    f.video.seeking = false;
    f.video.seekable = { length: 2, start: (i) => [0, 105][i], end: (i) => [102, 112][i] };
    f.tick(112, 104);
    assert.doesNotMatch(f.overlay().textContent, /첫 구간|다음 구간/);
    f.video.readyState = 1;
    f.video.seekable = { length: 0 };
    f.append("unplaced", "탐색 중 도착");
    f.tick(113, 104);
    assert.match(f.overlay().textContent, /확인하는 중/);
    f.video.readyState = 4;
    f.video.seeking = false;
    f.video.seekable = normal;
    f.tick(114, 102);
    assert.equal(f.overlay().textContent, "첫 구간");
    f.tick(114, 105);
    assert.equal(f.overlay().textContent, "첫 구간\n다음 구간");
    f.tick(120, 115);
    assert.doesNotMatch(f.overlay().textContent, /탐색 중 도착/);
    f.tick(120, 120);
    assert.equal(f.overlay(), null);
    assert.equal(f.log.inert, false);
});

test("the first receipt expires after 120 seconds including an unready player and a still-mounted row", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("old", "만료 대상");
    f.tick(101, 101);
    f.tick(220.9, 103);
    assert.equal(f.overlay().textContent, "만료 대상");
    assert.equal(f.mainRows().length, 1);
    f.video.readyState = 1;
    f.tick(221, 103);
    assert.equal(f.mainRows().length, 0);
    f.video.readyState = 4;
    f.tick(222, 103);
    assert.doesNotMatch(f.overlay().textContent, /만료 대상/);
    f.tick(223, 103);
    assert.equal(f.mainRows().length, 0, "the visible original never restarts its retention");
});

test("moderation, visibility and filters are revalidated while media timing is unavailable", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    const removed = f.append("removed", "삭제 본문");
    const blind = f.append("blind", "가림 본문");
    const hidden = f.append("hidden", "숨김 본문");
    const virtual = f.append("virtual", "가상 행 본문");
    f.append("keyword", "금지 본문");
    f.append("visible", "유지 본문");
    f.tick(101, 101);
    f.tick(110, 103);
    assert.match(f.overlay().textContent, /삭제 본문/);
    f.video.readyState = 1;
    removed.row.remove();
    f.client.messageList.splice(f.client.messageList.indexOf(removed.message), 1);
    blind.message.status = "HIDDEN";
    hidden.row.hidden = true;
    virtual.row.remove();
    // Mutating an unmounted body's text and changing it back cannot requalify it.
    virtual.row.lastChild.firstChild.data = "교체";
    virtual.row.lastChild.firstChild.data = "가상 행 본문";
    f.change({ chatKeywordFilterEnabled: true, chatKeywordFilterWords: "금지" });
    f.tick(111, 103);
    assert.doesNotMatch(JSON.stringify(f.mainRows()), /삭제 본문|가림 본문|숨김 본문|가상 행 본문/);
    f.video.readyState = 4;
    f.tick(112, 104);
    assert.equal(f.overlay().textContent, "유지 본문");
    hidden.row.hidden = false;
    f.change({ chatKeywordFilterEnabled: false });
    f.tick(113, 104);
    assert.equal(f.overlay().textContent, "유지 본문", "a removed snapshot cannot re-enter from scrollback");
});

test("media replacement, missing sources, hidden documents and a late former channel never inherit replay", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("first", "이전 내용");
    f.tick(101, 101);
    f.tick(110, 104);
    assert.equal(f.overlay().textContent, "이전 내용");
    f.replaceVideo("blob:fixture-a");
    f.tick(111, 104);
    assert.doesNotMatch(f.overlay().textContent, /이전 내용/);
    f.tick(112, 112);
    f.append("next", "교체 뒤 내용");
    f.tick(112, 112);
    f.tick(120, 114);
    assert.equal(f.overlay().textContent, "교체 뒤 내용");
    f.video.currentSrc = "";
    f.tick(121, 114);
    assert.doesNotMatch(f.overlay().textContent, /교체 뒤 내용/);
    f.video.currentSrc = "blob:fixture-a";
    f.tick(122, 114);
    assert.doesNotMatch(f.overlay().textContent, /교체 뒤 내용/);
    f.tick(123, 123);
    f.append("hide", "숨기기 전");
    f.tick(123, 123);
    f.tick(129, 124);
    assert.equal(f.overlay().textContent, "숨기기 전");
    Object.defineProperty(f.doc, "hidden", { configurable: true, value: true });
    f.doc.dispatchEvent(new f.w.Event("visibilitychange"));
    assert.equal(f.overlay(), null);
    Object.defineProperty(f.doc, "hidden", { configurable: true, value: false });
    f.doc.dispatchEvent(new f.w.Event("visibilitychange"));
    f.tick(130, 124);
    assert.doesNotMatch(f.overlay().textContent, /숨기기 전/);

    const next = "b".repeat(32);
    f.w.history.pushState(null, "", "/live/" + next);
    f.w.dispatchEvent(new f.w.Event("popstate"));
    f.client.config.streamingChannelId = next;
    f.replaceVideo("blob:fixture-a");
    f.tick(131, 124);
    assert.match(f.overlay().textContent, /확인하는 중/);
    f.video.currentSrc = "blob:fixture-b";
    f.tick(132, 132);
    f.tick(133, 133);
    f.append("safe", "현재 채널");
    f.tick(133, 133);
    f.tick(140, 135);
    assert.equal(f.overlay().textContent, "현재 채널");
});

test("separate screen samples at the same server millisecond can each contribute a distinct arrival", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("a", "첫째");
    f.tick(101, 101);
    f.append("b", "둘째");
    f.tick(101, 101);
    f.tick(110, 102);
    assert.equal(f.overlay().textContent, "첫째\n둘째");
});

test("wall time also expires the first receipt after sleep even when the media and monotonic clocks stall", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("old", "절전 전 본문");
    f.tick(101, 101);
    f.tick(110, 103);
    assert.equal(f.overlay().textContent, "절전 전 본문");
    const now = f.w.Date.now();
    f.w.Date.now = () => now + 130000;
    f.w.dispatchEvent(new f.w.Event("focus"));
    assert.equal(f.mainRows().length, 0);
    assert.doesNotMatch(f.overlay().textContent, /절전 전 본문/);
    f.tick(111, 103);
    assert.equal(f.mainRows().length, 0);
});

for (const transition of ["off", "pagehide"]) {
    test("a retained previous-channel video is rejected across " + transition, async (t) => {
        const f = await fixture(t);
        f.change({ timeMachineChatEnabled: true });
        f.tick(101, 101);
        f.append("old", "이전 채널");
        f.tick(101, 101);
        f.tick(110, 104);
        assert.equal(f.overlay().textContent, "이전 채널");
        if (transition === "off") f.change({ timeMachineChatEnabled: false });
        else f.w.dispatchEvent(new f.w.Event("pagehide"));
        assert.equal(f.overlay(), null);
        const next = "b".repeat(32);
        f.w.history.pushState(null, "", "/live/" + next);
        f.client.config.streamingChannelId = next;
        if (transition === "off") f.change({ timeMachineChatEnabled: true });
        else f.w.dispatchEvent(new f.w.Event("pageshow"));
        f.tick(111, 104);
        assert.match(f.overlay().textContent, /확인하는 중/);
        f.tick(112, 112);
        f.append("early", "영상 교체 전 새 채널");
        f.tick(112, 112);
        f.tick(120, 114);
        assert.doesNotMatch(f.overlay().textContent, /이전 채널|영상 교체 전/);
        f.replaceVideo("blob:fixture-b");
        f.tick(121, 121);
        f.tick(122, 122);
        f.append("late", "교체 확인 뒤 새 채널");
        f.tick(122, 122);
        f.tick(130, 124);
        assert.equal(f.overlay().textContent, "교체 확인 뒤 새 채널");
    });
}

test("two native player candidates or two live logs cannot continue a verified replay", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("old", "처음 메시지");
    f.tick(101, 101);
    f.tick(110, 105);
    assert.equal(f.overlay().textContent, "처음 메시지");
    const extra = f.doc.createElement("video");
    f.video.after(extra);
    f.tick(111, 105);
    assert.doesNotMatch(f.overlay().textContent, /처음 메시지/);
    extra.remove();
    f.tick(112, 112);
    f.tick(113, 113);
    f.append("new", "다음 메시지");
    f.tick(113, 113);
    f.tick(120, 115);
    assert.equal(f.overlay().textContent, "다음 메시지");
    f.log.after(f.log.cloneNode(false));
    f.tick(121, 115);
    assert.doesNotMatch(f.overlay().textContent, /다음 메시지/);
});

test("first enabling after an unobserved channel navigation quarantines the already loaded source", async (t) => {
    const f = await fixture(t);
    const next = "b".repeat(32);
    f.w.history.pushState(null, "", "/live/" + next);
    f.w.dispatchEvent(new f.w.Event("popstate"));
    f.client.config.streamingChannelId = next;
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101);
    f.append("early", "첫 활성화 때 있던 방송");
    f.tick(101, 101);
    f.tick(110, 105);
    assert.match(f.overlay().textContent, /새로고침/);
    f.video.currentSrc = "blob:new-b";
    f.tick(111, 111);
    f.tick(112, 112);
    f.append("safe", "새 B 소스");
    f.tick(112, 112);
    f.tick(120, 114);
    assert.equal(f.overlay().textContent, "새 B 소스");
    const reloaded = await fixture(t, next);
    reloaded.change({ timeMachineChatEnabled: true });
    reloaded.tick(101, 101);
    reloaded.append("reload", "새 문서의 B");
    reloaded.tick(101, 101);
    reloaded.tick(110, 105);
    assert.equal(reloaded.overlay().textContent, "새 문서의 B");
});

test("an older source from the previous channel stays retired when it returns on a new element", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    f.tick(101, 101); // A originally owned fixture-a.
    f.video.currentSrc = "blob:second-a";
    f.tick(102, 102);
    const next = "b".repeat(32);
    f.w.history.pushState(null, "", "/live/" + next);
    f.client.config.streamingChannelId = next;
    f.w.dispatchEvent(new f.w.Event("popstate"));
    f.replaceVideo("blob:fixture-a");
    f.tick(103, 103);
    f.append("wrong", "A 소스와 겹친 B 채팅");
    f.tick(103, 103);
    f.tick(110, 105);
    assert.match(f.overlay().textContent, /새로고침/);
    f.replaceVideo("blob:correct-b");
    f.tick(111, 111);
    f.tick(112, 112);
    f.append("correct", "B 소스의 채팅");
    f.tick(112, 112);
    f.tick(120, 114);
    assert.equal(f.overlay().textContent, "B 소스의 채팅");
});

test("the source ownership limit cannot be bypassed by replacing the video again", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true });
    for (let i = 1; i <= 31; i++) {
        f.video.currentSrc = "blob:source-" + i;
        f.tick(100 + i, 100 + i);
        assert.equal(f.overlay(), null);
    }
    f.replaceVideo("blob:overflow");
    f.tick(132, 132);
    assert.match(f.overlay().textContent, /새로고침/);
    f.replaceVideo("blob:another");
    f.tick(133, 133);
    assert.match(f.overlay().textContent, /새로고침/);
});

test("only confirmed room moderators, broadcasters and partner or challenger marks retain matching ordinary text on rewind", async (t) => {
    const f = await fixture(t);
    f.change({ timeMachineChatEnabled: true, chatKeywordFilterEnabled: true, chatKeywordFilterWords: "금지" });
    f.tick(101, 101);
    const profile = (userRoleCode, verifiedMarkType) => ({
        userIdHash: "reader",
        userRoleCode,
        verifiedMarkType,
        verifiedMark: !!verifiedMarkType,
    });
    f.append("ordinary", "금지 일반", { profile: profile("common_user", null) });
    const approved = [
        ["s", "금지 방송자", profile("streamer", null)],
        ["m", "금지 채팅운영자", profile("streaming_chat_manager", null)],
        ["c", "금지 채널운영자", profile("streaming_channel_manager", null)],
        ["p", "금지 파트너", profile("common_user", "PARTNER")],
        ["v", "금지 챌린저", profile("common_user", "CHALLENGER")],
    ];
    const approvedRows = new Map(
        approved.map(([key, text, author]) => [key, f.append(key, text, { profile: author })])
    );
    f.append("operator", "금지 서비스운영자", { profile: profile("manager", "OFFICIAL") });
    f.append("unknown", "금지 알 수 없음", { profile: { userIdHash: "reader" } });
    f.append("mismatch", "금지 다른 사용자", { profile: { ...profile("streamer", null), userIdHash: "other" } });
    f.append("deleted", "금지 삭제", { profile: profile("streamer", null), status: "HIDDEN" });
    for (const [key, rowRole, latestRole] of [
        ["stale-manager", "streaming_chat_manager", "common_user"],
        ["stale-viewer", "common_user", "streaming_chat_manager"],
    ]) {
        const { message } = f.append(key, "금지 역할 충돌", { profile: profile(rowRole, null) });
        const index = f.client.messageList.indexOf(message);
        f.client.messageList[index] = { ...message, profile: profile(latestRole, null) };
    }
    const hidden = f.append("hidden", "금지 보이지 않음", { profile: profile("streamer", null) });
    hidden.row.hidden = true;
    f.tick(101, 101);
    f.tick(109, 102);
    assert.equal(f.overlay().textContent, approved.map((row) => row[1]).join("\n"));
    assert.doesNotMatch(JSON.stringify(f.mainRows()), /금지 삭제|금지 보이지 않음/);

    // A currently detached NORMAL message must lose its exception if the latest native role changes.
    const partnerIndex = f.client.messageList.findIndex((m) => m.key === "p");
    approvedRows.get("p").row.remove();
    f.tick(110, 102);
    assert.match(f.overlay().textContent, /금지 파트너/);
    f.client.messageList[partnerIndex].profile = profile("common_user", null);
    f.tick(111, 102);
    assert.doesNotMatch(f.overlay().textContent, /금지 파트너/);
    approvedRows.get("s").message.status = "BLIND";
    f.tick(112, 102);
    assert.doesNotMatch(f.overlay().textContent, /금지 방송자/);
    assert.doesNotMatch(JSON.stringify(f.mainRows()), /금지 방송자/);
});
