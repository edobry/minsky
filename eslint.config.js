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
import noRawColorsInCockpit from "./eslint-rules/no-raw-colors-in-cockpit.js";
import requireHookDomainBootstrap from "./eslint-rules/require-hook-domain-bootstrap.js";
import requireGuardOutcomeInFireLog from "./eslint-rules/require-guard-outcome-in-fire-log.js";
import noNodeImportInCockpitWeb from "./eslint-rules/no-node-import-in-cockpit-web.js";
import requireRegisteredCockpitLoop from "./eslint-rules/require-registered-cockpit-loop.js";
import noSilentCatch from "./eslint-rules/no-silent-catch.js";
import preferLoggableErrorSummary from "./eslint-rules/prefer-loggable-error-summary.js";
import requireSubprocessNetworkTimeout from "./eslint-rules/require-subprocess-network-timeout.js";
import noSpyPatching from "./eslint-rules/no-spy-patching.js";

// === RAW COLOR ENFORCEMENT IN COCKPIT (mt#2916) — declared coverage ===
// The blessed healthy/warning raw-Tailwind-palette exception from
// docs/design-system.md §5.2: files that render a per-status healthy/warning
// indicator (green/emerald for healthy, amber for warning) via raw Tailwind
// palette classes rather than a dedicated success/warning design token.
// Adding a widget here is a design decision (a new status-indicator surface
// adopting the blessed pattern), not a lint-config tweak — cite
// docs/design-system.md §5.2 when extending this list.
const COCKPIT_STATUS_FILES = [
  "src/cockpit/web/widgets/Agents.tsx",
  "src/cockpit/web/widgets/ConversationSearchPanel.tsx",
  "src/cockpit/web/components/DrivenSessionStatusBar.tsx",
  "src/cockpit/web/widgets/Credentials.tsx",
  "src/cockpit/web/widgets/EmbeddingsHealth.tsx",
  "src/cockpit/web/pages/EmbeddingsPage.tsx",
  "src/cockpit/web/widgets/McpServerStatus.tsx",
  "src/cockpit/web/widgets/MemoriesHealth.tsx",
  "src/cockpit/web/widgets/MemoriesList.tsx",
  "src/cockpit/web/widgets/MemoryDetail.tsx",
  "src/cockpit/web/widgets/MemorySearch.tsx",
  "src/cockpit/web/widgets/MemoryStats.tsx",
  "src/cockpit/web/widgets/ReviewerBotStatus.tsx",
  "src/cockpit/web/widgets/RunDetail.tsx",
];

