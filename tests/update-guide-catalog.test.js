const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const root = path.join(__dirname, "..");
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(root, "shared/updateGuide.js"), "utf8"), context);
const catalog = context.BetterChzzkUpdateGuide;

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
            assert.ok(["panels", "history", "stream"].includes(card.target));
            assert.ok(["panels", "history", "stream"].includes(card.settingsTarget));
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
