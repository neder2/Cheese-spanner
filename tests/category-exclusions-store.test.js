const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const {
    createCategoryExclusionsStorage,
    createCategoryExclusionsWorker,
    loadCategoryExclusions,
} = require("./helpers/category-exclusions-worker.js");

const KEY = "betterchzzkCategoryExclusionsV1";
const TYPE = "betterchzzk:category-exclusions";
const copy = (value) => structuredClone(value);
const category = (categoryId = "League_of_Legends", categoryType = "GAME", categoryValue = "리그 오브 레전드") => ({
    categoryType,
    categoryId,
    categoryValue,
});
const state = (categories = [], revision = 0) => ({ version: 1, revision, categories: copy(categories) });
const request = (operation = { kind: "get" }) => ({ type: TYPE, version: 1, operation });
const sender = (overrides = {}) => ({
    id: "category-test-extension",
    frameId: 0,
    tab: { id: 3, active: true },
    url: "https://chzzk.naver.com/lives",
    ...overrides,
});
const failure = (error) => ({ ok: false, error });

function controllerHarness(initial = {}, customChrome) {
    const storage = createCategoryExclusionsStorage(initial);
    const module = loadCategoryExclusions();
    let controller = module.createController({ chrome: customChrome || storage.chrome });
    return {
        ...storage,
        storage,
        module,
        send: (operation, from = sender()) => controller.handleMessage(request(operation), from).then(copy),
        raw: (message, from = sender()) => controller.handleMessage(message, from).then(copy),
        restart: () => (controller = module.createController({ chrome: customChrome || storage.chrome })),
    };
}

async function within(promise) {
    let timeout;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timeout = setTimeout(
                    () => reject(new Error("The independent category request did not complete")),
                    1500
                );
            }),
        ]);
    } finally {
        clearTimeout(timeout);
    }
}

test("pure validation loads without DOM globals and preserves unrelated namespace fields", () => {
    const context = vm.createContext({ URL, BetterChzzk: { existing: { retained: true } } });
    const module = loadCategoryExclusions(context);
    assert.equal(context.BetterChzzk.existing.retained, true);
    assert.equal(module.STORAGE_KEY, KEY);
    assert.equal(module.MESSAGE_TYPE, TYPE);
    assert.deepEqual(copy(module.createEmptyState()), state());
    const first = module.createEmptyState();
    first.categories.push(category());
    assert.deepEqual(copy(module.createEmptyState()), state(), "empty states must not share an array");
});

test("category identities preserve case and distinguish the exact type and ID pair", () => {
    const module = loadCategoryExclusions();
    const input = { ...category("Case_ID", "GAME", "같은 이름"), arbitraryResponseField: "must not be stored" };
    const normalized = module.normalizeCategory(input);
    assert.deepEqual(copy(normalized), category("Case_ID", "GAME", "같은 이름"));
    assert.notEqual(module.categoryKey(normalized), module.categoryKey(category("case_id", "GAME", "같은 이름")));
    assert.notEqual(module.categoryKey(normalized), module.categoryKey(category("Case_ID", "SPORT", "같은 이름")));
    assert.notEqual(module.categoryKey(category("B_C", "A")), module.categoryKey(category("C", "A_B")));
    assert.equal(module.categoryKey({ categoryType: "GAME", categoryId: "Case_ID" }), module.categoryKey(normalized));
    assert.equal(module.categoryKey("GAME", "Case_ID"), module.categoryKey(normalized));
    input.categoryId = "modified";
    assert.equal(normalized.categoryId, "Case_ID", "normalization must copy caller input");
});

