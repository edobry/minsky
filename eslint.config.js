import js from "@eslint/js";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import noUnderscorePrefixMismatch from "./src/eslint-rules/no-underscore-prefix-mismatch.js";

export default [
  js.configs.recommended,
  {
    ignores: [
      // Exclude codemod scripts from linting
      "codemods/**",
      // Exclude other development/temporary files
      "test-tmp/**",
      "test-analysis/**",
      "test-verification/**",
      // Exclude vendor modules and generated files
      "node_modules/**",
      "build/**",
      "dist/**",
      "vendor/**",
      "*.min.js",
      "*.bundle.js",
      // Exclude generated TypeScript files
      "**/*.d.ts",
      "**/*.js.map",
      "**/*.ts.map",
      // Exclude backup and temporary directories
      ".task-migration-backup/**",
      "session-backups/**",
      "backups/**",
      "*.backup",
      "*.tmp",
    ],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        process: "readonly",
        Buffer: "readonly",
        global: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        globalThis: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        FormData: "readonly",
        Headers: "readonly",
        Request: "readonly",
        Response: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        atob: "readonly",
        btoa: "readonly",
        crypto: "readonly",
        performance: "readonly",
        structuredClone: "readonly",
        jest: "readonly",
        module: "readonly",
        exports: "readonly",
        require: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsEslint,
      import: importPlugin,
      custom: {
        rules: {
          "no-underscore-prefix-mismatch": noUnderscorePrefixMismatch,
        },
      },
    },
    files: ["**/*.ts", "**/*.js"],
    rules: {
      // === CORRECTNESS RULES (KEEP) ===
      "no-throw-literal": "error", // Prevents throwing non-Error objects
      "prefer-promise-reject-errors": "error", // Ensures proper error handling
      "no-useless-catch": "error", // Catches pointless try/catch blocks
      "no-var": "error", // Prevents var hoisting issues
      "prefer-template": "error", // Prevents string concatenation bugs

      // === VARIABLE NAMING RULES ===
      "custom/no-underscore-prefix-mismatch": "error", // Prevents underscore prefix declaration/usage mismatches

      // === STYLE RULES (DISABLED FOR NOW) ===
      "@typescript-eslint/no-explicit-any": "off", // Disabled - style preference
      "@typescript-eslint/no-unused-vars": "off", // Disabled - too noisy
      "no-unused-vars": "off", // Disabled - duplicate of above + too noisy
      "no-magic-numbers": "off", // Disabled - style preference
      "no-console": "off", // Disabled - useful for debugging

      // === TYPESCRIPT SPECIFIC ===
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/ban-types": "off",
      "no-undef": "off", // TypeScript handles this better

      // === FORMATTING (KEEP MINIMAL) ===
      indent: ["error", 2],
      "linebreak-style": ["error", "unix"],
      quotes: ["error", "double"],
      semi: ["error", "always"],

      // === OTHER ===
      "prefer-const": "off",
      "max-lines": "off",
      "no-restricted-globals": "off",
      "import/extensions": "off",
      "import/no-unresolved": ["off", { ignore: [".ts"] }],
      "no-useless-escape": "off",
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      "no-undef": "off", // TypeScript handles this better
    },
  },
  {
    files: ["src/utils/logger.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["**/test/**", "**/*.test.ts", "**/__tests__/**"],
    rules: {
      // Tests can use console and any type freely
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["debug-*.ts", "test-*.ts", "scripts/*.ts"],
    rules: {
      "no-console": "off", // Allow console in debug/test scripts
      "no-magic-numbers": "off", // Allow magic numbers in debug scripts
    },
  },
];
