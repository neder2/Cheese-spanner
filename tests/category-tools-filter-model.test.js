const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadFilterModel() {
    const context = vm.createContext({});
    for (const file of ["shared/categoryExclusions.js", "features/categoryTools/filterModel.js"]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
    }
    return context.CheeseSpanner.categoryToolsFilterModel;
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
        "shared/categoryExclusions.js",
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

test("category exclusions match only the exact type and ID while names may change", () => {
    const model = loadFilterModel();
    const exclusions = Object.freeze([
        Object.freeze({ categoryType: "GAME", categoryId: "League_of_Legends", categoryValue: "예전 이름" }),
        Object.freeze({ categoryType: "ETC", categoryId: "talk", categoryValue: "소통" }),
    ]);
    for (const [category, expected] of [
        [{ categoryType: "GAME", categoryId: "League_of_Legends", categoryValue: "새 이름" }, false],
        [{ categoryType: "ETC", categoryId: "League_of_Legends", categoryValue: "예전 이름" }, true],
        [{ categoryType: "GAME", categoryId: "league_of_legends", categoryValue: "예전 이름" }, true],
        [{ categoryType: "GAME", categoryId: "League_of_Legends_extra", categoryValue: "예전 이름" }, true],
        [{ categoryType: "GAME", categoryId: "other", categoryValue: "예전 이름" }, true],
        [{ categoryType: "ETC", categoryId: "talk" }, false],
        [
            {
                categoryType: "GAME",
                categoryId: "other",
                title: "League_of_Legends",
                channelName: "예전 이름",
                tags: ["League_of_Legends"],
                liveCategory: "League_of_Legends",
            },
            true,
        ],
    ]) {
        assert.equal(model.passesCategoryExclusions(category, exclusions), expected);
    }
    assert.deepEqual(plain(exclusions), [
        { categoryType: "GAME", categoryId: "League_of_Legends", categoryValue: "예전 이름" },
        { categoryType: "ETC", categoryId: "talk", categoryValue: "소통" },
    ]);
});

test("category exclusions leave missing or invalid identity visible", () => {
    const model = loadFilterModel();
    const exclusions = [{ categoryType: "GAME", categoryId: "one", categoryValue: "같은 이름" }];
    for (const category of [
        null,
        undefined,
        {},
        { categoryValue: "같은 이름" },
        { categoryType: "GAME" },
        { categoryId: "one" },
        { categoryType: "game", categoryId: "one" },
        { categoryType: "GAME", categoryId: 1 },
        { categoryType: "GAME", categoryId: " " },
        { categoryType: "GAME", categoryId: "." },
        { categoryType: "GAME", categoryId: ".." },
        { categoryType: "GAME", categoryId: "one\n" },
    ]) {
        assert.equal(model.passesCategoryExclusions(category, exclusions), true);
    }
    assert.equal(
        model.passesCategoryExclusions(exclusions[0], [null, {}, { categoryType: "game", categoryId: "one" }]),
        true
    );
    assert.equal(model.passesCategoryExclusions(exclusions[0], []), true);
    assert.equal(model.passesCategoryExclusions(exclusions[0], null), true);
});

test("category exclusions also accept a set of exact category keys across VM boundaries", () => {
    const model = loadFilterModel();
    const keys = new Set([JSON.stringify(["GAME", "Case_ID"]), JSON.stringify(["ETC", "other"])]);
    assert.equal(model.passesCategoryExclusions({ categoryType: "GAME", categoryId: "Case_ID" }, keys), false);
    assert.equal(model.passesCategoryExclusions({ categoryType: "ETC", categoryId: "Case_ID" }, keys), true);
    assert.equal(model.passesCategoryExclusions({ categoryType: "GAME", categoryId: "case_id" }, keys), true);
    assert.equal(model.passesCategoryExclusions({ categoryId: "Case_ID" }, keys), true);
    assert.equal(keys.size, 2);
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

test("category filter quick values use only supplied settings and deduplicate thresholds", () => {
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
    assert.deepEqual(plain(model.getFilterPresetValues("followers", {})), []);

    const revisedOptions = { ...options, categoryToolsViewFilterPreset1: 200 };
    assert.deepEqual(plain(model.getFilterPresetValues("views", revisedOptions)), [200]);
    assert.deepEqual(plain(model.getFilterPresetValues("views", options)), [100]);
});

test("category filter modes keep one inclusive effective range and carry values between modes", () => {
    const model = loadFilterModel();
    const none = Object.freeze(model.createFilterState());
    assert.deepEqual(plain(model.effectiveRange(none)), { min: 0, max: 0 });
    assert.equal(model.isActiveRange(model.effectiveRange(none)), false);

    const atLeast = Object.freeze(model.setFilterSingleValue(model.setFilterMode(none, "min"), 1000));
    assert.deepEqual(plain(atLeast), { mode: "min", min: 1000, max: 0 });
    assert.equal(
        model.isActiveRange(model.effectiveRange(model.setFilterMode(none, "min"))),
        false,
        "a mode alone is not a condition"
    );

    const atMost = model.setFilterMode(atLeast, "max");
    assert.deepEqual(plain(atMost), { mode: "max", min: 0, max: 1000 }, "이상↔이하 keeps the value");
    assert.deepEqual(plain(model.setFilterMode(atLeast, "range")), { mode: "range", min: 1000, max: 0 });
    assert.deepEqual(plain(model.setFilterMode(atMost, "range")), { mode: "range", min: 0, max: 1000 });
    const hidden = model.setFilterMode(atLeast, "none");
    assert.deepEqual(plain(model.effectiveRange(hidden)), { min: 0, max: 0 });
    assert.deepEqual(
        plain(model.setFilterMode(hidden, "min")),
        { mode: "min", min: 1000, max: 0 },
        "전체 keeps the last value"
    );
    assert.equal(model.setFilterMode(atLeast, "unknown"), atLeast);

    const range = model.setFilterRangeValue(model.setFilterRangeValue(none, "min", 5000), "max", 1000);
    assert.deepEqual(plain(range), { mode: "range", min: 5000, max: 1000 });
    assert.deepEqual(plain(model.effectiveRange(range)), { min: 1000, max: 5000 }, "input order does not matter");
    assert.deepEqual(plain(model.effectiveRange(model.setFilterRangeValue(none, "max", 300))), { min: 0, max: 300 });
    assert.deepEqual(plain(model.setFilterSingleValue(atMost, 2.9)), { mode: "max", min: 0, max: 2 });
    assert.deepEqual(plain(model.setFilterSingleValue(atLeast, -5)), { mode: "min", min: 0, max: 0 });

    assert.deepEqual(plain(model.filterStateFromRange(100, 500)), { mode: "range", min: 100, max: 500 });
    assert.deepEqual(plain(model.filterStateFromRange(100, 0)), { mode: "min", min: 100, max: 0 });
    assert.deepEqual(plain(model.filterStateFromRange(0, 500)), { mode: "max", min: 0, max: 500 });
    assert.deepEqual(plain(model.filterStateFromRange(0, 0)), { mode: "none", min: 0, max: 0 });
});

test("category condition labels name the kind, list unit, value and direction", () => {
    const model = loadFilterModel();
    assert.equal(model.formatConditionLabel("followers", { min: 10000, max: 0 }), "팔로워 1만명 이상");
    assert.equal(model.formatConditionLabel("views", { min: 0, max: 300 }, { liveList: true }), "시청자 300명 이하");
    assert.equal(
        model.formatConditionLabel("views", { min: 1000, max: 5000 }, { liveList: false }),
        "조회수 1천~5천회"
    );
    assert.equal(model.formatConditionLabel("duration", { min: 7200, max: 14400 }), "진행 2~4시간");
    assert.equal(model.formatConditionLabel("duration", { min: 0, max: 5400 }), "진행 1.5시간 이하");
    assert.equal(model.formatConditionLabel("followers", { min: 0, max: 0 }), "");
    for (const [value, label] of [
        [300, "300"],
        [1000, "1천"],
        [1500, "1,500"],
        [15000, "1.5만"],
        [12345, "12,345"],
        [100000, "10만"],
    ]) {
        assert.equal(model.formatConditionValue("followers", value), label);
    }
});

test("search terms need every word inside one field and drop cards with a minus word", () => {
    const model = loadFilterModel();
    const terms = model.parseSearchTerms("  롤   -대회 - -- LoL ");
    assert.deepEqual(plain(terms.include), ["롤", "lol"]);
    assert.deepEqual(plain(terms.exclude), ["대회"]);
    assert.equal(terms.key, "롤 -대회 lol");
    assert.equal(model.parseSearchTerms("롤  -대회   LoL").key, terms.key, "spacing alone does not change the search");
    assert.equal(model.hasSearchTerms(model.parseSearchTerms(" - ")), false);

    const fields = ["롤솔랭다이아", "정글러하늘", "리그오브레전드", "lol"].map(model.normalizeSearchText);
    assert.equal(model.matchesSearchTerms(fields, terms), true);
    assert.equal(
        model.matchesSearchTerms([...fields, "lck대회"], terms),
        false,
        "a minus word in any field hides the card"
    );
    assert.equal(model.matchesSearchTerms(["롤솔랭"], terms), false, "every include word is required");
    assert.equal(
        model.matchesSearchTerms(["채널a", "리그"], model.parseSearchTerms("a리그")),
        false,
        "no match across fields"
    );
    assert.equal(model.matchesSearchTerms(["채널a리그"], model.parseSearchTerms("A리그")), true, "case is ignored");
    assert.equal(model.matchesSearchTerms([], model.parseSearchTerms("")), true);

    assert.equal(model.removeSearchTerm("롤 -대회  듀오", 1), "롤 듀오");
    assert.equal(model.removeSearchTerm("롤", 0), "");
    assert.equal(
        model.parseSearchTerms(`${"가".repeat(99)} 나`).tokens.length,
        1,
        "only the first 100 characters count"
    );
});

test("tab filter records keep only validated routes and values and the 20 newest lists", () => {
    const model = loadFilterModel();
    const empty = { version: 1, routes: {} };
    assert.deepEqual(plain(model.readListFilterSession(null)), empty);
    assert.deepEqual(plain(model.readListFilterSession("{not json")), empty);
    assert.deepEqual(plain(model.readListFilterSession(JSON.stringify({ version: 2, routes: {} }))), empty);
    assert.deepEqual(plain(model.readListFilterSession(JSON.stringify({ version: 1, routes: [] }))), empty);

    const raw = JSON.stringify({
        version: 1,
        routes: {
            "global-lives/lives": {
                savedAt: 20,
                query: "롤 -대회",
                filters: {
                    views: { mode: "min", min: 300, max: 0 },
                    duration: { mode: "range", min: 14400, max: 3600 },
                    followers: { mode: "none", min: 1000, max: 0 },
                },
            },
            "GAME/League_of_Legends/videos": {
                savedAt: 10,
                query: "x".repeat(101),
                filters: {
                    views: { mode: "max", min: 0, max: 10000001 },
                    followers: { mode: "min", min: 5000, max: 0 },
                    duration: { mode: "min", min: 3600, max: 0 },
                },
            },
            "evil/route": { savedAt: 30, query: "롤", filters: {} },
            "GAME/A/lives": { savedAt: 40, query: "", filters: { views: { mode: "min", min: 1.5, max: 0 } } },
        },
    });
    assert.deepEqual(plain(model.readListFilterSession(raw)), {
        version: 1,
        routes: {
            "global-lives/lives": {
                savedAt: 20,
                query: "롤 -대회",
                filters: {
                    views: { mode: "min", min: 300, max: 0 },
                    duration: { mode: "range", min: 3600, max: 14400 },
                },
            },
            "GAME/League_of_Legends/videos": {
                savedAt: 10,
                query: "",
                filters: { followers: { mode: "min", min: 5000, max: 0 } },
            },
        },
    });

    let session = model.writeListFilterRoute(empty, "global-lives/lives", { query: "롤", filters: {} }, 5);
    assert.deepEqual(plain(session.routes["global-lives/lives"]), { savedAt: 5, query: "롤", filters: {} });
    session = model.writeListFilterRoute(session, "global-lives/lives", { query: " ", filters: {} }, 6);
    assert.deepEqual(plain(session.routes), {}, "a list without conditions is removed");
    for (let index = 0; index < 21; index++) {
        session = model.writeListFilterRoute(
            session,
            `GAME/C${index}/lives`,
            { query: `q${index}`, filters: {} },
            100 + index
        );
    }
    assert.equal(Object.keys(session.routes).length, 20);
    assert.equal(Object.hasOwn(session.routes, "GAME/C0/lives"), false, "the oldest list is dropped first");
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

test("tag exclusions compare normalized whole tags only and never partial words", () => {
    const context = vm.createContext({});
    for (const file of ["shared/categoryExclusions.js", "features/categoryTools/filterModel.js"]) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context);
    }
    const exclusions = context.CheeseSpanner.categoryExclusions;
    const model = context.CheeseSpanner.categoryToolsFilterModel;
    assert.deepEqual(plain(exclusions.createTagExclusion("  ##롤토체스  ")), {
        categoryType: "CHEESE_SPANNER_TAG",
        categoryId: "롤토체스",
        categoryValue: "롤토체스",
    });
    assert.deepEqual(plain(exclusions.createTagExclusion(" Just   Chatting ")), {
        categoryType: "CHEESE_SPANNER_TAG",
        categoryId: "just chatting",
        categoryValue: "Just Chatting",
    });
    for (const invalid of ["", "   ", "#", "a".repeat(101), "bell\u0007name", null, 3]) {
        assert.equal(exclusions.createTagExclusion(invalid), null, String(invalid));
    }
    assert.equal(exclusions.createTagExclusion("tab\tname").categoryValue, "tab name", "whitespace collapses");
    assert.equal(exclusions.isTagExclusion(exclusions.createTagExclusion("tag")), true);
    assert.equal(exclusions.isTagExclusion({ categoryType: "GAME", categoryId: "tag", categoryValue: "tag" }), false);
    const keys = new Set([exclusions.tagMatchKey("롤토체스"), exclusions.tagMatchKey("just chatting")]);
    assert.equal(model.passesTagExclusions(["#롤토체스"], keys), false);
    assert.equal(model.passesTagExclusions(["JUST  CHATTING"], keys), false);
    assert.equal(model.passesTagExclusions(["롤토체스대회", "롤"], keys), true, "partial words never match");
    assert.equal(model.passesTagExclusions([], keys), true);
    assert.equal(model.passesTagExclusions(undefined, keys), true);
    assert.equal(model.passesTagExclusions(["롤토체스"], new Set()), true);
});
