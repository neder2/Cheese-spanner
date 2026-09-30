const assert = require("node:assert/strict");

async function waitForCondition(
    predicate,
    { timeoutMs = 1000, intervalMs = 20, message = "Timed out waiting for condition" } = {}
) {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt > timeoutMs) assert.fail(message);
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}

module.exports = { waitForCondition };
