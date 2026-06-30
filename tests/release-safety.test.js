const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");

const runtimeFiles = ["manifest.json", "background.js", "content.js", "history.js", "options.js"];
const runtimeDirs = ["shared", "features"];
const forbiddenPatterns = [
    {
        label: ["PLAYER", "VENDOR", "FALLBACK", "URL"].join("_"),
        pattern: new RegExp(["PLAYER", "VENDOR", "FALLBACK", "URL"].join("_")),
    },
    {
        label: ["import", "Player", "Vendor", "Runtime"].join(""),
        pattern: new RegExp(["import", "Player", "Vendor", "Runtime"].join("")),
    },
    {
        label: "dynamic import",
        pattern: /\bimport\s*\(/,
    },
    {
        label: `src${"doc"}`,
        pattern: new RegExp(`\\bsrc${"doc"}\\b`),
    },
    {
        label: "eval(",
        pattern: /\beval\s*\(/,
    },
    {
        label: ["new", "Function"].join(" "),
        pattern: new RegExp(`\\bnew\\s+${"Function"}\\b`),
    },
];

function collectJsFiles(dir) {
    const absoluteDir = path.join(repoRoot, dir);
    const files = [];

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
        const relativePath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectJsFiles(relativePath));
        } else if (entry.isFile() && entry.name.endsWith(".js")) {
            files.push(relativePath);
        }
    }

    return files;
}

test("runtime files must not contain remote-hosted executable code patterns", () => {
    const files = [...runtimeFiles, ...runtimeDirs.flatMap(collectJsFiles)];
    const violations = [];

    for (const file of files) {
        const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
        for (const { label, pattern } of forbiddenPatterns) {
            if (pattern.test(source)) violations.push(`${file}: ${label}`);
        }
    }

    assert.deepEqual(
        violations,
        [],
        `runtime files must not contain remote-hosted executable code patterns:\n${violations.join("\n")}`
    );
});