test("category validation rejects malformed strings without truncating valid 200-character values", () => {
    const module = loadCategoryExclusions();
    const valid = category("I".repeat(200), "A".repeat(32), "가".repeat(200));
    assert.deepEqual(copy(module.normalizeCategory(valid)), valid);
    for (const input of [
        null,
        [],
        {},
        category(""),
        category("   "),
        category("."),
        category(".."),
        category("i".repeat(201)),
        category("id", "game"),
        category("id", "1GAME"),
        category("id", "_GAME"),
        category("id", "GAME-1"),
        category("id", "GAME\n"),
        category("id", "A".repeat(33)),
        category("id", "GAME", ""),
        category("id", "GAME", "   "),
        category("id", "GAME", "가".repeat(201)),
        { ...category(), categoryId: 12 },
        { ...category(), categoryValue: true },
    ]) {
        assert.equal(module.normalizeCategory(input), null, JSON.stringify(input));
    }
    for (const code of [0, 9, 10, 13, 31, 127, 128, 159]) {
        assert.equal(module.normalizeCategory(category(`a${String.fromCharCode(code)}b`)), null);
        assert.equal(module.normalizeCategory(category("id", "GAME", `a${String.fromCharCode(code)}b`)), null);
    }
    assert.equal(module.categoryKey({ categoryType: "game", categoryId: "id" }), "");
    assert.equal(module.categoryKey({ categoryType: "GAME", categoryId: ".." }), "");
    assert.equal(module.categoryKey({ categoryType: "GAME", categoryId: "   " }), "");
    assert.deepEqual(
        copy(module.normalizeCategory(category(" ID ", "GAME", " 이름 "))),
        category(" ID ", "GAME", " 이름 ")
    );
});

test("stored state validation keeps exact order and rejects corruption instead of repairing or slicing", () => {
    const module = loadCategoryExclusions();
    const valid = state([category(), category("same-id", "SPORT"), category("same-id")], 29);
    assert.deepEqual(copy(module.normalizeState(valid)), valid);
    const normalized = module.normalizeState(valid);
    valid.categories[0].categoryValue = "changed outside";
    assert.equal(normalized.categories[0].categoryValue, "리그 오브 레전드");
    for (const invalid of [
        undefined,
        null,
        [],
        {},
        { ...state(), version: 2 },
        { ...state(), revision: -1 },
        { ...state(), revision: 1.1 },
        { ...state(), revision: "1" },
        { ...state(), revision: Number.MAX_SAFE_INTEGER + 1 },
        { ...state(), categories: {} },
        state([category(), category("League_of_Legends", "GAME", "renamed")]),
        state([category(".")]),
        state(Array.from({ length: 101 }, (_, index) => category(String(index)))),
        { ...state(), unexpected: "do not discard" },
        state([{ ...category(), unexpected: "do not discard" }]),
    ]) {
        assert.equal(module.normalizeState(invalid), null, JSON.stringify(invalid));
    }
    assert.ok(module.normalizeState(state(Array.from({ length: 100 }, (_, index) => category(String(index))))));
});

test("an absent local key yields an unsaved empty state; an existing empty key retains its revision", async () => {
    const h = controllerHarness({ unrelated: { retained: true } });
    assert.deepEqual(await h.send({ kind: "get" }), { ok: true, state: state() });
    assert.equal(Object.hasOwn(h.local, KEY), false);
    assert.deepEqual(h.storage.categoryWrites, []);
    h.local[KEY] = state([], 42);
    assert.deepEqual(await h.send({ kind: "get" }), { ok: true, state: state([], 42) });
    assert.deepEqual(h.storage.categoryWrites, []);
    assert.deepEqual(h.local.unrelated, { retained: true });
});

test("each add/remove reads the newest durable state and preserves same-name different categories", async () => {
    const a = category("a", "GAME", "같은 이름");
    const b = category("a", "SPORT", "같은 이름");
    const c = category("A", "GAME", "같은 이름");
    const h = controllerHarness();
    assert.deepEqual(await h.send({ kind: "add", category: a }), { ok: true, state: state([a], 1) });
    h.local[KEY] = state([a, b], 7);
    assert.deepEqual(await h.send({ kind: "add", category: c }), { ok: true, state: state([a, b, c], 8) });
    assert.deepEqual(await h.send({ kind: "remove", categoryType: "GAME", categoryId: "a" }), {
        ok: true,
        state: state([b, c], 9),
    });
    assert.equal(h.storage.categoryReads.length, 3);
    assert.ok(h.storage.allWrites.every((write) => write.area === "local" && Object.keys(write.values).length === 1));
});

