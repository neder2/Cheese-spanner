const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const root = path.join(__dirname, "..");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, "shared/updateGuide.js"), "utf8"), context);
const catalog = context.CheeseSpannerUpdateGuide;

test("catalog matches exact versions and contains local text and known destinations", () => {
    for (const value of ["1.4.0", "__proto__", "1.4.10", null]) assert.equal(catalog.getGuide(value), null);
    for (const [version, guide] of Object.entries(catalog.guides)) {
        assert.equal(guide.version, version);
        assert.ok(guide.title && guide.summary && Object.isFrozen(guide));
        assert.equal(new Set(guide.cards.map((card) => card.id)).size, guide.cards.length);
        for (const card of guide.cards) {
            assert.ok(card.title && typeof card.summary === "string" && Array.isArray(card.instructions));
            assert.ok(Object.isFrozen(card.instructions));
            assert.ok(card.instructions.every((line) => typeof line === "string" && line.length > 0));
            assert.ok(["panels", "history", "stream", "categories"].includes(card.target));
            assert.ok(["panels", "history", "stream", "categories"].includes(card.settingsTarget));
        }
    }
});

test("releases from the first guide version onward include authored guide content", () => {
    const current = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")).version;
    const a = current.split(".").map(Number),
        b = catalog.FIRST_VERSION.split(".").map(Number);
    let comparison = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        comparison = (a[i] || 0) - (b[i] || 0);
        if (comparison) break;
    }
    if (comparison >= 0) assert.ok(catalog.getGuide(current), `Release ${current} needs authored update content`);
});

test("panel guide describes the supported mouse controls without retired keyboard shortcuts", () => {
    const card = catalog.getGuide("1.4.1").cards.find((entry) => entry.id === "panel-width");
    assert.equal(card.target, "panels");
    assert.equal(card.settingsTarget, "panels");
    const instructions = card.instructions.join(" ");
    assert.equal(instructions, "경계 드래그로 조절, 더블클릭으로 초기화.");
    assert.match(instructions, /더블클릭/);
    assert.doesNotMatch(instructions, /방향키|Shift|Enter|Escape|포커스|초점/);
});

test("1.4.1 introduces only panel sizing and history backup", () => {
    const guide = catalog.getGuide("1.4.1");
    assert.deepEqual(
        Array.from(guide.cards, (card) => card.id),
        ["panel-width", "history-backup"]
    );
    assert.doesNotMatch([guide.summary, ...guide.cards.map((card) => card.title)].join(" "), /스트림/);
});

test("1.4.2 briefly announces the added category exclusion", () => {
    const guide = catalog.getGuide("1.4.2");
    assert.equal(guide.summary, "카테고리 제외 추가.");
    assert.deepEqual(
        Array.from(guide.cards, (card) => card.id),
        ["category-exclusions"]
    );
    const card = guide.cards[0];
    assert.equal(card.title, "카테고리 제외");
    assert.equal(card.summary, "전체 방송 탐색에서 사용. 우측 + 제외 추가. 방송 목록 검색·필터를 켜야 작동.");
    assert.deepEqual(Array.from(card.instructions), [
        "전체 방송 탐색에서 사용. 우측 + 제외 추가. 방송 목록 검색·필터를 켜야 작동.",
    ]);
    assert.equal(card.target, "categories");
    assert.equal(card.settingsTarget, "categories");
});

test("1.4.3 briefly announces the ambient effect without adding a settings destination", () => {
    const guide = catalog.getGuide("1.4.3");
    assert.equal(guide.summary, "앰비언트 효과 추가. 설정 → 플레이어에서 켜고, 플레이어 톱니바퀴에서 세기 조절.");
    assert.equal(guide.cards.length, 0);
    assert.ok(Object.isFrozen(guide.cards));
    assert.doesNotMatch(guide.summary, /광고 차단|팝업|AdGuard/);
});

test("1.4.4 briefly announces folders, chat multiview and the following title history", () => {
    const guide = catalog.getGuide("1.4.4");
    assert.equal(
        guide.summary,
        "팔로잉 폴더·채팅 멀티뷰 추가(설정에서 켜기). 팔로잉 방제를 자동으로 모아 팔로잉 화면에서 확인."
    );
    assert.equal(guide.cards.length, 0);
    assert.ok(Object.isFrozen(guide.cards));
    assert.doesNotMatch(guide.summary, /앰비언트|카테고리 제외/);
});

test("1.4.5 briefly announces the list filter, the live page title history, and own replay chats", () => {
    const guide = catalog.getGuide("1.4.5");
    assert.equal(
        guide.summary,
        "방송 목록 필터 개선(이상·이하·범위, 보고 와도 유지), 방송 화면 제목 옆에서 이전 방제 확인, 다시보기에서 내 채팅 강조"
    );
    assert.equal(guide.cards.length, 0);
    assert.ok(Object.isFrozen(guide.cards));
    assert.doesNotMatch(guide.summary, /\./, "the summary separates items with commas only");
    assert.doesNotMatch(guide.summary, /팔로잉 폴더|채팅 멀티뷰/);
});

test("1.4.6 briefly announces the replay start and end time where the date was, and bug fixes", () => {
    const guide = catalog.getGuide("1.4.6");
    assert.equal(guide.summary, "다시보기 조회수 옆 날짜 자리에 방송 시작·종료 시각 표시, 각종 버그 수정");
    assert.equal(guide.cards.length, 0);
    assert.ok(Object.isFrozen(guide.cards));
    assert.doesNotMatch(guide.summary, /\./, "the summary separates items with commas only");
    assert.doesNotMatch(guide.summary, /방송 목록 필터|내 채팅|사이트 액세스/);
});
