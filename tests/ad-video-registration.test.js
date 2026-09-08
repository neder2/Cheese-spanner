const assert = require("node:assert/strict");
const test = require("node:test");
require("../shared/adVideoRegistration.js");
const { CONTENT_SCRIPT, createController } = globalThis.BetterChzzkAdVideoRegistration;

function createRegistration(enabled = false) {
    let desired = enabled;
    let scripts = [];
    const mutations = [];
    let beforeRegister = async () => {};
    const controller = createController({
        readEnabled: async () => desired,
        scripting: {
            async getRegisteredContentScripts({ ids }) {
                assert.deepEqual(ids, [CONTENT_SCRIPT.id]);
                return scripts;
            },
            async registerContentScripts(values) {
                await beforeRegister();
                mutations.push("register");
                scripts = structuredClone(values);
            },
            async updateContentScripts(values) {
                mutations.push("update");
                scripts = structuredClone(values);
            },
            async unregisterContentScripts({ ids }) {
                assert.deepEqual(ids, [CONTENT_SCRIPT.id]);
                mutations.push("unregister");
                scripts = [];
            },
        },
    });
    return {
        controller,
        mutations,
        get scripts() {
            return scripts;
        },
        setEnabled(value) {
            desired = value;
        },
        setBeforeRegister(fn) {
            beforeRegister = fn;
        },
        setScripts(values) {
            scripts = values;
        },
    };
}

test("registration is off by default and only injects the packaged MAIN script at document_start", async () => {
    const state = createRegistration();
    await state.controller.reconcile();
    assert.deepEqual(state.mutations, []);
    state.setEnabled(true);
    await state.controller.reconcile();
    assert.deepEqual(state.scripts, [CONTENT_SCRIPT]);
    assert.deepEqual(CONTENT_SCRIPT.js, ["features/adVideoPage.js"]);
    assert.deepEqual(CONTENT_SCRIPT.matches, ["https://chzzk.naver.com/*"]);
    assert.equal(CONTENT_SCRIPT.world, "MAIN");
    assert.equal(CONTENT_SCRIPT.runAt, "document_start");
    assert.equal(CONTENT_SCRIPT.allFrames, false);
    assert.equal(CONTENT_SCRIPT.persistAcrossSessions, true);
    await state.controller.reconcile();
    assert.deepEqual(state.mutations, ["register"]);
    state.setEnabled(false);
    await state.controller.reconcile();
    assert.deepEqual(state.mutations, ["register", "unregister"]);
});

test("rapid setting changes during registration converge to the last saved value", async () => {
    const state = createRegistration(true);
    let release;
    let entered;
    const entering = new Promise((resolve) => (entered = resolve));
    state.setBeforeRegister(async () => {
        entered();
        await new Promise((resolve) => (release = resolve));
    });
    const first = state.controller.reconcile();
    await entering;
    state.setEnabled(false);
    state.controller.reconcile();
    state.setEnabled(true);
    state.controller.reconcile();
    state.setEnabled(false);
    const last = state.controller.reconcile();
    release();
    await Promise.all([first, last]);
    assert.deepEqual(state.scripts, []);
    assert.deepEqual(state.mutations, ["register", "unregister"]);
});

test("startup removes a stale registration, updates old descriptors, and recovers after an API failure", async () => {
    const state = createRegistration();
    state.setScripts([{ ...CONTENT_SCRIPT }]);
    await state.controller.reconcile();
    assert.deepEqual(state.scripts, []);
    state.setEnabled(true);
    state.setScripts([{ ...CONTENT_SCRIPT, runAt: "document_idle" }]);
    await state.controller.reconcile();
    assert.equal(state.scripts[0].runAt, "document_start");
    state.setScripts([]);
    state.setBeforeRegister(async () => {
        throw new Error("registration failed");
    });
    await assert.rejects(state.controller.reconcile(), /registration failed/);
    state.setBeforeRegister(async () => {});
    await state.controller.reconcile();
    assert.deepEqual(state.scripts, [CONTENT_SCRIPT]);
});

test("stale CSS, exclusion rules, and related-frame injection are removed with the owned registration", async () => {
    for (const extra of [
        { css: ["legacy-ad.css"] },
        { excludeMatches: ["https://chzzk.naver.com/live/*"] },
        { matchOriginAsFallback: true },
    ]) {
        const state = createRegistration(true);
        state.setScripts([{ ...CONTENT_SCRIPT, ...extra }]);
        await state.controller.reconcile();
        assert.deepEqual(state.scripts, [CONTENT_SCRIPT]);
        assert.deepEqual(state.mutations, ["unregister", "register"]);
    }
});