test("tag exclusions use the existing individual add/remove contract and count toward the same limit", async () => {
    const h = controllerHarness();
    const tag = h.module.createTagExclusion("#롤토체스");
    assert.deepEqual(copy(tag), category("롤토체스", "CHEESE_SPANNER_TAG", "롤토체스"));
    assert.deepEqual(await h.send({ kind: "add", category: tag }), { ok: true, state: state([tag], 1) });
    assert.deepEqual(await h.send({ kind: "add", category: tag }), { ok: true, state: state([tag], 1) });
    assert.deepEqual(await h.send({ kind: "remove", categoryType: "CHEESE_SPANNER_TAG", categoryId: "롤토체스" }), {
        ok: true,
        state: state([], 2),
    });
    h.local[KEY] = state(
        Array.from({ length: 100 }, (_, index) => category(`id-${index}`)),
        3
    );
    assert.deepEqual(await h.send({ kind: "add", category: tag }), failure("limit-reached"));
});

test("duplicate add and nonexistent remove are successful no-ops without renaming or reordering", async () => {
    const a = category("a");
    const b = category("b");
    const initial = state([a, b], 9);
    const h = controllerHarness({ [KEY]: initial });
    assert.deepEqual(await h.send({ kind: "add", category: { ...a, categoryValue: "new display name" } }), {
        ok: true,
        state: initial,
    });
    assert.deepEqual(await h.send({ kind: "remove", categoryType: "GAME", categoryId: "absent" }), {
        ok: true,
        state: initial,
    });
    assert.deepEqual(h.local[KEY], initial);
    assert.deepEqual(h.storage.categoryWrites, []);
});

test("simultaneous tab changes and opposite changes follow receive order without stale-array replacement", async () => {
    const h = controllerHarness();
    const a = category("a");
    const b = category("b");
    const gate = h.pauseNext("get");
    const addedA = h.send({ kind: "add", category: a }, sender({ tab: { id: 1 } }));
    await gate.started;
    const addedB = h.send({ kind: "add", category: b }, sender({ tab: { id: 2 } }));
    const removedA = h.send({ kind: "remove", categoryType: "GAME", categoryId: "a" }, sender({ tab: { id: 1 } }));
    assert.equal(h.storage.categoryReads.length, 1, "later operations must wait for the current storage callback");
    gate.release();
    assert.deepEqual(await addedA, { ok: true, state: state([a], 1) });
    assert.deepEqual(await addedB, { ok: true, state: state([a, b], 2) });
    assert.deepEqual(await removedA, { ok: true, state: state([b], 3) });
    const removedB = h.send({ kind: "remove", categoryType: "GAME", categoryId: "b" });
    const readdedB = h.send({ kind: "add", category: b });
    assert.deepEqual(await removedB, { ok: true, state: state([], 4) });
    assert.deepEqual(await readdedB, { ok: true, state: state([b], 5) });
});

test("a paused first read cannot expose an empty success before restoration completes", async () => {
    const initial = state([category()], 5);
    const h = controllerHarness({ [KEY]: initial });
    const gate = h.pauseNext("get");
    let finished = false;
    const reading = h.send({ kind: "get" }).then((result) => {
        finished = true;
        return result;
    });
    await gate.started;
    assert.equal(finished, false);
    assert.deepEqual(h.storage.categoryWrites, []);
    gate.release();
    assert.deepEqual(await reading, { ok: true, state: initial });
});

test("mutation success and new revision wait for the write callback", async () => {
    const a = category("a");
    const initial = state([a], 4);
    const h = controllerHarness({ [KEY]: initial });
    for (const operation of [
        { kind: "add", category: category("b") },
        { kind: "remove", categoryType: "GAME", categoryId: "a" },
    ]) {
        const before = copy(h.local[KEY]);
        const gate = h.pauseNext("set");
        let finished = false;
        const mutation = h.send(operation).then((result) => {
            finished = true;
            return result;
        });
        await gate.started;
        assert.equal(finished, false);
        assert.deepEqual(h.local[KEY], before);
        gate.release();
        const result = await mutation;
        assert.equal(result.ok, true);
        assert.equal(result.state.revision, before.revision + 1);
        assert.deepEqual(result.state, h.local[KEY]);
    }
});

