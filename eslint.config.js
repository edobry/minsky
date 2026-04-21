import js from "@eslint/js";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import noUnderscorePrefixMismatch from "./eslint-rules/no-underscore-prefix-mismatch.js";
import noExcessiveAsUnknown from "./eslint-rules/no-excessive-as-unknown.js";
import noUnsafeGitExec from "./eslint-rules/no-unsafe-git-exec.js";
import noJestPatterns from "./eslint-rules/no-jest-patterns.js";
import noTestsDirectories from "./eslint-rules/no-tests-directories.js";
import noRealFsInTests from "./eslint-rules/no-real-fs-in-tests.js";
import noGlobalModuleMocks from "./eslint-rules/no-global-module-mocks.js";
import noUnreliableFactoryMocks from "./eslint-rules/no-unreliable-factory-mocks.js";
import noCliExecutionInTests from "./eslint-rules/no-cli-execution-in-tests.js";
import noMagicStringDuplication from "./eslint-rules/no-magic-string-duplication.js";
import noUnwaitedAsyncFactory from "./eslint-rules/no-unwaited-async-factory.js";
import noSingletonReachIn from "./eslint-rules/no-singleton-reach-in.js";
import noFromParamsInAdapters from "./eslint-rules/no-from-params-in-adapters.js";
import noIgnoredCommandContext from "./eslint-rules/no-ignored-command-context.js";
import noValidationErrorInExecute from "./eslint-rules/no-validation-error-in-execute.js";
import noDomainSingleton from "./eslint-rules/no-domain-singleton.js";
import requireInjectable from "./eslint-rules/require-injectable.js";

