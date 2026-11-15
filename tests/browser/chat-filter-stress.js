// Opt-in real-browser reproduction. Requires an existing Playwright installation and Chromium executable.
/* global withOptionsStorageLock */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { createHash } = require("node:crypto");
const { values } = parseArgs({
    options: {
        playwright: { type: "string", default: "playwright-core" },
        browser: { type: "string" },
        output: { type: "string", default: "output/playwright/chat-filter-stress" },
        smoke: { type: "boolean", default: false },
        interactive: { type: "boolean", default: false },
        "controls-test": { type: "boolean", default: false },
        "bulk-input": { type: "boolean", default: false },
    },
});
const { chromium } = require(values.playwright);
const workspace = path.resolve(__dirname, "../..");
const output = path.resolve(workspace, values.output);
fs.mkdirSync(output, { recursive: true });
const read = (name) => fs.readFileSync(path.join(workspace, name), "utf8");
const report = {
    scope: "Temporary Chrome with the actual unpacked extension; synthetic chat DOM and native-list state, no live-server chat transmission",
    inputMode: values["bulk-input"] ? "bulk-before-native-slice" : "streamed-dom-arrivals",
    sourceSha256: Object.fromEntries(
        [
            "features/chatTools.js",
            "features/chatTools/parser.js",
            "features/chatTools/messageStore.js",
            "features/chatTools/panel.js",
            "features/chatTools/listLayoutPage.js",
        ].map((name) => [name, createHash("sha256").update(read(name)).digest("hex")])
    ),
    cases: [],
    failures: [],
    pageErrors: [],
};
const fixtureHtml = read("tests/fixtures/chat-filter-stress.html");
const fixtureJs = read("tests/fixtures/chat-filter-stress.js");
const routePaths = {
    live: "/live/ffffffffffffffffffffffffffffffff",
    popup: "/live/ffffffffffffffffffffffffffffffff/chat",
    vod: "/video/999999999",
};
const roles = ["broadcaster", "manager", "partner", "challenger"];
const bulkPlans = [
    { name: "500", batchSize: 10, intervalMs: 20, total: 1500 },
    { name: "2000", batchSize: 40, intervalMs: 20, total: 4000 },
    { name: "5000", batchSize: 100, intervalMs: 20, total: 6000 },
];
// Preserve the original large-burst probe separately. Streamed arrivals use the same target rate but
// keep each commit smaller than the native window, so the target really reaches the DOM observer.
const plans = values["bulk-input"]
    ? bulkPlans
    : bulkPlans.map((plan) => ({
          ...plan,
          batchSize: 10,
          intervalMs: (plan.intervalMs * 10) / plan.batchSize,
      }));

function assertMixedVisibility(result) {
    assert.ok(result.normalSent > 0 && result.blockedSent > 0, "both ordinary and matching chat must be injected");
    assert.ok(result.normalVisibleRows > 0, "ordinary nonmatching chat must actually remain visible");
    assert.equal(result.blockedExposedFrames, 0, "matching ordinary chat must be hidden before a sampled frame");
    assert.equal(result.normalHiddenFrames, 0, "ordinary nonmatching chat must not be hidden");
    assert.equal(result.normalFilterWrites, 0, "ordinary nonmatching chat must never receive the filter marker");
}

