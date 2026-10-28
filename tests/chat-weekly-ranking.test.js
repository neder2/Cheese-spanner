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
        dom.window.CheeseSpanner = {
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
        // 2026-10-12 public bundle: an empty week renders no list, and the log power view has no refresh button.
        const states = {
            emptyCollapsed:
                '<div><div class="_no_ranking_header_wl8bq_155"><strong class="_title_wl8bq_22">주간 후원 랭킹</strong></div><div class="_swipe_button_wl8bq_118"></div><button class="_no_ranking_button_wl8bq_133" aria-expanded="false"><span class="blind">펼치기</span></button></div>',
            emptyExpanded:
                '<div class="_header_wl8bq_13"><strong class="_title_wl8bq_22">주간 후원 랭킹<button class="_refresh_button_wl8bq_54">랭킹 새로고침</button></strong></div><div class="_contents_wl8bq_84"><div class="_swipe_button_wl8bq_118"></div><button class="_no_ranking_button_wl8bq_133" aria-expanded="true"><span class="blind">접기</span></button></div>',
            powerExpanded:
                '<div class="_header_wl8bq_13 _show_power_wl8bq_25"><strong class="_title_wl8bq_22">주간 통나무 파워 랭킹</strong><button class="_header_button_wl8bq_32" aria-expanded="true"></button></div><div class="_contents_wl8bq_84"><ul><li>1</li></ul><button class="_swipe_button_wl8bq_118" aria-expanded="true"></button></div>',
        };
        for (const [state, html] of Object.entries(states)) {
            document.getElementById("ranking").innerHTML = html;
            assert.equal(hidden("ranking"), true, state);
            for (const id of ["header", "messages", "reward", "outside"]) assert.equal(hidden(id), false, state);
        }
        document.getElementById("messages").innerHTML =
            '<div><button class="_no_ranking_button_fake">랭킹</button><div class="_show_power_fake"></div></div>';
        assert.equal(hidden("messages"), false);
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
