const assert = require("node:assert/strict");
const test = require("node:test");
const { createDom, evalRepoScript } = require("./helpers/extension-page-fixture.js");

// The step base of a number input is its min, so a default off that grid makes arrow keys and spinners
// jump to values the user never typed (60 -> 61 / 51) and leaves the documented maximum unreachable.
test("options number inputs keep each schema default and maximum on the step grid", (t) => {
    const dom = createDom("options.html", "options.html");
    t.after(() => dom.window.close());
    evalRepoScript(dom, "shared", "settings.js");

    const { document, CheeseSpannerSettings } = dom.window;
    const inputs = Array.from(document.querySelectorAll('input[type="number"][data-option]'));
    assert.ok(inputs.length > 0);

    const misaligned = [];
    for (const input of inputs) {
        const key = input.dataset.option;
        const defaultValue = CheeseSpannerSettings.DEFAULT_OPTIONS[key];
        if (!Number.isFinite(defaultValue)) continue;

        input.value = String(defaultValue);
        if (input.validity.stepMismatch) misaligned.push(`${key}: default ${defaultValue} step ${input.step}`);

        const min = Number(input.min);
        const max = Number(input.max);
        const step = Number(input.step || 1);
        if (Number.isFinite(min) && Number.isFinite(max) && step > 0 && ((max - min) / step) % 1 !== 0) {
            misaligned.push(`${key}: max ${max} unreachable from min ${min} with step ${step}`);
        }
    }
    assert.deepEqual(misaligned, []);
});

for (const key of ["monthlyBroadcastTimeMaxCalendarPages", "videoSearchCommentMaxVideos"]) {
    test(`options ${key} arrow steps move from the default without snapping to an off-grid value`, (t) => {
        const dom = createDom("options.html", "options.html");
        t.after(() => dom.window.close());
        evalRepoScript(dom, "shared", "settings.js");

        const { document, CheeseSpannerSettings } = dom.window;
        const input = document.querySelector(`input[data-option="${key}"]`);
        const defaultValue = CheeseSpannerSettings.DEFAULT_OPTIONS[key];
        assert.equal(defaultValue, 60);

        input.value = String(defaultValue);
        input.stepUp();
        const up = Number(input.value);
        input.value = String(defaultValue);
        input.stepDown();
        const down = Number(input.value);

        assert.equal(up - defaultValue, defaultValue - down, "up and down move by the same amount from the default");
        assert.equal((up - Number(input.min)) % Number(input.step), 0);
        input.value = input.max;
        assert.equal(input.validity.stepMismatch, false, "the schema maximum stays selectable");
    });
}
