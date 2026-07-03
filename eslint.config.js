const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: [
            "node_modules/**",
            "coverage/**",
            "dist/**",
            "vendor/**",
            "web-ext-artifacts/**",
            "*.zip",
            "web-ext-config.mjs",
        ],
    },
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
            globals: {
                ...globals.browser,
                ...globals.webextensions,
                ...globals.serviceworker,
                BetterChzzk: "readonly",
                BetterChzzkSettings: "readonly",
                chrome: "readonly",
            },
        },
        rules: {
            "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
            "no-var": "warn",
            "no-unsafe-finally": "warn",
            "prefer-const": "warn",
        },
    },
    {
        files: ["eslint.config.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
    {
        files: ["tests/**/*.js"],
        languageOptions: {
            globals: {
                ...globals.node,
            },
        },
    },
];
