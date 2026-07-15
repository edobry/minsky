import js from "@eslint/js";
import tsEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import importPlugin from "eslint-plugin-import";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";
import noNonAsciiIdentifiers from "./eslint-rules/no-non-ascii-identifiers.js";
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
import noDirectServiceConstruction from "./eslint-rules/no-direct-service-construction.js";
import noValidationErrorInExecute from "./eslint-rules/no-validation-error-in-execute.js";
import noDomainSingleton from "./eslint-rules/no-domain-singleton.js";
import requireInjectable from "./eslint-rules/require-injectable.js";
import noSkippedTests from "./eslint-rules/no-skipped-tests.js";
import noUnsafeStringTruncation from "./eslint-rules/no-unsafe-string-truncation.js";
import noEscapeDeployContext from "./eslint-rules/no-escape-deploy-context.js";
import noUnregisteredMinskyEnvVar from "./eslint-rules/no-unregistered-minsky-env-var.js";
import noRawConsole from "./eslint-rules/no-raw-console.js";
import noHandRolledCommandParams from "./eslint-rules/no-hand-rolled-command-params.js";
import noEntityIdParamDrift from "./eslint-rules/no-entity-id-param-drift.js";

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
      "**/dist/**",
      // Generated Slidev talk-deck build snapshot (committed for Railway serving;
      // regenerate via `cd services/site && bun run build:talks`)
      "services/site/public/talks/**",
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
      // Exclude Pulumi-generated SDK and infra build artifacts
      "infra/sdks/**",
      "infra/bin/**",
      "infra/node_modules/**",
      // Exclude ESLint rule test fixtures (intentionally contain rule violations)
      "eslint-rules/__fixtures__/**",
      // Exclude GitHub Actions workflows (YAML files; no ESLint config for them)
      ".github/**",
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
          "no-non-ascii-identifiers": noNonAsciiIdentifiers,
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
          "no-direct-service-construction": noDirectServiceConstruction,
          "no-validation-error-in-execute": noValidationErrorInExecute,
          "no-domain-singleton": noDomainSingleton,
          "require-injectable": requireInjectable,
          "no-skipped-tests": noSkippedTests,
          "no-unsafe-string-truncation": noUnsafeStringTruncation,
          "no-escape-deploy-context": noEscapeDeployContext,
          "no-unregistered-minsky-env-var": noUnregisteredMinskyEnvVar,
          "no-raw-console": noRawConsole,
          "no-hand-rolled-command-params": noHandRolledCommandParams,
          "no-entity-id-param-drift": noEntityIdParamDrift,
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
      "custom/no-non-ascii-identifiers": "error", // Prevents non-ASCII characters in identifier names (enforces ensure-ascii-code-symbols rule)
      "custom/no-underscore-prefix-mismatch": "error", // Prevents underscore prefix declaration/usage mismatches

      // === LOGGING DISCIPLINE (mt#1960) ===
      // Prevents raw `console.*` calls; route through the structured logger.
      // Per-directory excludes live in their own config blocks below.
      "custom/no-raw-console": [
        "error",
        {
          // Allowed-pattern strings — substring match against the call's source text.
          // Mirrors the legacy `scripts/lint-console-usage.ts` allowedPatterns list.
          allowedPatterns: [
            'console.error("Failed to import test monitoring data"',
            'console.warn("⚠️ Failed to load test monitoring data"',
            'console.log("old"',
            'console.log("new"',
            "Mock cleanup for directory",
            '"🔇 Global test setup"',
            '"📊 Loaded existing test monitoring data"',
          ],
        },
      ],

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
      "custom/no-direct-service-construction": [
        "error",
        {
          allowedFiles: [
            // Similarity service factory needs runtime params (model, dimension)
            "**/src/adapters/shared/commands/tasks/similarity-commands.ts",
            // Migration command needs dual task services for source + target
            "**/src/adapters/shared/commands/tasks/migrate-backend-command.ts",
          ],
        },
      ], // Prevent direct construction of domain services in adapter layer (mt#911)
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
            // Constant lookup tables (Set/Map), not stateful service singletons —
            // surfaced by the ADR-026 path-filter fix (mt#2623), which restored
            // this rule's enforcement on packages/domain/src/ post-mt#2108.
            "HOSTED_SAFE_SESSION_COMMANDS",
            "KNOWN_TOP_LEVEL_KEYS",
            "HOOK_ONLY_ENV_VARS",
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
            // Constructed directly via `new X(...)` in production code, never resolved
            // through the tsyringe container — @injectable() would be dead weight.
            // Surfaced by the ADR-026 path-filter fix (mt#2623), which restored this
            // rule's enforcement on packages/domain/src/ post-mt#2108; matches the
            // allowlist already established for the same classes in
            // tests/architecture/di-enforcement.test.ts (mt#2608).
            "AgentTranscriptIngestService",
            "AgentTranscriptService",
          ],
        },
      ], // Require @injectable() on domain Service/Storage/Adapter classes (mt#916)

      // === SURROGATE-SAFE STRING TRUNCATION ===
      // Detects .slice(0,N) / .substring(0,N) on plausibly-string receivers — these
      // may split UTF-16 surrogate pairs (emoji). Use safeTruncate() instead (mt#1615).
      // Known-ASCII paths (SHA prefixes, timestamps) can use eslint-disable-next-line.
      "custom/no-unsafe-string-truncation": [
        "warn",
        {
          allowlist: [], // Per-instance allowlists use eslint-disable-next-line comments
        },
      ],

      // Flags relative imports that escape a separately-deployed package's directory
      // (e.g., `services/reviewer/src/foo.ts` importing `../../../src/utils/x`). Such
      // imports resolve in the monorepo but crash the deployed container whose Docker
      // build context excludes the parent tree. Originating incident: mt#1679.
      //
      // `excludeGlobs` exempts files inside a package root that are NOT runtime-deployed:
      // - `services/*/railway.config.ts`: deploy-config files consumed by scripts/railway/apply.ts
      //   from the host (see services/{reviewer,minsky-mcp}/Dockerfile — neither is COPYed
      //   into the image).
      //
      // Note: services/*/scripts/** is intentionally NOT excluded. Those scripts run from
      // the monorepo (smoke tests, ad-hoc helpers) and could in principle reach across the
      // tree — but rewriting an escaping import to a vendored path is cheap, and forcing
      // every scripts/* file to use the in-package path keeps the codebase consistent. If
      // a script genuinely needs a parent-tree dependency, add it here.
      "custom/no-escape-deploy-context": [
        "error",
        {
          packageRoots: ["services/reviewer", "services/minsky-mcp"],
          excludeGlobs: ["services/*/railway.config.ts"],
        },
      ],

      // mt#1788 — every `process.env.MINSKY_*` read in src/ must be registered
      // in either `environmentMappings` or `HOOK_ONLY_ENV_VARS` to prevent
      // env-var-namespace conflicts with the config-loader's dot-path parser.
      // Closes the ADD side of the same class as mt#1610/mt#1624 (RETIRE side
      // covered by mt#1626 /plan-task gate criterion h).
      "custom/no-unregistered-minsky-env-var": "error",

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
            "**/src/domain/session/drizzle-session-repository.ts",
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
            // Hook entry points (run outside DI container — legitimate bootstrap)
            "**/src/hooks/*.ts",
            // Adapter-layer composition roots (commands wire up DI providers)
            "**/src/adapters/shared/commands/**/*.ts",
            // CLI command composition roots
            "**/src/adapters/cli/**/*.ts",
            // Git subcommand composition roots
            "**/subcommands/*.ts",
            // Cockpit widget composition roots (wire DI providers for the cockpit server)
            "**/src/cockpit/widgets/agents.ts",
            // Cockpit persistence-provider composition root (mt#2615 — lazy-wires
            // session/task/ask providers consumed by every cockpit route module;
            // this was server.ts's job pre-split. server.ts is now composition-only
            // and no longer needs this permission.
            "**/src/cockpit/db-providers.ts",
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
          // Ban node:child_process — use Bun.$ or Bun.spawn instead.
          // Bare "child_process" imports are tracked for future migration (mt#1152).
          // The node: protocol form is the stricter target because new code should
          // never reach for child_process at all; Bun's native APIs are preferred.
          paths: [
            {
              name: "node:child_process",
              message:
                "Use Bun.$ (shell) or Bun.spawn/Bun.spawnSync instead of node:child_process. See bun_over_node.mdc.",
            },
          ],
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
      // Logger implementation legitimately uses console under the hood
      "custom/no-raw-console": "off",
    },
  },
  {
    files: ["**/test/**", "**/*.test.ts", "**/*.test.js", "**/tests/**"],
    rules: {
      // Tests can use console and any type freely
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // Tests run isolated; console output is the canonical test-debug surface
      "custom/no-raw-console": "off",
    },
  },
  {
    files: ["debug-*.ts", "test-*.ts", "scripts/*.ts", "scripts/**/*.ts"],
    rules: {
      "no-console": "off", // Allow console in debug/test scripts
      "no-magic-numbers": "off", // Allow magic numbers in debug scripts
      // Scripts and debug entrypoints legitimately use console for CLI output
      "custom/no-raw-console": "off",
    },
  },
  // === custom/no-raw-console — TSX/JSX coverage parity with legacy script (mt#1960) ===
  // The main config block above only registers rules for `**/*.ts` and `**/*.js`.
  // The retired `scripts/lint-console-usage.ts` script also scanned `**/*.tsx` and
  // `**/*.jsx`, so we add a focused block here that enables ONLY this rule on those
  // file types — without bringing the other 30+ rules into TSX/JSX scope (which would
  // be a scope creep beyond the migration intent).
  {
    files: ["**/*.tsx", "**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      custom: {
        rules: {
          "no-raw-console": noRawConsole,
        },
      },
    },
    rules: {
      "custom/no-raw-console": [
        "error",
        {
          allowedPatterns: [
            'console.error("Failed to import test monitoring data"',
            'console.warn("⚠️ Failed to load test monitoring data"',
            'console.log("old"',
            'console.log("new"',
            "Mock cleanup for directory",
            '"🔇 Global test setup"',
            '"📊 Loaded existing test monitoring data"',
          ],
        },
      ],
      // `js.configs.recommended` (loaded at top of file with no `files` scope)
      // would otherwise apply `no-undef` and `no-unused-vars` to these TSX/JSX
      // files for the first time. TypeScript already covers `no-undef` and the
      // `@typescript-eslint/no-unused-vars` rule (limited to .ts/.js above)
      // covers unused-vars in the rest of the codebase. Keep this block narrow
      // to the `no-raw-console` migration intent.
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
  // === custom/no-raw-console — additional CLI / test-utility excludes (mt#1960) ===
  // Match the legacy `scripts/lint-console-usage.ts` allowlist. These files legitimately
  // emit to stdout (CLI tools, test runners, test utilities, naming-fixer scripts).
  {
    files: [
      "**/test-quality-cli.ts",
      "**/test-runner.ts",
      "**/test-monitor.ts",
      "**/session-test-utilities.ts",
      "**/consolidated-utilities/**",
      "**/*-cli.ts",
      "src/commands/**",
      // Claude Code hooks emit to stdout to inject additionalContext / audit lines.
      // The console-output pattern IS the public interface of a hook, not a debug
      // smell. .minsky/hooks/ is the canonical source (mt#2304); .claude/hooks/
      // is the compiled output. Both share the same console-usage pattern.
      ".claude/hooks/**",
      ".minsky/hooks/**",
      // ESLint rule files themselves use `console.warn` for diagnostic-time messages
      // that the rule emits to the developer (e.g., misconfiguration warnings). The
      // rule runtime is not equivalent to application code — keep the exemption.
      "eslint-rules/*.js",
      // Drizzle config loaders + root-level CLI tools that predate the standardized
      // logger. Treated as scripts.
      "drizzle*.config.ts",
      "*-tool.ts",
      // Reviewer-service operator scripts (smoke tests, replay harnesses,
      // calibration measurements, benchmarks). These are CLI tools whose
      // stdout output IS the operator-visible result — routing through the
      // structured logger would inject JSON metadata into output the
      // operator wants to read directly. The reviewer service's production
      // code path under services/reviewer/src/ uses the local winston
      // logger via `log.*` (mt#1255 + mt#1982); this exemption applies
      // only to the operator-script subdirectory.
      "services/reviewer/scripts/**",
    ],
    rules: {
      "custom/no-raw-console": "off",
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
  // === FILE SIZE RULES — TSX/JSX parity (mt#2592) ===
  // The two `max-lines` blocks above (warn @ 400, error @ 1500) scope only to
  // `**/*.ts` / `**/*.js`, so React components had NO file-size guard at all
  // (src/cockpit/web/pages/PlantFlowPage.tsx grew to 1646 lines invisibly).
  // Mirror both tiers here, narrowly, as their own config objects — do NOT
  // fold `.tsx`/`.jsx` into the big `**/*.ts`/`**/*.js` block above, which
  // would pull 30+ unrelated rules (custom rules, unused-vars, etc.) into
  // TSX/JSX scope as an unintended scope expansion (see mt#2592 spec,
  // "Out of scope: non-size lint rules for .tsx"). Component files run
  // longer than plain TS modules per unit of logic because JSX markup is
  // more line-dense than typical TS syntax; the warn tier is pragmatically
  // set higher than the .ts/.js tier (800 vs 400) so that today's largest
  // properly-scoped cockpit widgets (e.g. Credentials.tsx at 688 lines)
  // don't need individual disables, while still catching genuinely
  // oversized components. The error tier stays at 1500, matching .ts/.js.
  //
  // NOTE on `skipComments`: unlike the `.ts`/`.js` tiers above, both `.tsx`
  // tiers set `skipComments: false`. Two reasons: (1) the codebase's larger
  // cockpit pages/widgets (e.g. PlantFlowPage.tsx) carry substantial
  // architecture-rationale JSDoc headers — skipping comments would let a
  // file's *code* bulk grow arbitrarily while its ESLint-counted size stayed
  // artificially low, defeating the guard's purpose; (2) with
  // `skipComments: true` mirrored exactly, PlantFlowPage.tsx's ESLint-counted
  // line count (~1349, comments/blanks excluded) falls UNDER the 1500 error
  // threshold despite a raw `wc -l` of 1646 — which would make the
  // file-level `eslint-disable max-lines` comment below register as an
  // "Unused eslint-disable directive" (itself a warning, failing the
  // zero-warning `lint:strict` / pre-commit gate). `skipBlankLines: true` is
  // kept since blank lines carry no content either way.
  //
  // NOTE on ESLint flat-config rule merging: because both tiers configure the
  // SAME rule name (`max-lines`) with the SAME `files` glob, ESLint's flat
  // config resolution has the LATER-declared block's rule settings entirely
  // replace the earlier one for any file matching both — there is no
  // independent coexistence of a "warn at 800" and "error at 1500" signal.
  // In practice only the error tier below is ever active. This exactly
  // mirrors the pre-existing (undocumented) behavior of the `.ts`/`.js`
  // blocks above, where the warn-@-400 tier is likewise always superseded by
  // the later error-@-1500 tier. Fixing that pre-existing two-tier-coexistence
  // gap is out of scope for mt#2592 (which only extends coverage to
  // `.tsx`/`.jsx`); the warn tier is kept here for documented intent/parity
  // and in case a future change (e.g. a custom multi-severity rule) makes
  // both tiers independently effective.
  {
    files: ["**/*.tsx", "**/*.jsx"],
    rules: {
      "max-lines": [
        "warn",
        {
          max: 800,
          skipBlankLines: true,
          skipComments: false,
        },
      ],
    },
  },
  {
    files: ["**/*.tsx", "**/*.jsx"],
    rules: {
      "max-lines": [
        "error",
        {
          max: 1500,
          skipBlankLines: true,
          skipComments: false,
        },
      ],
    },
  },
  // === SKIPPED TEST ENFORCEMENT (test files only) ===
  {
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "custom/no-skipped-tests": "error", // Prevent .skip() and .todo() in test files (mt#1151)
    },
  },
  // === MAP-DERIVED COMMAND PARAM TYPES (mt#2779) ===
  // Execute handlers in the shared-command tree must derive their param types
  // from the command's params map (InferParams<typeof map>) — hand-rolled
  // *Params interfaces let handlers read undeclared keys that compile cleanly
  // and are always undefined at runtime (the mt#2742 Detector-B class).
  // Test files are excluded: partial-fixture casts are the legitimate seam.
  {
    files: ["src/adapters/shared/commands/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "custom/no-hand-rolled-command-params": "error",
    },
  },
  // === ENTITY-ID PARAM-NAME DRIFT (mt#2780) ===
  // The mt#2741 Detector-A class: a family map declaring the back-compat
  // alias id-name (`task`) without the family's canonical (`taskId`).
  // COVERAGE IS DECLARED HERE (PR #1933 R1): the globs below enumerate
  // exactly the family directories with confirmed conventions — config, not
  // path heuristics, determines enforcement scope. Adding a family = add its
  // FAMILY_CONVENTIONS entry in eslint-rules/no-entity-id-param-drift.js AND
  // its glob here (both steps; the rule doc in code-style.mdc names this
  // pairing). Directories not listed (memory/, knowledge/, compile/, ...)
  // have no confirmed canonical+alias pair yet and are deliberately out of
  // scope, not silently skipped-by-heuristic.
  {
    files: [
      "src/adapters/shared/commands/tasks/**/*.ts",
      "src/adapters/shared/commands/session/**/*.ts",
    ],
    ignores: ["**/*.test.ts"],
    rules: {
      "custom/no-entity-id-param-drift": "error",
    },
  },
];
