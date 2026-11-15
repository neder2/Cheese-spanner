const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const source = fs.readFileSync(path.join(__dirname, "../features/chatDonationMessages.js"), "utf8");
const STYLE = "cheese-spanner-chat-donation-messages-style";
const donation = (id, classes) => `<div class="_item_native_7" id="${id}"><div class="${classes}">후원</div></div>`;
const renderers = [
    {
        date: "2026-11-08",
        liveList: "_wrapper_8lqsk_25",
        replayList: "_list_61avy_67",
        chat: "_container_17em1_1",
        anonymousLevel: "_level4_17em1_23",
        mission: "_container_2dqjk_2 _is_message_2dqjk_9",
        fixedMission: "_container_2dqjk_2 _is_fixed_2dqjk_141",
        party: "_container_18byk_2",
    },
    {
        date: "2026-11-15",
        liveList: "_wrapper_1li40_25",
        replayList: "_list_tdctj_127",
        chat: "_container_120bf_1",
        anonymousLevel: "_level4_120bf_24",
        mission: "_container_1oei1_2 _is_message_1oei1_10",
        fixedMission: "_container_1oei1_2 _is_fixed_1oei1_150",
        party: "_container_baf00_2",
    },
];

test("donation hiding is packaged in the isolated world before its chat multiview consumer", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    const file = "features/chatDonationMessages.js";
    const isolated = manifest.content_scripts.find((script) => script.world !== "MAIN");
    const main = manifest.content_scripts.find((script) => script.world === "MAIN");
    assert.ok(isolated.js.indexOf(file) > isolated.js.indexOf("content.js"));
    assert.ok(isolated.js.indexOf(file) < isolated.js.indexOf("features/chatMultiview.js"));
    assert.equal(main.js.includes(file), false);
});

const cases = renderers.flatMap((renderer) => [
    ["/live/channel", "aside-chatting", renderer.liveList, renderer],
    ["/live/channel/chat", "aside-chatting", renderer.liveList, renderer],
    ["/video/123", "vod-aside", renderer.replayList, renderer],
]);
for (const [route, aside, list, renderer] of cases) {
    test(`donation rows hide and restore on ${route} (${renderer.date})`, (t) => {
        const rows = [
            donation("chat-donation", renderer.chat),
            donation("anonymous", `${renderer.chat} ${renderer.anonymousLevel}`),
            donation("mission", renderer.mission),
            donation("participation", renderer.party),
            donation("party", renderer.party),
            '<div id="chat" class="_item_native_7"><div class="chatting_message">후원 감사합니다, 1,000치즈</div></div>',
            donation("subscription", "_container_18rj8_7"),
            donation("purchase", "_container_other_1"),
            donation("system", "_container_1sdv7_2"),
            donation("fixed-mission", renderer.fixedMission),
            `<div id="nested" class="_item_native_7"><div class="chatting_message"><div class="${renderer.chat}">본문 안 요소</div></div></div>`,
        ].join("");
        const dom = new JSDOM(
            `<body><aside id="${aside}"><h2>채팅</h2><div id="board" class="${renderer.mission}">고정 미션</div><div role="log"><div class="${list}">${rows}</div></div></aside><div role="log"><div class="${list}">${donation("outside", renderer.chat)}</div></div></body>`,
            { url: "https://chzzk.naver.com" + route, runScripts: "outside-only" }
        );
        t.after(() => dom.window.close());
        const { document } = dom.window;
        let apply;
        dom.window.CheeseSpanner = {
            utils: {
                bindFeatureOptions(callback) {
                    apply = callback;
                    callback({ chatDonationMessagesHidden: false });
                },
                injectStyleOnce(id, css) {
                    if (document.getElementById(id)) return;
                    const style = document.createElement("style");
                    style.id = id;
                    style.textContent = css;
                    document.head.append(style);
                },
            },
        };
        dom.window.eval(source);
        const hidden = (id) => dom.window.getComputedStyle(document.getElementById(id)).display === "none";
        const log = document.querySelector('[role="log"]');
        const original = log.innerHTML;
        const first = document.getElementById("chat-donation");
        assert.equal(document.getElementById(STYLE), null);
        apply({ chatDonationMessagesHidden: true });
        apply({ chatDonationMessagesHidden: true });
        assert.equal(document.querySelectorAll("#" + STYLE).length, 1);
        for (const id of ["chat-donation", "anonymous", "mission", "participation", "party"])
            assert.equal(hidden(id), true, id);
        for (const id of ["chat", "subscription", "purchase", "system", "fixed-mission", "board", "outside", "nested"])
            assert.equal(hidden(id), false, id);
        assert.equal(log.innerHTML, original, "native messages and their attributes are untouched");
        assert.equal(document.getElementById("chat-donation"), first);

        const listNode = log.firstElementChild;
        listNode.insertAdjacentHTML("beforeend", donation("late", renderer.chat.replace(/_\d+$/, "_999")));
        assert.equal(hidden("late"), true, "new donations need no rescan or extra observer");
        first.innerHTML = '<div class="chatting_message">일반 채팅으로 재사용</div>';
        assert.equal(hidden("chat-donation"), false, "a reused ordinary row is immediately visible");
        first.innerHTML = `<div class="${renderer.party}">새 파티 후원</div>`;
        assert.equal(hidden("chat-donation"), true);
        apply({ chatDonationMessagesHidden: false });
        assert.equal(document.getElementById(STYLE), null);
        for (const id of ["chat-donation", "anonymous", "mission", "participation", "party", "late"])
            assert.equal(hidden(id), false, id);
    });
}
