const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadFilterModel() {
    const context = vm.createContext({});
    const source = fs.readFileSync(path.join(__dirname, "../features/categoryTools/filterModel.js"), "utf8");
    vm.runInContext(source, context);
    return context.BetterChzzk.categoryToolsFilterModel;
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

test("category models, repository and search controller load before their runtime in the isolated world", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../manifest.json"), "utf8"));
    const isolated = manifest.content_scripts.find(
        (entry) => entry.world !== "MAIN" && entry.js.includes("features/categoryTools.js")
    );
    assert.ok(isolated);
    let previous = -1;
    for (const file of [
        "features/categoryTools/filterModel.js",
        "features/categoryTools/repository.js",
        "features/categoryTools/searchController.js",
        "features/categoryTools.js",
    ]) {
        const index = isolated.js.indexOf(file);
        assert.ok(index > previous, `${file} must be present after its dependencies`);
        previous = index;
    }
});

test("category filters parse follower and view counts with Korean units and format editable values", () => {
    const model = loadFilterModel();
    const examples = [
        ["1.5만", 15000, "15,000"],
        ["2천", 2000, "2,000"],
        [" 12,345명 ", 12345, "12,345"],
        ["3만", 30000, "3만"],
        ["1.99", 1, "1"],
        ["", 0, ""],
        ["잘못된 값", 0, ""],
        ["-5", 0, ""],
    ];
    for (const kind of ["followers", "views"]) {
        for (const [input, count, formatted] of examples) {
            assert.equal(model.parseFilterInputForKind(kind, input), count, `${kind}: ${input}`);
            assert.equal(model.formatFilterInputForKind(kind, count), formatted, `${kind}: ${count}`);
        }
    }
});

test("category duration filters convert entered hours to seconds and format hours", () => {
    const model = loadFilterModel();
    for (const [input, seconds, formatted] of [
        ["1.5시간", 5400, "1.5"],
        ["2", 7200, "2"],
        ["0.25", 900, "0.25"],
        ["0", 0, ""],
        ["-1", 0, ""],
        ["시간", 0, ""],
    ]) {
        assert.equal(model.parseFilterInputForKind("duration", input), seconds);
        assert.equal(model.formatFilterInputForKind("duration", seconds), formatted);
    }
    assert.equal(model.parseFilterInputForKind("duration", "0.0005"), 1);
    assert.equal(model.formatFilterInputForKind("duration", 3660), "1.02");
});

test("category filter presets use only supplied settings, deduplicate thresholds and preserve inclusive ranges", () => {
    const model = loadFilterModel();
    const options = Object.freeze({
        categoryToolsFollowerFilterPreset1: 10000,
        categoryToolsFollowerFilterPreset2: "1000",
        categoryToolsFollowerFilterPreset3: 10000,
        categoryToolsFollowerFilterPreset4: 0,
        categoryToolsFollowerFilterPreset5: -100,
        categoryToolsFollowerFilterPreset6: 5000.9,
        categoryToolsViewFilterPreset1: 100,
        categoryToolsDurationFilterPreset1: 2,
        categoryToolsDurationFilterPreset2: 1,
    });
    assert.deepEqual(plain(model.getFilterPresetValues("followers", options)), [1000, 5000, 10000]);
    assert.deepEqual(plain(model.getFilterPresetValues("views", options)), [100]);
    assert.deepEqual(plain(model.getFilterPresetValues("duration", options)), [3600, 7200]);
    assert.deepEqual(plain(model.getFilterPresetRanges("followers", options)), [
        { min: 0, max: 0 },
        { min: 0, max: 1000 },
        { min: 1000, max: 5000 },
        { min: 5000, max: 10000 },
        { min: 10000, max: 0 },
    ]);
    assert.deepEqual(plain(model.getFilterPresetRanges("duration", options)), [
        { min: 0, max: 0 },
        { min: 0, max: 3600 },
        { min: 3600, max: 7200 },
        { min: 7200, max: 0 },
    ]);
    assert.deepEqual(plain(model.getFilterPresetRanges("followers", {})), [{ min: 0, max: 0 }]);

    const revisedOptions = { ...options, categoryToolsViewFilterPreset1: 200 };
    assert.deepEqual(plain(model.getFilterPresetValues("views", revisedOptions)), [200]);
    assert.deepEqual(plain(model.getFilterPresetValues("views", options)), [100]);
});

test("category filter labels retain count units and duration wording", () => {
    const model = loadFilterModel();
    assert.equal(model.formatFilterOptionLabel("followers", 0, 0, "명"), "전체");
    assert.equal(model.formatFilterOptionLabel("followers", 0, 1000, "명"), "1,000명 이하");
    assert.equal(model.formatFilterOptionLabel("followers", 10000, 0, "명"), "1만명 ~ 최대");
    assert.equal(model.formatFilterOptionLabel("views", 100, 500, "회"), "100회 ~ 500회");
    assert.equal(model.formatFilterOptionLabel("duration", 7200, 14400, "시간"), "2시간 ~ 4시간");
    assert.equal(model.formatFilterOptionLabel("duration", 7200, 0, "시간"), "2시간 이상");
});

test("category filter drag ranges are direction independent and preserve open ends", () => {
    const model = loadFilterModel();
    for (const [first, last, expected] of [
        [
            { min: 1000, max: 5000 },
            { min: 10000, max: 30000 },
            { min: 1000, max: 30000 },
        ],
        [
            { min: 0, max: 1000 },
            { min: 10000, max: 0 },
            { min: 0, max: 0 },
        ],
        [
            { min: 1000, max: 5000 },
            { min: 10000, max: 0 },
            { min: 1000, max: 0 },
        ],
        [
            { min: 0, max: 0 },
            { min: 1000, max: 5000 },
            { min: 0, max: 5000 },
        ],
        [
            { min: 0, max: 0 },
            { min: 0, max: 0 },
            { min: 0, max: 0 },
        ],
        [
            { min: 1000, max: 1000 },
            { min: 1000, max: 1000 },
            { min: 1000, max: 0 },
        ],
    ]) {
        Object.freeze(first);
        Object.freeze(last);
        assert.deepEqual(plain(model.combineFilterOptionRanges(first, last)), expected);
        assert.deepEqual(plain(model.combineFilterOptionRanges(last, first)), expected);
    }
    assert.equal(model.hasFilterOptionRange({ min: 0, max: 0 }), false);
    assert.equal(model.hasFilterOptionRange({ min: 0, max: 1000 }), true);
    assert.equal(model.hasFilterOptionRange({ min: 1000, max: 0 }), true);
    assert.equal(model.hasFilterOptionRange(null), false);
});

test("category count filters include both boundaries and treat unavailable counts as zero", () => {
    const model = loadFilterModel();
    for (const [value, min, max, expected] of [
        [1000, 1000, 5000, true],
        [5000, 1000, 5000, true],
        [999, 1000, 5000, false],
        [5001, 1000, 5000, false],
        [1000000, 1000, 0, true],
        [0, 0, 1000, true],
        ["5000", 1000, 5000, true],
        [undefined, 1000, 0, false],
        [null, 0, 1000, true],
        ["잘못된 값", 0, 0, true],
    ]) {
        assert.equal(model.passesCountRange(value, min, max), expected, `${value}: ${min}–${max}`);
    }
});