test("callback and synchronous read failures never erase state and leave the queue usable", async () => {
    for (const kind of ["callback", "throw"]) {
        const a = category("a");
        const b = category("b");
        const initial = state([a], 5);
        const h = controllerHarness({ [KEY]: initial });
        h.failNext("get", kind);
        assert.deepEqual(await h.send({ kind: "add", category: b }), failure("storage-read-failed"));
        assert.deepEqual(h.local[KEY], initial);
        assert.deepEqual(h.storage.categoryWrites, []);
        assert.deepEqual(await h.send({ kind: "add", category: b }), { ok: true, state: state([a, b], 6) });
        if (kind === "callback")
            assert.ok(
                h.lastErrorReads.some((read) => read.operation === "get" && read.error),
                "read lastError in its callback"
            );
    }
    const h = controllerHarness({ [KEY]: state([category()], 2) });
    h.failNext("get");
    assert.deepEqual(await h.send({ kind: "get" }), failure("storage-read-failed"));
    assert.deepEqual(h.storage.categoryWrites, []);
    assert.deepEqual(await h.send({ kind: "get" }), { ok: true, state: state([category()], 2) });
});

test("callback and synchronous write failures do not acknowledge changes or advance durable revision", async () => {
    for (const kind of ["callback", "throw"]) {
        const a = category("a");
        const b = category("b");
        const initial = state([a], 5);
        const h = controllerHarness({ [KEY]: initial });
        h.failNext("set", kind);
        assert.deepEqual(await h.send({ kind: "add", category: b }), failure("storage-write-failed"));
        assert.deepEqual(h.local[KEY], initial);
        assert.deepEqual(h.storage.categoryWrites, []);
        assert.deepEqual(await h.send({ kind: "add", category: b }), { ok: true, state: state([a, b], 6) });
        if (kind === "callback")
            assert.ok(
                h.lastErrorReads.some((read) => read.operation === "set" && read.error),
                "read lastError in its callback"
            );
    }
    const h = controllerHarness({ [KEY]: state([category()], 2) });
    h.failNext("set");
    assert.deepEqual(
        await h.send({ kind: "remove", categoryType: "GAME", categoryId: "League_of_Legends" }),
        failure("storage-write-failed")
    );
    assert.deepEqual(h.local[KEY], state([category()], 2));
    assert.deepEqual(await h.send({ kind: "remove", categoryType: "GAME", categoryId: "League_of_Legends" }), {
        ok: true,
        state: state([], 3),
    });
});

test("a malformed storage callback payload cannot be mistaken for an absent key", async () => {
    const module = loadCategoryExclusions();
    for (const payload of [undefined, null, [], true]) {
        let writes = 0;
        const chrome = {
            runtime: { id: "category-test-extension", lastError: null },
            storage: {
                local: {
                    get(_key, callback) {
                        queueMicrotask(() => callback(payload));
                    },
                    set() {
                        writes++;
                    },
                },
            },
        };
        const controller = module.createController({ chrome });
        assert.deepEqual(
            copy(await controller.handleMessage(request({ kind: "add", category: category() }), sender())),
            failure("storage-read-failed")
        );
        assert.equal(writes, 0);
    }
});

test("present undefined, unsupported and malformed stored values remain untouched on get/add/remove", async () => {
    for (const value of [
        undefined,
        null,
        { version: 2, revision: 2, categories: [] },
        state([category(), category()]),
        state([category(".")]),
    ]) {
        const h = controllerHarness({ [KEY]: value, unrelated: "preserved" });
        for (const operation of [
            { kind: "get" },
            { kind: "add", category: category("another") },
            { kind: "remove", categoryType: "GAME", categoryId: "League_of_Legends" },
        ])
            assert.deepEqual(await h.send(operation), failure("invalid-stored-state"));
        assert.equal(Object.hasOwn(h.local, KEY), true);
        assert.deepEqual(h.local[KEY], value);
        assert.equal(h.local.unrelated, "preserved");
        assert.deepEqual(h.storage.categoryWrites, []);
        h.local[KEY] = state();
        assert.deepEqual(await h.send({ kind: "add", category: category("recovered") }), {
            ok: true,
            state: state([category("recovered")], 1),
        });
    }
});

