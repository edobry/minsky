import js from "@eslint/js";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import noUnderscorePrefixMismatch from "./src/eslint-rules/no-underscore-prefix-mismatch.js";
import noExcessiveAsUnknown from "./src/eslint-rules/no-excessive-as-unknown.js";
import noUnsafeGitExec from "./src/eslint-rules/no-unsafe-git-exec.js";
import noJestPatterns from "./src/eslint-rules/no-jest-patterns.js";
import noTestsDirectories from "./src/eslint-rules/no-tests-directories.js";
import noRealFsInTests from "./src/eslint-rules/no-real-fs-in-tests.js";
import noGlobalModuleMocks from "./src/eslint-rules/no-global-module-mocks.js";
import noUnreliableFactoryMocks from "./src/eslint-rules/no-unreliable-factory-mocks.js";
import noCliExecutionInTests from "./src/eslint-rules/no-cli-execution-in-tests.js";
import noMagicStringDuplication from "./src/eslint-rules/no-magic-string-duplication.js";

export default [
  js.configs.recommended,
  prettierConfig, // Disables ESLint rules that conflict with Prettier
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
      prettier: prettierPlugin,
      custom: {
        rules: {
          "no-underscore-prefix-mismatch": noUnderscorePrefixMismatch,
          "no-excessive-as-unknown": noExcessiveAsUnknown,
          "no-unsafe-git-exec": noUnsafeGitExec,
          "no-jest-patterns": noJestPatterns,
          "no-tests-directories": noTestsDirectories,
          "no-real-fs-in-tests": noRealFsInTests,
          "no-global-module-mocks": noGlobalModuleMocks,
          "no-unreliable-factory-mocks": noUnreliableFactoryMocks,
          "no-cli-execution-in-tests": noCliExecutionInTests,
          "no-magic-string-duplication": noMagicStringDuplication,
        },
      },
    },
    files: ["**/*.ts", "**/*.js"],
    rules: {
      // === PRETTIER INTEGRATION ===
      "prettier/prettier": "error", // Use Prettier for all formatting

      // === CORRECTNESS RULES (KEEP) ===
      "no-throw-literal": "error", // Prevents throwing non-Error objects
      "prefer-promise-reject-errors": "error", // Ensures proper error handling
      "no-useless-catch": "error", // Catches pointless try/catch blocks
      "no-var": "error", // Prevents var hoisting issues
      "prefer-template": "error", // Prevents string concatenation bugs

      // === VARIABLE NAMING RULES ===
      "custom/no-underscore-prefix-mismatch": "error", // Prevents underscore prefix declaration/usage mismatches

      // === TEST PATTERN ENFORCEMENT ===
      "custom/no-jest-patterns": "error", // Jest migration patterns only
      "custom/no-real-fs-in-tests": [
        "warn", // Warn mode to prevent workflow disruption
        {
          allowedModules: ["mock"], // modules that CAN import fs for mocking
          testPatterns: ["**/*.test.ts", "**/tests/**"], // test file patterns
          strictMode: true, // fails on ANY problematic pattern
          allowTimestamps: false, // whether Date.now() is ever allowed
          allowGlobalCounters: false, // whether global counters are allowed
          allowDynamicImports: false, // whether dynamic imports are allowed
        },
      ], // Filesystem interference prevention
      "custom/no-global-module-mocks": [
        "warn",
        {
          allowInFiles: [
            "**/tests/setup.ts",                      // Global test setup  
            "**/tests/adapters/cli/session*.test.ts"  // Session CLI tests with global mocks
          ],
        },
      ], // Prevent cross-test interference from global mocking
      "custom/no-unreliable-factory-mocks": "warn", // Prevent race conditions from async factory patterns
      "custom/no-cli-execution-in-tests": "warn", // Warn about architectural violations
      "custom/no-magic-string-duplication": [
        "warn", // Warn mode to encourage but not block
        {
          minLength: 15,
          minOccurrences: 3,
          skipPatterns: [], // Use defaults
        },
      ], // Encourage extraction of duplicated strings

      // === TEST ORGANIZATION ===
      "custom/no-tests-directories": "warn", // Encourage co-located test files over __tests__ directories

      // === GIT OPERATION SAFETY ===
      "custom/no-unsafe-git-exec": [
        "error",
        {
          allowInTests: false,
          allowedLocalOperations: [],
        },
      ], // Prevents ALL git operations without timeout protection - enhanced after task #301 audit
      // === TYPE SAFETY RULES ===
      "custom/no-excessive-as-unknown": [
        "warn",
        {
          allowInTests: true,
          allowedPatterns: [
            // Allow specific patterns that are legitimate
            "process\\.env\\[.*\\] as unknown",
            "import\\(.*\\) as unknown",
            // Add more patterns as needed
          ],
        },
      ],

      // === FILE SIZE RULES ===
      "max-lines": [
        "warn",
        {
          max: 400,
          skipBlankLines: true,
          skipComments: true,
        },
      ],

      // === IMPORT RULES ===
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "*/*.js",
                "./*.js",
                "../*.js",
                "../../*.js",
                "../../../*.js",
                "../../../../*.js",
              ],
              message:
                "Use extensionless imports for local files (Bun-native style). Remove .js extension.",
            },
            {
              group: [
                "*/*.ts",
                "./*.ts",
                "../*.ts",
                "../../*.ts",
                "../../../*.ts",
                "../../../../*.ts",
              ],
              message:
                "Use extensionless imports for local files (Bun-native style). Remove .ts extension.",
            },
            {
              group: [
                "*/*.jsx",
                "./*.jsx",
                "../*.jsx",
                "../../*.jsx",
                "../../..//*.jsx",
                "../../../../*.jsx",
              ],
              message:
                "Use extensionless imports for local files (Bun-native style). Remove .jsx extension.",
            },
            {
              group: [
                "*/*.tsx",
                "./*.tsx",
                "../*.tsx",
                "../..//*.tsx",
                "../../../*.tsx",
                "../../../../*.tsx",
              ],
              message:
                "Use extensionless imports for local files (Bun-native style). Remove .tsx extension.",
            },
            {
              group: [
                "*/*.mjs",
                "./*.mjs",
                "../*.mjs",
                "../../*.mjs",
                "../../../*.mjs",
                "../../../../*.mjs",
              ],
              message:
                "Use extensionless imports for local files (Bun-native style). Remove .mjs extension.",
            },
            {
              group: [
                "*/*.cjs",
                "./*.cjs",
                "../*.cjs",
                "../../*.cjs",
                "../../../*.cjs",
                "../../../../*.cjs",
              ],
              message:
                "Use extensionless imports for local files (Bun-native style). Remove .cjs extension.",
            },
          ],
        },
      ],

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

      // === FORMATTING (REMOVED - LET PRETTIER HANDLE) ===
      // Removed: indent, linebreak-style, quotes, semi - Prettier handles these

      // === OTHER ===
      "prefer-const": "off",
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
    files: ["**/test/**", "**/*.test.ts", "**/tests/**"],
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
  // Add a second max-lines rule for error at 1500 lines
  {
    files: ["**/*.ts", "**/*.js"],
    rules: {
      "max-lines": [
        "error",
        {
          max: 1500,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
  },
];