// File-level exceptions (docs/design-system.md §5.2: "any file-level
// exceptions with recorded justification"): raw-Tailwind-palette usage that
// is deliberate, pre-existing, and does not fit the healthy/warning pattern.
// Every hue is permitted in these files, but hex literals are NEVER exempt —
// the rule checks hex unconditionally regardless of this list (PR #2045
// review R1: an earlier draft disabled the rule entirely via config for
// these files, which would have silently let hex slip through here too).
const COCKPIT_PALETTE_EXEMPT_FILES = [
  // JSON syntax highlighter — 7+ distinct hues distinguish token types
  // (string/number/boolean/key/punctuation/etc.), not a health-status
  // indicator. A semantic replacement would need a new multi-hue token set,
  // outside brand-system.md's "one accent, two warning tiers, one pastel"
  // budget.
  "src/cockpit/web/components/JsonView.tsx",
  // Subagent-spawn badge (violet) — a categorical "this call spawned a child
  // conversation" marker, not a status indicator. Same token-budget rationale
  // as JsonView.tsx above; paired with SpawnParentBacklink.tsx below, which
  // carries the same violet as the ascent half of the affordance.
  //
  // NARROWED mt#4220: this entry previously also covered a sky-hued tool-call
  // chip (`border-sky-500/30 bg-sky-500/5`, name in `text-sky-300`). That hue
  // is gone — a healthy tool call is now a dim `text-muted-foreground` line
  // with no border and no tint, because spending an accent colour on the
  // machinery is what buried assistant prose on this surface. See the module's
  // "Weight hierarchy" docblock. Violet is the only raw palette left here, and
  // a future sky-style categorical chip should be argued on its own merits
  // rather than inheriting this entry.
  "src/cockpit/web/components/ConversationElementRenderers.tsx",
  // mt#3692: the "Spawned by" backlink is the ascent half of the same
  // subagent-spawn affordance the violet badge marks above, so it carries the
  // same violet to read as one pair. Extracted into its own file because
  // ConversationView.tsx had grown past the 1500-line max-lines limit — same
  // exemption rationale, same code, new file, exactly as mt#3262 above.
  "src/cockpit/web/components/SpawnParentBacklink.tsx",
  // Command-palette entity-type badges (memory=emerald, conversation=sky) —
  // categorical entity-type coloring, not health status. Unifying with the
  // signal-cyan convention Agents.tsx's KIND_BADGE_CONFIG already uses for
  // "conversation" is a design decision, not a lint-rule fix.
  "src/cockpit/web/components/CommandPalette.tsx",
  // PR-state chip (open=green, merged=violet, closed=destructive) —
  // deliberately mirrors GitHub's own PR-state color convention, not the
  // cockpit healthy/warning pattern.
  "src/cockpit/web/widgets/Changesets.tsx",
];

// === NODE-IMPORT GUARD FOR COCKPIT WEB (mt#3239) ===
// Structural backstop for the "browser-bundled cockpit page imports a Node-only module and
// crashes with `Can't find variable: process`" regression class (mt#3215 / PR #2315: AskPage.tsx
// imported @minsky/domain/ask/close-as-resolved, which transitively imports
// @minsky/shared/logger's top-level `process.env` reads — evaluating ANY export from that module
// runs the logger's side effects, so the browser bundle crashed on load). See
// eslint-rules/no-node-import-in-cockpit-web.js for the full rule doc, the stated
// direct-vs-transitive coverage gap, and the `allowedExact` escape-hatch rationale below.
const COCKPIT_NODE_IMPORT_GUARD_OPTIONS = {
  bannedExact: ["@minsky/shared/logger"],
  bannedPrefixes: ["@minsky/domain"],
  // Spot-checked at mt#3239 authoring time: each of these already-in-use submodules has zero
  // Node dependencies at least one import-hop deep. Adding an entry here is a decision, not a
  // lint tweak — see the rule's own doc comment for the verification bar before adding another.
  allowedExact: [
    "@minsky/domain/ask/state-machine",
    "@minsky/domain/transcripts/event-schema",
    "@minsky/domain/transcripts/conversation-elements",
    "@minsky/domain/ai/dispatch-models",
    // mt#3259: verified stronger than the "one hop deep" bar above — short-id.ts
    // has ZERO import statements of any kind (145 lines of pure string/number
    // logic: normalizeShortIdPrefix / formatShortId / parseShortId / nextShortId),
    // so it has no Node dependency at ANY hop, not merely at one. The cockpit
    // linkifier imports `parseShortId` from it so the `<prefix>#<n>` token shape
    // has ONE authority shared with the minting side, rather than a second
    // hand-rolled regex in the web bundle that could drift from it.
    "@minsky/domain/utils/short-id",
    // mt#3323: same "zero imports at ANY hop" bar as short-id above —
    // rewind-detection.ts's ONLY import is `import type { ... }` from
    // ../context/types, which erases at compile time, so it contributes no
    // runtime import edge whatsoever. ConversationView imports
    // `isOperatorPrompt` from it so "which user line is an operator prompt
    // vs. a tool result" has ONE authority shared with the detection side —
    // the render surface previously approximated it as
    // `rawJsonlType === "user"`, which silently miscounted tool results
    // (PR #2419 R1 BLOCKING).
    "@minsky/domain/transcripts/rewind-detection",
    // mt#4057: same "zero imports at ANY hop" bar as the two above —
    // interceptor-state.ts's ONLY import is `import type { ... }` from
    // ./aggregates, erased at compile time, so it contributes no runtime import
    // edge whatsoever (verified: `grep '^import' ` returns that one type-only
    // line and nothing else). The `/interceptors` catalog and detail pages
    // import `deriveInterceptorState` / `deriveInterceptorCost` /
    // `computeAttentionCounts` from it so the deterrent-vs-dormant-vs-broken
    // verdict has ONE authority shared with the server-side verification
    // script, rather than a second copy in the web bundle that could drift into
    // inferring health from fire counts — the exact conflation mt#3754 exists
    // to prevent.
    "@minsky/domain/guard-events/interceptor-state",
    // mt#4287: meets the same "zero Node dependency at ANY hop" bar, verified
    // rather than assumed. protection-summary.ts has exactly TWO import lines:
    // a type-only one from ./aggregates (erased, no runtime edge) and a value
    // import from ./interceptor-state — the entry directly above, whose own
    // sole import is likewise type-only. So its entire runtime import graph is
    // {interceptor-state}, which is already verified empty; there is no third
    // hop to check.
    //
    // The operator page imports `deriveProtectionSummary` from it so the
    // per-failure-class rollup has ONE authority rather than a second copy in
    // the web bundle. That matters more here than for a typical shared helper:
    // the maintainer and operator surfaces render the SAME figures in two
    // vocabularies, and a drifted second definition would leave both looking
    // correct while disagreeing — the exact failure mt#3754 SC6 forbids.
    "@minsky/domain/guard-events/protection-summary",
  ],
};

