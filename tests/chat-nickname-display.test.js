const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const STYLE_ID = "cheese-spanner-chat-nickname-style";
// Anonymized native tree observed in Chrome on 2026-11-14; legacy family was observed on 2026-11-11.
function row(id, module, grade = "", extra = "", badgeAlt = "구독 배지") {
    const mark = grade
        ? `<i class="_mark_${module}_81 _is_${grade}_${module}_81"><span class="blind">인증 마크</span></i>`
        : "";
    return `<div class="chat-row" data-message-id="${id}"><div class="_chatting_message_jbnq0_21"><button class="_nickname_jbnq0_33" type="button"><span class="_container_a6uv5_2 _is_message_a6uv5_5"><span class="_wrapper_a6uv5_31"><span class="_icon_a6uv5_15"><span class="_container_14814_2"><img alt="${badgeAlt}" src="https://ssl.pstatic.net/badge.png"></span></span></span><span class="_nickname_a6uv5_43"><span class="_ellipsis_${module}_6"><span id="${id}" class="_text_${module}_2">작성자${id}</span>${mark}${extra}</span></span></span></button><span class="message">본문 ${id}</span></div></div>`;
}

function fixture(t, { route = "/live/channel", aside = "aside-chatting", rows = "" } = {}) {
    const dom = new JSDOM(`<aside id="${aside}"><div role="log">${rows}</div></aside>`, {
        url: "https://chzzk.naver.com" + route,
        runScripts: "outside-only",
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    for (const file of ["shared/settings.js", "shared/data.js", "content.js", "features/chatTools/parser.js"])
        w.eval(fs.readFileSync(path.join(root, file), "utf8"));
    let apply;
    w.CheeseSpanner.utils.bindFeatureOptions = (callback) => {
        apply = callback;
        callback({ chatNicknameHidden: false });
    };
    w.eval(fs.readFileSync(path.join(root, "features/chatNicknameDisplay.js"), "utf8"));
    return { w, document: w.document, apply: (enabled) => apply({ chatNicknameHidden: enabled }) };
}

test("nickname display is off by default, is packaged before chat frames and uses the shared badge definitions", (t) => {
    const f = fixture(t);
    assert.equal(f.w.CheeseSpannerSettings.normalizeOptions().chatNicknameHidden, false);
    assert.equal(f.document.getElementById(STYLE_ID), null);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const main = manifest.content_scripts.find((entry) => entry.world === "MAIN");
    const isolated = manifest.content_scripts.find((entry) => entry.world !== "MAIN");
    const index = isolated.js.indexOf("features/chatNicknameDisplay.js");
    assert.ok(index > isolated.js.indexOf("content.js"));
    assert.ok(index < isolated.js.indexOf("features/chatMultiview.js"));
    assert.equal(main.js.includes("features/chatNicknameDisplay.js"), false);
    const read = f.w.CheeseSpanner.utils.verifiedMarks.read;
    assert.equal(read("_mark_1pcsq_81 _is_partner_1pcsq_81").grade, "PARTNER");
    assert.equal(read("_mark_1pcsq_81 _is_partner_8bw0p_75").grade, "");
    assert.equal(read("_mark_1pcsq_81 _is_partner_1pcsq_81 _is_challenger_1pcsq_84").grade, "");
    assert.equal(read("_mark_unknown_81 _is_partner_unknown_81"), null);
});

for (const [route, aside] of [
    ["/live/channel", "aside-chatting"],
    ["/live/channel/chat", "aside-chatting"],
    ["/video/123", "vod-aside"],
]) {
    for (const module of ["8bw0p", "1pcsq"]) {
        test(`nickname display preserves badges and author parsing on ${route} with ${module}`, (t) => {
            const rows =
                row("ordinary", module) +
                row("broadcaster", module, "", "", "스트리머") +
                row("manager", module, "", "", "채팅 운영자") +
                row("partner", module, "partner") +
                row("challenger", module, "challenger") +
                row("partner-manager", module, "partner", "", "채팅 운영자") +
                row("official", module, "official") +
                row(
                    "popup",
                    module,
                    "",
                    `<span role="alertdialog"><i class="_mark_${module}_81 _is_partner_${module}_81"></i></span>`
                );
            const { w, document, apply } = fixture(t, { route, aside, rows });
            const log = document.querySelector('[role="log"]');
            const original = log.innerHTML;
            const clipped = (id) => w.getComputedStyle(document.getElementById(id)).clipPath === "inset(50%)";
            const parsed = () =>
                Array.from(log.querySelectorAll(".chat-row"), (node) => {
                    const message = w.CheeseSpanner.chatTools.parser.parseChatRow(node);
                    return [message.author, message.text, message.role];
                });
            const before = parsed();
            assert.deepEqual(
                before.filter((message) => message[2]).map((message) => message[2]),
                ["broadcaster", "manager", "partner", "challenger", "manager"],
                "exceptions match the chat collection roles without enabling collection"
            );
            apply(true);
            apply(true);
            assert.equal(document.querySelectorAll("#" + STYLE_ID).length, 1);
            for (const id of ["ordinary", "official", "popup"]) assert.equal(clipped(id), true, id);
            for (const id of ["broadcaster", "manager", "partner", "challenger", "partner-manager"])
                assert.equal(clipped(id), false, id);
            for (const badge of log.querySelectorAll("img, i"))
                assert.notEqual(w.getComputedStyle(badge).clipPath, "inset(50%)");
            assert.deepEqual(parsed(), before, "hiding cannot alter author, role, body or message identity");
            assert.equal(log.innerHTML, original, "native nodes, text and styles are untouched");
            const ordinary = document.getElementById("ordinary");
            ordinary.insertAdjacentHTML("afterend", `<i class="_mark_${module}_81 _is_partner_${module}_81"></i>`);
            assert.equal(clipped("ordinary"), false, "a late verified mark reveals the current nickname");
            ordinary.nextElementSibling.remove();
            ordinary.textContent = "재사용된 작성자";
            assert.equal(clipped("ordinary"), true, "a reused ordinary author is immediately hidden");
            assert.equal(
                w.CheeseSpanner.chatTools.parser.parseChatRow(ordinary.closest(".chat-row")).author,
                "재사용된 작성자"
            );
            const badge = ordinary.closest("button").querySelector("img");
            for (const alt of ["스트리머", "채팅 운영자"]) {
                badge.alt = alt;
                assert.equal(clipped("ordinary"), false, "a late role badge reveals the current nickname");
                badge.alt = "구독 배지";
                assert.equal(clipped("ordinary"), true, "a reused ordinary author loses the exception");
            }
            badge.alt = "채팅 운영자";
            badge.remove();
            assert.equal(clipped("ordinary"), true, "removing a role badge restores hiding");
            log.insertAdjacentHTML("beforeend", row("new-row", module));
            assert.equal(clipped("new-row"), true, "new messages need no observer or delayed scan");
            apply(false);
            assert.equal(document.getElementById(STYLE_ID), null);
            assert.equal(clipped("ordinary"), false);
        });
    }
}

test("nickname display does not hide profile names, comments or message bodies", (t) => {
    const f = fixture(t, { rows: row("inside", "1pcsq") });
    const outside = f.document.createElement("div");
    outside.innerHTML = row("outside", "1pcsq");
    f.document.body.append(outside);
    const body = f.document.querySelector(".message");
    body.innerHTML =
        '<span id="body-name" class="_text_1pcsq_2">본문 이름 스트리머 채팅 운영자</span><i class="_mark_1pcsq_81 _is_partner_1pcsq_81"></i><img alt="채팅 운영자" src="https://ssl.pstatic.net/manager.png">';
    f.document
        .querySelector("button")
        .insertAdjacentHTML(
            "beforeend",
            '<span role="alertdialog"><img alt="스트리머" src="https://ssl.pstatic.net/streamer.png"><img alt="채팅 운영자" src="https://ssl.pstatic.net/manager.png"></span>'
        );
    f.apply(true);
    for (const id of ["outside", "body-name"])
        assert.notEqual(f.w.getComputedStyle(f.document.getElementById(id)).clipPath, "inset(50%)");
    assert.equal(f.w.getComputedStyle(f.document.getElementById("inside")).clipPath, "inset(50%)");
    const log = f.document.querySelector('[role="log"]');
    log.replaceChildren(outside.firstElementChild);
    assert.equal(f.w.getComputedStyle(f.document.getElementById("outside")).clipPath, "inset(50%)");
});