test("the 100-item limit rejects only a new item and never truncates the stored list", async () => {
    const categories = Array.from({ length: 100 }, (_, index) => category(String(index)));
    const initial = state(categories, 50);
    const h = controllerHarness({ [KEY]: initial });
    assert.deepEqual(await h.send({ kind: "add", category: category("101") }), failure("limit-reached"));
    assert.deepEqual(h.local[KEY], initial);
    assert.deepEqual(await h.send({ kind: "add", category: categories[0] }), { ok: true, state: initial });
    assert.deepEqual(h.storage.categoryWrites, []);
    await h.send({ kind: "remove", categoryType: "GAME", categoryId: "0" });
    assert.deepEqual(await h.send({ kind: "add", category: category("101") }), {
        ok: true,
        state: state([...categories.slice(1), category("101")], 52),
    });
});

test("exhausted revision refuses actual changes but permits get and idempotent requests", async () => {
    const a = category("a");
    const initial = state([a], Number.MAX_SAFE_INTEGER);
    const h = controllerHarness({ [KEY]: initial });
    for (const operation of [
        { kind: "get" },
        { kind: "add", category: a },
        { kind: "remove", categoryType: "GAME", categoryId: "absent" },
    ])
        assert.deepEqual(await h.send(operation), { ok: true, state: initial });
    assert.deepEqual(await h.send({ kind: "add", category: category("b") }), failure("storage-write-failed"));
    assert.deepEqual(
        await h.send({ kind: "remove", categoryType: "GAME", categoryId: "a" }),
        failure("storage-write-failed")
    );
    assert.deepEqual(h.local[KEY], initial);
    assert.deepEqual(h.storage.categoryWrites, []);
});

test("controller recreation restores durable revision while actual key removal yields the default", async () => {
    const h = controllerHarness();
    await h.send({ kind: "add", category: category("first") });
    h.restart();
    assert.deepEqual(await h.send({ kind: "add", category: category("second") }), {
        ok: true,
        state: state([category("first"), category("second")], 2),
    });
    delete h.local[KEY];
    assert.deepEqual(await h.send({ kind: "get" }), { ok: true, state: state() });
    assert.deepEqual(await h.send({ kind: "add", category: category("new") }), {
        ok: true,
        state: state([category("new")], 1),
    });
});

test("only the same extension's integer tab, top frame and exact lives URL may access storage", async () => {
    const h = controllerHarness();
    for (const from of [
        undefined,
        null,
        sender({ id: "another-extension" }),
        sender({ id: undefined }),
        sender({ tab: undefined }),
        sender({ tab: { id: -1 } }),
        sender({ tab: { id: 1.5 } }),
        sender({ tab: { id: "1" } }),
        sender({ tab: { id: Infinity } }),
        sender({ frameId: 1 }),
        sender({ frameId: undefined }),
        ...[
            "https://chzzk.naver.com/",
            "https://chzzk.naver.com/live/abc",
            "https://chzzk.naver.com/lives/extra",
            "https://chzzk.naver.com/lives//",
            "https://chzzk.naver.com/lives-other",
            "https://chzzk.naver.com/LIVES",
            "https://chzzk.naver.com.evil.test/lives",
            "https://chzzk.naver.com@evil.test/lives",
            "https://user:password@chzzk.naver.com/lives",
            "https://chzzk.naver.com:443/lives",
            "https://chzzk.naver.com:444/lives",
            "http://chzzk.naver.com/lives",
            "https://chzzk.naver.com./lives",
            "https://chzzk.naver.com/other/../lives",
            "https://chzzk.naver.com/%6cives",
            "https://chzzk.naver.com/lives\n",
            "not a URL",
        ].map((url) => sender({ url })),
    ]) {
        const response = await h.raw(request(), from === undefined ? null : from);
        assert.deepEqual(response, failure("untrusted-sender"), JSON.stringify(from));
    }
    assert.equal(h.storage.categoryReads.length, 0);
    assert.deepEqual(h.storage.categoryWrites, []);
    for (const url of [
        "https://chzzk.naver.com/lives",
        "https://chzzk.naver.com/lives/",
        "https://chzzk.naver.com/lives?sortType=POPULAR#filters",
        "https://chzzk.naver.com/lives/?x=1#filters",
    ])
        assert.deepEqual(await h.send({ kind: "get" }, sender({ url, tab: { id: 0 } })), { ok: true, state: state() });
});