// Shared plugin-object reference for TSX/JSX `custom` rules (mt#2916 PR #2045
// review R1): ESLint flat config errors ("Cannot redefine plugin 'custom'")
// if two DIFFERENT object instances register the same plugin key for
// overlapping `files` globs. Every TSX-scoped block below that needs the
// `custom` plugin references THIS SAME object, so each block can declare its
// own self-contained `plugins`/`languageOptions` (no relying on another
// block having registered the rule first) without tripping that error.
const TSX_CUSTOM_PLUGIN = {
  rules: {
    "no-raw-console": noRawConsole,
    "no-raw-colors-in-cockpit": noRawColorsInCockpit,
    "no-node-import-in-cockpit-web": noNodeImportInCockpitWeb,
    "no-spy-patching": noSpyPatching,
  },
};

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
      // Rust/Cargo build output — `cargo doc` generates target/doc/**/*.js (rustdoc)
      // that `eslint .` would otherwise lint, blocking every commit (mt#2541). No
      // legitimate `target` source dir is tracked, so the broad glob is safe.
      "**/target/**",
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
          "no-raw-colors-in-cockpit": noRawColorsInCockpit,
          "require-hook-domain-bootstrap": requireHookDomainBootstrap,
          "require-guard-outcome-in-fire-log": requireGuardOutcomeInFireLog,
          "no-node-import-in-cockpit-web": noNodeImportInCockpitWeb,
          "require-registered-cockpit-loop": requireRegisteredCockpitLoop,
          "no-silent-catch": noSilentCatch,
          "prefer-loggable-error-summary": preferLoggableErrorSummary,
          "require-subprocess-network-timeout": requireSubprocessNetworkTimeout,
          "no-spy-patching": noSpyPatching,
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
      // In-place collaborator patching (spyOn) ban + restore-protocol companion check
      // (mt#3565 / ADR-036). Corpus verified clean (0 spyOn sites) before shipping at "error" —
      // no warn phase, no carve-out list. Rule/messageId name is a principal-reserved working
      // name (renameable without another ADR revision).
      "custom/no-spy-patching": "error",
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
          // DI-fallback-shape check (mt#2642, generalizing ADR-026 rule 3): `x ?? create<X>(...)`
          // / `x?.y ?? new <X>(...)` across src/ + packages/domain/src/. Existing instances
          // found by the initial repo-wide scan (18 violations, 10 files) — allowlisted per
          // the ADR-026 precedent ("allowlist, don't decorate") since mass-rewriting call sites
          // to make these deps required is out of this task's scope. Each entry below is a
          // test-injection override parameter (production default via a factory/constructor,
          // test override via the param) — the same architectural shape as the ADR-026-named
          // `octokitOverride` instances, not a new pattern.
          allowedFallbackFiles: [
            // ADR-026's 6 named instances: `octokitOverride ?? createOctokit(...)`.
            "**/packages/domain/src/repository/github-pr-review.ts",
            "**/packages/domain/src/repository/github-labels.ts",
            "**/packages/domain/src/repository/github-workflow-runs.ts",
            "**/packages/domain/src/repository/github-checks-run.ts",
            "**/packages/domain/src/repository/github-branch-protection.ts",
            "**/packages/domain/src/repository/github-pr-operations.ts",
            // `notifierOverride ?? createPostgresWindowNotifier(...)` — test-injection
            // override for window.open/window.close's Postgres NOTIFY notifier.
            "**/src/adapters/shared/commands/window/index.ts",
            // `onHarnessSessionLinked ?? createDrivenInitLinkObserver()` — test-injection
            // override for the driven-session task-link observer.
            "**/src/cockpit/routes/driven-sessions.ts",
            // `options?.retryService ?? new IntelligentRetryService(...)` — test-injection
            // override for NotionProvider's retry strategy.
            "**/packages/domain/src/knowledge/providers/notion-provider.ts",
            // `deps?.ruleService ?? new RuleService(...)` — test-injection override in the
            // rules CRUD-operations compile path.
            "**/packages/domain/src/rules/operations/crud-operations.ts",
          ],
          // mt#2642 reconciliation note re: the mt#2642 spec's mt#1024-scope carve-out
          // ("src/domain/tasks.ts, query-commands.ts, mutation-commands.ts — not already
          // cleaned up by mt#1024 at the time this task is picked up"): `src/domain/tasks.ts`
          // no longer exists (moved under packages/domain/src/ by mt#2108's domain-package
          // extraction). `packages/domain/src/tasks/commands/{query,mutation}-commands.ts`
          // DO still have a deps-optional-fallback to createConfiguredTaskService, but in an
          // `if (!taskService) { taskService = deps?.createConfiguredTaskService ? ... : ... }`
          // shape — a conditional/ternary, not this rule's literal `x ?? create<X>(...)` /
          // `x?.y ?? new <X>(...)` LogicalExpression shapes, so it is not (and per the
          // Acceptance Tests' two required fixtures, should not be) matched here. mt#1024
          // (still TODO) remains the owner of eliminating that fallback, per ADR-026's
          // migration policy and this task's explicit Scope carve-out ("the broader DI-tier
          // migration is owned by mt#1024/mt#1804").
        },
      ], // Prevent direct construction of domain services in adapter layer (mt#911), and the generalized DI-fallback shape (mt#2642 / ADR-026)
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
            // mt#3882 — the `operator-override` slice of the same registry,
            // derived from HOOK_ONLY_ENV_VAR_CATEGORIES. Same kind of thing as
            // the entry above it: a constant lookup table, not a service.
            "OPERATOR_OVERRIDE_ENV_VARS",
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
            // Same rationale (mt#2322): constructed directly via `new FollowUpService(db)`
            // in the cockpit follow-up sweeper / db-providers helper, never resolved
            // through the tsyringe container.
            "FollowUpService",
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

      // mt#3299 — every catch block must rethrow, log, or carry an
      // `// intentional-swallow: <reason>` comment (silent-failure class,
      // mt#3295 corpus). Test files excluded by default (allowInTests).
      // Registered "off": this repo's own pre-commit ESLint step enforces a
      // HARD zero-tolerance warning gate (MAX_LINT_WARNINGS = 0, mt#1097, no
      // override — see runESLintValidation in src/hooks/pre-commit.ts), so
      // "warn" is not a viable ship state here — it would block every future
      // commit repo-wide, not just ones touching violating files. A
      // full-repo run at authoring time found 1462 violations across 560
      // files, and a scoped check of just .minsky/hooks + .claude/hooks
      // (the corpus's stated top-concentration area) still found 151 of
      // those files — no directory-level slice is clean enough to flip to
      // "error" today. Bulk cleanup + flip to "error" tracked at mt#3312.
      "custom/no-silent-catch": "off",

      // mt#4632 — flag a caught error rendered as `err.message` /
      // `getErrorMessage(err)` when that value is written into a LOG record,
      // and recommend `getLoggableErrorSummary` (mt#2903), which walks the
      // `.cause` chain so a wrapped error's real diagnosis survives. Shares
      // `no-silent-catch`'s logger matcher via `eslint-rules/logger-detection.js`
      // rather than growing a second one.
      //
      // Scoped to ERROR-HANDLING contexts (PR #3380 R1): a `catch` block, or a
      // promise rejection handler (`.catch(fn)`, `.then(ok, fn)`). Deliberately
      // NOT a bare CatchClause test — a `.catch` handler is the same defect in
      // different syntax, and scoping to the keyword would leave it unflagged.
      //
      // MEASURED before choosing this posture (2026-08-26), which is the whole
      // reason it is "off" rather than "warn":
      //   - 590 sites flagged across src/packages/services/scripts.
      //   - A raw grep for the expression finds 878, so the rule's filters
      //     exclude 288 (~33%). The grep count OVERSTATES the actionable
      //     population by a third; that is what the AST buys.
      //   - Of those 288, the log-flow filter accounts for 279 (throws,
      //     returns, plain assignments) and the error-handling scope for 9
      //     (599 -> 590): nearly every log-bound bare rendering already sits
      //     inside a handler.
      //   - 30-site spread sample hand-classified: 0 false positives against
      //     the rule's definition. Every one was a caught error going into a
      //     `log.*` / `console.*` call.
      //
      // "off" for the same zero-tolerance-warning-gate reason as
      // no-silent-catch above (mt#1097, no override): 590 violations cannot
      // ship at "warn". Bulk cleanup + flip tracked at mt#4639, on the
      // mt#3312 / mt#3313 model.
      //
      // One sub-category the cleanup should decide rather than mass-rewrite:
      // ~4 of the 30 sampled were CLI user-facing `console.error` in scripts/
      // (e.g. status-command.ts:20), where the terse message is arguably the
      // right output for a human at a terminal, not a diagnostic log. Those
      // are correctly flagged by the definition and may still want to stay as
      // they are.
      "custom/prefer-loggable-error-summary": "off",

      // mt#3299 — flag execSync/spawnSync/fetch call sites lacking a
      // timeout/AbortSignal argument (mechanizable slice of the
      // unguarded-edge-case class, mt#3295 corpus). Sibling of
      // no-unsafe-git-exec (git-specific); this rule is generic. Registered
      // "off" for the same zero-tolerance-warning-gate reason as
      // no-silent-catch above: a full-repo run found 542 violations across
      // 137 files. Bulk cleanup + flip to "error" tracked at mt#3313.
      "custom/require-subprocess-network-timeout": "off",

      // === SINGLETON ARCHITECTURE ===
      "custom/no-singleton-reach-in": [
        "warn",
        {
          allowedFiles: [
            // mt#2643 — paths updated from the pre-mt#2108 `src/domain/...` location to
            // the post-mt#2108 `packages/domain/src/...` location (the domain-package
            // extraction flips the path segment order from `src/domain` to `domain/src`;
            // same root cause as the require-injectable.js/no-domain-singleton.js fix in
            // ADR-026 / mt#2623). Four entries were dropped entirely because their
            // referenced files no longer exist anywhere in the repo (verified via
            // repo-wide filename search): session-provider-cache.ts,
            // storage/backends/postgres-storage.ts, tasks-importer-service.ts, and
            // tasks/operations/base-task-operation.ts.
            // PersistenceService composition roots
            "**/packages/domain/src/persistence/service.ts",
            "**/packages/domain/src/persistence/validation-operations.ts",
            // Session provider composition roots
            "**/packages/domain/src/session/session-service.ts",
            "**/packages/domain/src/session/drizzle-session-repository.ts",
            // Session path resolver (lazy fallback for MCP handlers without DI context)
            "**/packages/domain/src/session/session-path-resolver.ts",
            // Domain-level facade files that re-export/wire providers
            "**/packages/domain/src/session.ts",
            "**/packages/domain/src/git.ts",
            // Git operations base class (lazy fallback for session resolution)
            "**/packages/domain/src/git/operations/base-git-operation.ts",
            // Storage backends that need direct provider access
            "**/packages/domain/src/storage/vector/vector-storage-factory.ts",
            "**/packages/domain/src/storage/vector/postgres-vector-storage.ts",
            // Task domain composition roots
            "**/packages/domain/src/tasks/taskService.ts",
            "**/packages/domain/src/tasks/github-issues-api.ts",
            // Rules domain
            "**/packages/domain/src/rules/rule-similarity-service.ts",
            // Changeset adapters (resolve session provider for PR operations)
            "**/packages/domain/src/changeset/adapters/*.ts",
            // Session domain (command orchestration and provider resolution)
            "**/packages/domain/src/tasks/taskCommands.ts",
            "**/packages/domain/src/tasks/commands/shared-helpers.ts",
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
              // mt#4854: the v1 MCP SDK is gone as a DIRECT dependency, but
              // `@modelcontextprotocol/inspector` (devDependency) hard-depends on
              // `@modelcontextprotocol/sdk@^1.17.0`, so bun still hoists v1 to
              // `node_modules/@modelcontextprotocol/sdk`. A stray v1 import would therefore
              // RESOLVE and typecheck cleanly — nothing else in the toolchain would catch the
              // regression. This rule is what actually enforces the migration; removing the
              // inspector devDependency would be the alternative, and is out of scope.
              group: ["@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/*"],
              message:
                "The v1 MCP SDK was retired (mt#4854). Import from the v2 packages: @modelcontextprotocol/server (Server, spec types, ProtocolError/ProtocolErrorCode), /server/stdio (StdioServerTransport), /client (Client, InMemoryTransport), /node (NodeStreamableHTTPServerTransport), /core (spec Zod schemas). v1 survives in node_modules only as a transitive dep of @modelcontextprotocol/inspector.",
            },
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
    // References the SHARED `TSX_CUSTOM_PLUGIN` object (declared above,
    // before `export default`) rather than a fresh object literal, so the
    // mt#2916 cockpit-scoped TSX block further down can independently
    // register the SAME plugin instance for its own narrower glob without
    // ESLint's "Cannot redefine plugin 'custom'" error (which fires when two
    // DIFFERENT object instances register the same plugin key for
    // overlapping `files` globs — reference equality, not deep equality, is
    // what ESLint checks).
    plugins: {
      custom: TSX_CUSTOM_PLUGIN,
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
      // Same class as the scripts/ exemption above, one directory over:
      // live-model eval harnesses under services/reviewer/eval/ (mt#3631's
      // run-test-shape-eval.ts is the first) — standalone CLI tools whose
      // pass/fail summary IS the operator-visible result.
      "services/reviewer/eval/**",
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
  // === no-spy-patching — TSX/JSX test-file coverage parity (mt#3565 PR #2608 R1) ===
  // The main `**/*.ts`/`**/*.js` block registers `custom/no-spy-patching`, but React
  // component tests (e.g. src/cockpit/web/components/CopyId.test.tsx — a direct-spyOn
  // migration target under mt#3629) are `.tsx` and therefore invisible to it: the
  // `custom` plugin is registered separately for TSX/JSX (see TSX_CUSTOM_PLUGIN above),
  // scoped narrowly per the mt#2916/mt#1960 "no unrelated scope creep into TSX" precedent
  // set elsewhere in this file. Scoped to test files only (not all `.tsx`/`.jsx`, unlike
  // the broader no-raw-console block) since spyOn is a test-only concern.
  {
    files: ["**/*.test.tsx", "**/*.spec.tsx", "**/*.test.jsx", "**/*.spec.jsx"],
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
      custom: TSX_CUSTOM_PLUGIN,
    },
    rules: {
      "custom/no-spy-patching": "error",
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
  // === ENTRY-POINT DOMAIN-BOOTSTRAP ENFORCEMENT (mt#3046; widened mt#3178) ===
  // A hook or script process is its own entry point: it inherits neither the
  // tsyringe reflect polyfill nor the domain configuration system, so any such
  // file reaching the persistence layer must bootstrap the domain layer first.
  // Without it the domain import throws or the provider resolves to null —
  // and the failure is typically SWALLOWED, leaving the entry point silently
  // dead (mt#3019: 0 of 62 rows carried any hook-written column for two weeks;
  // mt#3046 found a second instance the same way; mt#3178 found two more under
  // `scripts/`, one of which masked the polyfill error behind its own
  // "SKIP: Postgres not available" message).
  //
  // SATISFACTION IS PER-TREE — the rule enforces the invariant, not one idiom:
  //   - `.minsky/hooks/**` must import `ensureHookDomainBootstrap`, which does
  //     polyfill AND config init. The bare polyfill is NOT enough here: a hook
  //     with only the polyfill still resolves a null provider (the mt#3019
  //     failure).
  //   - `scripts/**` may instead use a STATIC `import "reflect-metadata"`, the
  //     conventional scripts idiom (paired with `initializeConfiguration` /
  //     `setupConfiguration`). Static only — a dynamic polyfill import need not
  //     precede the domain imports it must precede.
  //
  // COVERAGE IS DECLARED IN TWO PLACES THAT MUST STAY IN SYNC: the `files` glob
  // below, AND `ENTRY_POINT_ROOTS_POSIX` in the rule itself. A root added to
  // only one is silently unenforced — mt#3178 widened this glob alone and lint
  // reported 0 violations across 144 files because the rule's own path guard
  // rejected every `scripts/**` path.
  //
  // Covered trees are the SOURCE trees, not the generated `.claude/hooks/**`
  // copies (fixing a generated file is not a fix). Test files are excluded: a
  // test is not an entry point and legitimately names these symbols in
  // assertions. The rule additionally exempts `domain-bootstrap.ts` itself,
  // which cannot import itself. This block needs no separate plugin
  // registration — `require-hook-domain-bootstrap` is already in the main
  // `**/*.ts` block's `custom` plugin object above.
  {
    files: [".minsky/hooks/**/*.ts", "scripts/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "custom/require-hook-domain-bootstrap": "error",
    },
  },
  // === GUARD-OUTCOME MARKER ON FIRE-LOG WRITERS (mt#3920) ===
  // A hook that writes fire-log records must set `guardOutcome` somewhere.
  // mt#3892 made the field guard-health's ONLY clean-run evidence and added it
  // in two places; ten other standalone writers were left without it for two
  // months, each of them unable to ever leave `dormant`, and nothing caught it.
  //
  // The invariant is FILE-level, not call-level, on purpose: the field is
  // legitimately UNSET at many exits (an override, an unrelated tool, a
  // short-circuit before the check), so "every call passes it" would be wrong.
  // What is checkable is that the file considered the marker at all.
  //
  // COVERAGE IS DECLARED IN TWO PLACES THAT MUST STAY IN SYNC: the `files` glob
  // below, AND `COVERED_ROOTS_POSIX` in the rule itself — same footgun as the
  // sibling block above, which mt#3178 walked into.
  //
  // Covered tree is the SOURCE tree, not the generated `.claude/hooks/**` copy.
  // Test files are excluded: a test legitimately names the writer while
  // asserting on records it builds by hand. The rule additionally exempts
  // `fire-log.ts`, which DEFINES the field. No separate plugin registration is
  // needed — see the sibling block above.
  {
    files: [".minsky/hooks/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "custom/require-guard-outcome-in-fire-log": "error",
    },
  },
  // === RAW COLOR ENFORCEMENT IN COCKPIT (mt#2916) ===
  // docs/design-system.md §5.2's exact healthy/warning-hue boundary, enforced
  // structurally instead of prose-only (src/cockpit/CLAUDE.md §Design
  // vocabulary previously stated "semantic tokens only" / the blessed
  // exception in prose only). COVERAGE IS DECLARED HERE: src/cockpit/web/**
  // is the enforced glob; test files are excluded (fixtures/snapshots may
  // legitimately reference color literals). COCKPIT_STATUS_FILES /
  // COCKPIT_PALETTE_EXEMPT_FILES above are the two declared allowlists — see
  // their comments for the "adding an entry is a design decision, not a lint
  // tweak" rationale. This `.ts` block needs no separate plugin registration:
  // `no-raw-colors-in-cockpit` is already in the main `**/*.ts` block's
  // `custom` plugin object above.
  // mt#4185 — a long-lived cockpit-DAEMON loop must join the sweep-liveness
  // registry, or the meta-watchdog built to catch exactly its failure cannot
  // see it. COVERAGE IS DECLARED HERE: `src/cockpit/**/*.ts` minus
  // `src/cockpit/web/**` (browser code has no daemon loops and no registry to
  // join) and minus tests (a fixture loop is the point of the rule's own
  // test). No separate plugin registration is needed — the rule is already in
  // the main `**/*.ts` block's `custom` plugin object above.
  {
    files: ["src/cockpit/**/*.ts"],
    ignores: ["src/cockpit/web/**", "**/*.test.ts"],
    rules: {
      "custom/require-registered-cockpit-loop": "error",
    },
  },
  {
    files: ["src/cockpit/web/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "custom/no-raw-colors-in-cockpit": [
        "error",
        { statusFiles: COCKPIT_STATUS_FILES, paletteExemptFiles: COCKPIT_PALETTE_EXEMPT_FILES },
      ],
      "custom/no-node-import-in-cockpit-web": ["error", COCKPIT_NODE_IMPORT_GUARD_OPTIONS],
    },
  },
  // `.tsx` coverage is fully self-contained (PR #2045 review R1): its own
  // `languageOptions` (JSX-aware parser) and `plugins.custom` registration,
  // rather than depending on the `no-raw-console` TSX-parity block above
  // having registered the rule first. Both blocks reference the SAME
  // `TSX_CUSTOM_PLUGIN` object (declared before `export default`), so this
  // narrower glob doesn't trip ESLint's "Cannot redefine plugin 'custom'"
  // error — if the `no-raw-console` block is later refactored or removed,
  // this block keeps working independently.
  {
    files: ["src/cockpit/web/**/*.tsx"],
    ignores: ["**/*.test.tsx"],
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
      custom: TSX_CUSTOM_PLUGIN,
    },
    rules: {
      "custom/no-raw-colors-in-cockpit": [
        "error",
        { statusFiles: COCKPIT_STATUS_FILES, paletteExemptFiles: COCKPIT_PALETTE_EXEMPT_FILES },
      ],
      "custom/no-node-import-in-cockpit-web": ["error", COCKPIT_NODE_IMPORT_GUARD_OPTIONS],
    },
  },
];