export default [
  js.configs.recommended,
  prettierConfig, // Disables ESLint rules that conflict with Prettier
  {
    ignores: [
      // Exclude ESLint rule test fixtures (they intentionally violate rules)
      "eslint-rules/__fixtures__/**",
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
      // Exclude Claude Code agent worktrees
      ".claude/worktrees/**",
      // Exclude ESLint rule test fixtures (intentionally contain rule violations)
      "eslint-rules/__fixtures__/**",
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
          "no-unwaited-async-factory": noUnwaitedAsyncFactory,
          "no-singleton-reach-in": noSingletonReachIn,
          "no-from-params-in-adapters": noFromParamsInAdapters,
          "no-ignored-command-context": noIgnoredCommandContext,
          "no-validation-error-in-execute": noValidationErrorInExecute,
          "no-domain-singleton": noDomainSingleton,
          "require-injectable": requireInjectable,
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
        "error",
        {
          allowInFiles: [
            "**/tests/setup.ts", // Global test setup only
          ],
        },
      ], // Ban mock.module() — use dependency injection instead
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

      // === ASYNC SAFETY ===
      "custom/no-unwaited-async-factory": [
        "error",
        {
          asyncFactoryFunctions: ["createSessionProvider"],
        },
      ], // Prevent unwaited async factory calls that silently assign Promises

      // === DI ENFORCEMENT ===
      "custom/no-from-params-in-adapters": "error", // Prevent ad-hoc provider creation in adapter layer (mt#788)
      "custom/no-ignored-command-context": "error", // Flags commands with DI-requiring params (session) that ignore context (mt#929)
      "custom/no-validation-error-in-execute": "error", // ADR-004: ValidationError belongs in validate(), not execute()
      "custom/no-domain-singleton": [
        "error",
        {
          allowedNames: [
            "ruleOperationRegistry",
            "gitOperationRegistry",
            "modularGitCommandsManager",
            "defaultLoader",
            "legacyConfig",
            "log",
            "EXEMPT_COMMANDS",
            "testConfigManager",
          ],
        },
      ], // Prevent singleton exports in domain code — use @injectable() and the DI container (mt#916)
      "custom/require-injectable": [
        "error",
        {
          allowedClasses: [
            "FakeGitService",
            "FakeTaskService",
            "MemoryVectorStorage",
            "SqliteStorage",
            "SessionMigrationService",
            "StorageError",
            "StorageErrorClassifier",
            "StorageErrorRecovery",
            "StorageErrorMonitor",
          ],
        },
      ], // Require @injectable() on domain Service/Storage/Adapter classes (mt#916)

      // === SINGLETON ARCHITECTURE ===
      "custom/no-singleton-reach-in": [
        "warn",
        {
          allowedFiles: [
            // PersistenceService composition roots
            "**/src/domain/persistence/service.ts",
            "**/src/domain/persistence/validation-operations.ts",
            // Session provider composition roots
            "**/src/domain/session/session-service.ts",
            "**/src/domain/session/session-provider-cache.ts",
            "**/src/domain/session/session-db-adapter.ts",
            // Session path resolver (lazy fallback for MCP handlers without DI context)
            "**/src/domain/session/session-path-resolver.ts",
            // Domain-level facade files that re-export/wire providers
            "**/src/domain/session.ts",
            "**/src/domain/git.ts",
            // Git operations base class (lazy fallback for session resolution)
            "**/src/domain/git/operations/base-git-operation.ts",
            // Storage backends that need direct provider access
            "**/src/domain/storage/backends/postgres-storage.ts",
            "**/src/domain/storage/vector/vector-storage-factory.ts",
            "**/src/domain/storage/vector/postgres-vector-storage.ts",
            // Task domain composition roots
            "**/src/domain/tasks/tasks-importer-service.ts",
            "**/src/domain/tasks/taskService.ts",
            "**/src/domain/tasks/github-issues-api.ts",
            // Rules domain
            "**/src/domain/rules/rule-similarity-service.ts",
            // Changeset adapters (resolve session provider for PR operations)
            "**/src/domain/changeset/adapters/*.ts",
            // Session domain (command orchestration and provider resolution)
            "**/src/domain/tasks/operations/base-task-operation.ts",
            "**/src/domain/tasks/taskCommands.ts",
            "**/src/domain/tasks/commands/shared-helpers.ts",
            // DI composition roots (the canonical place for singleton resolution)
            "**/src/composition/**/*.ts",
            // Adapter-layer composition roots (commands wire up DI providers)
            "**/src/adapters/shared/commands/**/*.ts",
            // CLI command composition roots
            "**/src/adapters/cli/**/*.ts",
            // Git subcommand composition roots
            "**/subcommands/*.ts",
            // Scripts and one-off tools (composition roots by nature)
            "**/scripts/*.ts",
            "**/debug-*.ts",
            "**/test-*.ts",
            "**/dependency-backfill-tool.ts",
            // ESLint rule files (the rules themselves reference these identifiers as strings)
            "**/eslint-rules/**",
          ],
        },
      ], // Prevent singleton reach-in from non-composition-root files

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

      // === TYPE SAFETY RATCHET ===
      // Baseline: ~851 production warnings (2026-04-01). Goal: ratchet to 0, then promote to "error".
      // Test files are exempt (see test override below).
      // New `as any` or `: any` in production code will show as warnings in lint output
      // and will be caught by CI once we add a "max warnings" threshold.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          vars: "all",
          args: "none",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          caughtErrors: "none",
        },
      ],
      "no-unused-vars": "off", // Disabled - @typescript-eslint/no-unused-vars handles this
      "no-magic-numbers": "off", // Disabled - style preference
      "no-console": "off", // Disabled - useful for debugging

      // === TYPESCRIPT SPECIFIC ===
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/ban-types": "off",
      "no-undef": "off", // TypeScript handles this better

      // === FORMATTING (REMOVED - LET PRETTIER HANDLE) ===
      // Removed: indent, linebreak-style, quotes, semi - Prettier handles these

      // === OTHER ===
      "prefer-const": "error",
      "no-restricted-globals": "off",
      "import/extensions": "off",
      "import/no-unresolved": ["off", { ignore: [".ts"] }],
      "no-useless-escape": "error",
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