test("request validation permits only version one and the three exact operation schemas", async () => {
    const h = controllerHarness();
    for (const message of [
        null,
        [],
        {},
        { ...request(), type: "other" },
        { ...request(), operation: null },
        { ...request(), operation: [] },
        { ...request(), operation: { kind: "replace", categories: [] } },
        { ...request(), operation: { kind: "get", categories: [] } },
        { ...request(), operation: { kind: "add" } },
        { ...request(), operation: { kind: "add", category: category(".") } },
        { ...request(), operation: { kind: "add", category: category(), categories: [] } },
        { ...request(), operation: { kind: "remove", categoryType: "GAME", categoryId: "." } },
        {
            ...request(),
            operation: { kind: "remove", categoryType: "GAME", categoryId: "valid", categoryValue: "ignored" },
        },
        { ...request(), tabId: 99 },
    ])
        assert.deepEqual(await h.raw(message), failure("invalid-request"), JSON.stringify(message));
    for (const version of [undefined, null, "1", 0, 2, 1.5])
        assert.deepEqual(await h.raw({ ...request(), version }), failure("unsupported-version"));
    assert.equal(h.storage.categoryReads.length, 0);
    assert.deepEqual(h.storage.categoryWrites, []);
});

test("storage API absence produces a stable error without exposing API exception details", async () => {
    for (const chrome of [
        {},
        { runtime: { id: "category-test-extension" } },
        { runtime: { id: "category-test-extension" }, storage: {} },
        { runtime: { id: "category-test-extension" }, storage: { local: {} } },
        { runtime: { id: "category-test-extension" }, storage: { local: { get() {} } } },
        { runtime: { id: "category-test-extension" }, storage: { local: { set() {} } } },
    ]) {
        const h = controllerHarness({}, chrome);
        const expected = chrome.runtime ? "storage-unavailable" : "untrusted-sender";
        assert.deepEqual(await h.send({ kind: "get" }), failure(expected));
    }
});

test("the packaged background imports the DOM-independent module and routes durable profile changes", async () => {
    const storage = createCategoryExclusionsStorage({ unrelated: { retained: true } });
    const worker = createCategoryExclusionsWorker(storage);
    await worker.ready();
    assert.ok(worker.imported.includes("shared/categoryExclusions.js"));
    assert.deepEqual(await worker.send(request(), sender()), { ok: true, state: state() });
    assert.deepEqual(await worker.send(request({ kind: "add", category: category("persisted") }), sender()), {
        ok: true,
        state: state([category("persisted")], 1),
    });
    const restarted = createCategoryExclusionsWorker(createCategoryExclusionsStorage(storage.local));
    await restarted.ready();
    assert.deepEqual(await restarted.send(request(), sender({ tab: { id: 99 } })), {
        ok: true,
        state: state([category("persisted")], 1),
    });
    assert.deepEqual(storage.local.unrelated, { retained: true });
    assert.deepEqual(
        storage.categoryWrites.map((write) => Object.keys(write)),
        [[KEY]]
    );
    assert.ok(
        storage.allWrites.filter((write) => Object.hasOwn(write.values, KEY)).every((write) => write.area === "local")
    );
});

test("the packaged worker serializes two tabs and same-category add/remove by reception order", async () => {
    const storage = createCategoryExclusionsStorage();
    const worker = createCategoryExclusionsWorker(storage);
    await worker.ready();
    const a = category("a");
    const b = category("b");
    const gate = storage.pauseNext("get");
    const first = worker.send(request({ kind: "add", category: a }), sender({ tab: { id: 1 } }));
    await gate.started;
    const second = worker.send(request({ kind: "add", category: b }), sender({ tab: { id: 2 } }));
    const remove = worker.send(
        request({ kind: "remove", categoryType: "GAME", categoryId: "a" }),
        sender({ tab: { id: 2 } })
    );
    const readd = worker.send(request({ kind: "add", category: a }), sender({ tab: { id: 1 } }));
    assert.equal(storage.categoryReads.length, 1);
    gate.release();
    assert.deepEqual(await first, { ok: true, state: state([a], 1) });
    assert.deepEqual(await second, { ok: true, state: state([a, b], 2) });
    assert.deepEqual(await remove, { ok: true, state: state([b], 3) });
    assert.deepEqual(await readd, { ok: true, state: state([b, a], 4) });
    assert.deepEqual(storage.local[KEY], state([b, a], 4));
});

