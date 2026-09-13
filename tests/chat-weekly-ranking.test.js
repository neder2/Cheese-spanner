const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

for (const theme of ["theme_light", "theme_dark"]) {
    test(`weekly ranking hiding preserves chat and rewards and restores native UI (${theme})`, (t) => {
        const dom = new JSDOM(
            `<html class="${theme}"><body><aside id="aside-chatting">
            <div id="header"><h2>채팅</h2></div>
            <div id="ranking"><button class="_ranking_button_wl8bq_141" aria-expanded="false">주간 후원 랭킹</button></div>
            <div role="log" id="messages"><div><button class="_ranking_button_fake">주간 후원 랭킹</button></div></div>
            <div id="reward"><button>1시간 시청 통나무 파워 배달 완료! 100 받기</button></div>
            </aside><div id="outside"><button class="_ranking_button_wl8bq_141">랭킹</button></div></body></html>`,
            { url: "https://chzzk.naver.com/live/test", runScripts: "outside-only" }
        );
        t.after(() => dom.window.close());
        const { document } = dom.window;
        let apply;
        dom.window.BetterChzzk = {
            utils: {
                bindFeatureOptions(callback) {
                    apply = callback;
                    callback({ chatWeeklyRankingHidden: false });
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
        dom.window.eval(fs.readFileSync(path.join(__dirname, "../features/chatWeeklyRanking.js"), "utf8"));
        const hidden = (id) => dom.window.getComputedStyle(document.getElementById(id)).display === "none";
        assert.equal(hidden("ranking"), false);
        apply({ chatWeeklyRankingHidden: true });
        assert.equal(hidden("ranking"), true);
        const expanded =
            '<div><strong>주간 후원 랭킹<button class="_refresh_button_wl8bq_54">랭킹 새로고침</button></strong></div><ul><li><i class="_icon_ranking_1n4e3_28">1등</i></li></ul>';
        document.getElementById("ranking").innerHTML = expanded;
        assert.equal(hidden("ranking"), true);
        for (const id of ["header", "messages", "reward", "outside"]) assert.equal(hidden(id), false);
        dom.window.history.pushState({}, "", "/live/other");
        const aside = document.getElementById("aside-chatting");
        aside.replaceWith(aside.cloneNode(true));
        assert.equal(hidden("ranking"), true);
        apply({ chatWeeklyRankingHidden: false });
        assert.equal(hidden("ranking"), false);
        assert.equal(document.querySelectorAll("style").length, 0);
        apply({ chatWeeklyRankingHidden: true });
        apply({ chatWeeklyRankingHidden: true });
        assert.equal(document.querySelectorAll("style").length, 1);
    });
}