(async () => {
    const profile = fs.mkdtempSync(path.join(output, "profile-"));
    const context = await chromium.launchPersistentContext(profile, {
        executablePath: values.browser,
        headless: !values.interactive,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
            `--disable-extensions-except=${workspace}`,
            `--load-extension=${workspace}`,
            ...(values.interactive ? ["--start-maximized"] : []),
        ],
        locale: "ko-KR",
        viewport: values.interactive ? null : { width: 1440, height: 1080 },
    });
    try {
        const worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker", { timeout: 15000 }));
        report.browser = context.browser().version();
        report.extension = await worker.evaluate(() => ({
            id: chrome.runtime.id,
            version: chrome.runtime.getManifest().version,
        }));
        await worker.evaluate(async () => {
            const disabled = Object.fromEntries(CheeseSpannerSettings.FEATURE_KEYS.map((key) => [key, false]));
            await withOptionsStorageLock(() =>
                chrome.storage.sync.set({
                    ...disabled,
                    chatKeywordFilterEnabled: true,
                    chatKeywordFilterWords: "숨김검증",
                    chatKeywordFilterApplyMode: "global",
                    chatKeywordFilterMatchMode: "contains",
                    chatToolsModeratorBoxEnabled: true,
                    chatToolsMaxModeratorMessages: 100,
                })
            );
        });
        const page = await context.newPage();
        page.on("pageerror", (error) => report.pageErrors.push(error.message));
        await page.route("https://chzzk.naver.com/**", (route) => {
            const script = new URL(route.request().url()).pathname === "/__cheese-spanner-stress-fixture.js";
            return route.fulfill({
                contentType: script ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
                body: values.interactive
                    ? read(script ? "tests/fixtures/chat-filter-stress.js" : "tests/fixtures/chat-filter-stress.html")
                    : script
                      ? fixtureJs
                      : fixtureHtml,
            });
        });
        if (values.interactive) {
            await page.goto(`https://chzzk.naver.com${routePaths.live}`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => !document.getElementById("start-chat")?.disabled, null, {
                timeout: 25000,
            });
            await page.bringToFront();
            await page.screenshot({ path: path.join(output, "interactive-ready.png"), fullPage: true });
            fs.writeFileSync(
                path.join(output, "interactive-ready.json"),
                JSON.stringify(
                    {
                        browser: report.browser,
                        extension: report.extension,
                        url: page.url(),
                        pid: process.pid,
                        title: await page.title(),
                        startButtonEnabled: await page.locator("#start-chat").isEnabled(),
                    },
                    null,
                    2
                )
            );
            console.log("Interactive chat reproduction is ready. Close its Chrome window to finish.");
            await new Promise((resolve) => context.once("close", resolve));
            return;
        }
        const run = async (mode, role, plan, extra = {}) => {
            await page.goto(`https://chzzk.naver.com${routePaths[mode]}`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => window.CheeseSpannerChatStress?.ready(), null, { timeout: 15000 });
            if (extra.negativeControl) {
                await worker.evaluate(async () =>
                    withOptionsStorageLock(() => chrome.storage.sync.set({ chatKeywordFilterEnabled: false }))
                );
                await page.waitForSelector("#cheese-spanner-chat-keyword-filter-style", { state: "detached" });
            }
            const result = await page.evaluate((config) => window.CheeseSpannerChatStress.run(config), {
                ...plan,
                role,
                ...extra,
            });
            result.mode = mode;
            report.cases.push(result);
            fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
            console.log(JSON.stringify(result));
            try {
                if (extra.negativeControl) {
                    assert.ok(result.blockedExposedFrames > 0, "control must detect visible matching ordinary chat");
                } else {
                    assertMixedVisibility(result);
                    if (!values["bulk-input"])
                        assert.equal(
                            result.mountedMessages,
                            result.total,
                            "every streamed message must actually reach the DOM"
                        );
                    assert.equal(
                        result.targetHiddenFrames,
                        0,
                        "the collection target must remain visible while mounted"
                    );
                    assert.equal(result.targetFilterWrites, 0, "the target must never receive the filter marker");
                    assert.ok(
                        result.targetMounted && result.targetVisibleFrames > 0,
                        "the target must actually be displayed during the stream"
                    );
                    assert.equal(
                        result.targetCopies,
                        mode === "vod" ? 0 : 1,
                        "live collection must keep exactly the injected target"
                    );
                    assert.equal(result.unexpectedCollected, 0, "ordinary messages must not be collected");
                }
            } catch (error) {
                report.failures.push({ mode, role, rate: result.nominalPerSecond, message: error.message });
            }
            if (extra.negativeControl) {
                await worker.evaluate(async () =>
                    withOptionsStorageLock(() => chrome.storage.sync.set({ chatKeywordFilterEnabled: true }))
                );
            }
            return result;
        };
        if (values["controls-test"]) {
            await page.goto(`https://chzzk.naver.com${routePaths.live}`, { waitUntil: "domcontentloaded" });
            await page.waitForFunction(() => !document.getElementById("start-chat")?.disabled, null, {
                timeout: 25000,
            });
            await page.locator("#chat-speed").selectOption("100");
            await page.locator("#start-chat").click();
            await page.waitForFunction(() => window.CheeseSpannerChatStress?.lastResult, null, { timeout: 20000 });
            const first = await page.evaluate(() => window.CheeseSpannerChatStress.lastResult);
            assert.equal(first.total, 800);
            assert.equal(first.stopped, false);
            assert.equal(first.targetCopies, 1);
            assert.equal(first.targetHiddenFrames, 0);
            assertMixedVisibility(first);
            assert.equal(await page.locator(".bcct-moderator-trigger").getAttribute("aria-expanded"), "true");
            assert.equal(await page.locator("#start-chat").isEnabled(), true);
            assert.equal(await page.locator("#stop-chat").isDisabled(), true);
            await page.screenshot({ path: path.join(output, "controls-complete.png"), fullPage: true });
            await page.locator("#chat-speed").selectOption("5000");
            await page.locator("#start-chat").click();
            await page.waitForFunction(
                () =>
                    window.CheeseSpannerChatStress?.running &&
                    Number(document.getElementById("sent").textContent.replace(/\D/g, "")) >= 200,
                null,
                { timeout: 20000 }
            );
            assert.equal(await page.locator("#start-chat").isDisabled(), true);
            await page.locator("#stop-chat").click();
            await page.waitForFunction(() => window.CheeseSpannerChatStress?.lastResult?.stopped, null, {
                timeout: 10000,
            });
            const stopped = await page.evaluate(() => window.CheeseSpannerChatStress.lastResult);
            assert.ok(stopped.total > 0 && stopped.total < stopped.plannedTotal);
            assertMixedVisibility(stopped);
            await page.locator("#chat-speed").selectOption("100");
            await page.locator("#target-role").selectOption("partner");
            await page.locator("#start-chat").click();
            await page.waitForFunction(() => window.CheeseSpannerChatStress?.lastResult?.role === "partner", null, {
                timeout: 25000,
            });
            const replay = await page.evaluate(() => window.CheeseSpannerChatStress.lastResult);
            assert.equal(replay.total, 800);
            assert.equal(replay.targetCopies, 1);
            assert.equal(replay.unexpectedCollected, 0);
            assertMixedVisibility(replay);
            assert.equal(replay.targetHiddenFrames, 0);
            assert.equal(await page.locator("#target-role").inputValue(), "partner");
            report.controls = { first, stopped, replay };
            console.log(JSON.stringify({ controls: report.controls }));
        } else if (values.smoke) {
            await run("live", "manager", plans[2]);
        } else {
            for (const plan of plans) for (const role of roles) await run("live", role, plan);
            for (const mode of ["popup", "vod"]) for (const role of roles) await run(mode, role, plans[2]);
            await run("live", "manager", { batchSize: 20, intervalMs: 20, total: 200 }, { negativeControl: true });
            await run("live", "manager", { batchSize: 10, intervalMs: 20, total: 600 });
            const trigger = page.locator(".bcct-moderator-trigger");
            if (await trigger.count()) await trigger.click();
            await page.screenshot({ path: path.join(output, "mixed-chat-result.png"), fullPage: true });
        }
        assert.equal(report.pageErrors.length, 0, "the browser must not report page errors");
        assert.equal(report.failures.length, 0, JSON.stringify(report.failures));
    } finally {
        fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
        await context.close();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