test("the packaged worker answers only after persistence and recovers from read/write callback errors", async () => {
    const a = category("a");
    const b = category("b");
    const initial = state([a], 4);
    const storage = createCategoryExclusionsStorage({ [KEY]: initial });
    const worker = createCategoryExclusionsWorker(storage);
    await worker.ready();
    const gate = storage.pauseNext("set");
    let finished = false;
    const pending = worker.send(request({ kind: "add", category: b }), sender()).then((response) => {
        finished = true;
        return response;
    });
    await gate.started;
    assert.equal(finished, false);
    assert.deepEqual(storage.local[KEY], initial);
    gate.release();
    assert.deepEqual(await pending, { ok: true, state: state([a, b], 5) });
    for (const operation of ["get", "set"]) {
        const before = copy(storage.local[KEY]);
        const writes = storage.categoryWrites.length;
        storage.failNext(operation);
        assert.deepEqual(
            await worker.send(request({ kind: "remove", categoryType: "GAME", categoryId: "a" }), sender()),
            failure(operation === "get" ? "storage-read-failed" : "storage-write-failed")
        );
        assert.deepEqual(storage.local[KEY], before);
        assert.equal(storage.categoryWrites.length, writes);
        assert.deepEqual(await worker.send(request(), sender()), { ok: true, state: before });
    }
    assert.deepEqual(await worker.send(request({ kind: "remove", categoryType: "GAME", categoryId: "a" }), sender()), {
        ok: true,
        state: state([b], 6),
    });
});

test("the packaged worker preserves corrupted state and rejects untrusted/malformed commands before reads", async () => {
    const corrupt = { version: 2, revision: 7, categories: [category()] };
    const storage = createCategoryExclusionsStorage({ [KEY]: corrupt });
    const worker = createCategoryExclusionsWorker(storage);
    await worker.ready();
    assert.deepEqual(
        await worker.send(request({ kind: "add", category: category("new") }), sender()),
        failure("invalid-stored-state")
    );
    const reads = storage.categoryReads.length;
    assert.deepEqual(await worker.send(request(), sender({ frameId: 1 })), failure("untrusted-sender"));
    assert.deepEqual(
        await worker.send(request(), sender({ url: "https://evil.test/lives" })),
        failure("untrusted-sender")
    );
    assert.deepEqual(
        await worker.send(request({ kind: "replace", categories: [] }), sender()),
        failure("invalid-request")
    );
    assert.equal(storage.categoryReads.length, reads);
    assert.deepEqual(storage.local[KEY], corrupt);
    assert.deepEqual(storage.categoryWrites, []);
});

test("category persistence stays independent of a blocked history writer, guide and live-start queue", async () => {
    for (const queue of ["history", "guide", "live-start"]) {
        const storage = createCategoryExclusionsStorage({
            "betterchzzk:update-guide-state": { schemaVersion: 1, version: "1.4.1", status: "pending" },
        });
        storage.sync.updateGuideEnabled = true;
        const worker = createCategoryExclusionsWorker(storage);
        await worker.ready();
        const key = {
            history: "betterChzzkLiveWatchHistory",
            guide: "betterchzzk:update-guide-state",
            "live-start": "betterchzzk:live-start-channels",
        }[queue];
        const gate = storage.pauseNext("get", key);
        const message = {
            history: {
                type: "betterChzzk:watch-history-mutation",
                version: 1,
                operation: { kind: "clearHistory", cutoffAt: Date.now() },
            },
            guide: {
                type: "betterchzzk:update-guide",
                protocol: 1,
                guideVersion: "1.4.1",
                action: "claim",
                clientId: "category-independence",
            },
            "live-start": {
                type: "betterchzzk:live-start:channels",
                kind: "remove",
                channel: { channelId: "a".repeat(32) },
            },
        }[queue];
        const from = queue === "history" ? sender({ url: storage.chrome.runtime.getURL("history.html") }) : sender();
        const blocked = worker.send(message, from);
        await within(gate.started);
        try {
            assert.deepEqual(await within(worker.send(request({ kind: "add", category: category(queue) }), sender())), {
                ok: true,
                state: state([category(queue)], 1),
            });
        } finally {
            gate.release();
            await blocked;
        }
    }
});
