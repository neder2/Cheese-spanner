const test = require("node:test");
const assert = require("node:assert/strict");
const {
    createCategoryExclusionsWorker,
    createCategoryExclusionsStorage,
} = require("./helpers/category-exclusions-worker");

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const key = "cheese-spanner:live-multiview-preset:v1";
const list = (id) => [{ id, name: "방송" }];
const sender = {
    id: "category-test-extension",
    frameId: 0,
    url: "https://chzzk.naver.com/",
    tab: { id: 1, url: "https://chzzk.naver.com/live/" + A },
};
const message = (action, extra = {}) => ({ type: "cheese-spanner:live-multiview-preset", action, route: A, ...extra });

test("the preset writer serializes competing profile edits and never overwrites an unreadable list", async () => {
    const storage = createCategoryExclusionsStorage();
    const worker = createCategoryExclusionsWorker(storage);
    const send = (action, extra, user = sender) => worker.send(message(action, extra), user);
    assert.deepEqual(await send("list"), { ok: true, saved: null });
    assert.deepEqual(await send("save", { expected: null, channels: list(A) }), { ok: true, saved: list(A) });
    const [first, second] = await Promise.all([
        send("save", { expected: list(A), channels: list(B) }),
        send("save", { expected: list(A), channels: list(C) }, { ...sender, tab: { ...sender.tab, id: 2 } }),
    ]);
    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, conflict: true });
    assert.deepEqual(await send("delete", { expected: list(A) }), { ok: false, conflict: true });
    storage.failNext("set", "callback", key);
    assert.equal((await send("save", { expected: list(B), channels: list(C) })).ok, false);
    assert.deepEqual((await send("list")).saved, list(B));
    assert.equal((await send("delete", { expected: list(B) })).ok, true);
    assert.deepEqual((await send("list")).saved, null);
    const corrupt = createCategoryExclusionsWorker(createCategoryExclusionsStorage({ [key]: { broken: true } }));
    assert.deepEqual(await corrupt.send(message("save", { expected: null, channels: list(A) }), sender), { ok: false });
});
test("profile preset accepts only the active normal live tab and a compact, bounded channel list", async () => {
    const w = createCategoryExclusionsWorker();
    const valid = message("save", { expected: null, channels: list(A) });
    for (const rejected of [
        { ...sender, tab: { ...sender.tab, incognito: true } },
        { ...sender, frameId: 1 },
        { ...sender, tab: { ...sender.tab, url: "https://chzzk.naver.com/live/" + B } },
    ])
        assert.deepEqual(await w.send(valid, rejected), { ok: false });
    for (const channels of [
        [],
        [...list(A), ...list(A)],
        Array.from("abcdef0", (c) => ({ id: c.repeat(32), name: "" })),
        [{ id: "bad", name: "" }],
        [{ id: A, name: "", volume: 0.3 }],
        [{ id: A, name: "x".repeat(170) }],
    ])
        assert.deepEqual(await w.send({ ...valid, channels }, sender), { ok: false });
    for (const extra of [
        { ...valid, autoPlay: true },
        { ...valid, action: "other" },
        message("list", { expected: null }),
        message("delete", { expected: list(A), channels: list(B) }),
        { type: valid.type, action: "save", route: A, channels: list(A) },
    ])
        assert.deepEqual(await w.send(extra, sender), { ok: false });
    assert.deepEqual(await w.send(message("list"), sender), { ok: true, saved: null });
});
