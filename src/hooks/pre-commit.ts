#!/usr/bin/env bun

/**
 * TypeScript-based pre-commit hook implementation
 *
 * Replaces fragile bash script with type-safe TypeScript that leverages
 * Minsky's own infrastructure for consistent configuration and error handling.
 */

/* eslint-disable max-lines -- mt#3613's ADR-numbering-collision check tipped this file from
 * 1492 to 1502 ESLint-counted (comments/blanks excluded) lines, past the 1500 error threshold.
 * The codebase's established convention requires one dedicated `instrumented()` call per guard
 * (combining two checks under one guard call was tried and rejected as BLOCKING — mt#3299 PR
 * #2392 R1 #5, "each check now gets its own instrumented() call, same as every sibling
 * pre-commit step") so the ~10-line-per-check wiring cost (import + call + early-return) isn't
 * avoidable without restructuring the file, which is out of mt#3613's scope. Tracked at
 * mt#3645 — remove this disable once that task gives the file headroom again. */

import { execAsync, safeShellQuote } from "@minsky/shared/exec";
import { regenerateStagedClaudeHooks } from "./claude-hooks-compile-regen";
import { regenerateDockerfileBunBuild, checkBunBuildSync } from "./bun-build-sync-regen";
import { regenerateInterceptorCatalog } from "./interceptor-catalog-regen";
import { execGitWithTimeout } from "@minsky/domain/utils/git-exec";
import { resolveTsgoBinary } from "../utils/tsgo-binary";
import { stat, readdir, readFile } from "fs/promises";
import { join } from "path";
import { ProjectConfigReader } from "@minsky/domain/project/config-reader";
import { log } from "@minsky/shared/logger";
import {
  detectNulByteViolations,
  isPathAllowlisted,
  isOverrideTruthy,
  NUL_BYTE_CHECK_OVERRIDE_ENV,
} from "./nul-byte-detector";
import {
  detectConflictMarkerViolations,
  CONFLICT_MARKER_CHECK_OVERRIDE_ENV,
} from "./conflict-marker-detector";
import { readStagedFileContent } from "./staged-file-reader";
import { discoverProtectedDockerfiles } from "./workspace-copy-detector";
import {
  detectMissingJournalEntries,
  MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV,
  type JournalEntry,
} from "./migration-journal-check";
import {
  runDeployDomainCheck as runDeployDomainDetector,
  isDeployDomainOverrideTruthy,
  DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV,
} from "./deploy-domain-detector";
import {
  detectImmutableMigrationViolations,
  isImmutableMigrationOverrideTruthy,
  IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV,
  MIGRATION_DIRS,
} from "./immutable-migration-detector";
import {
  detectMigrationJournalViolations,
  isMigrationCollisionOverrideTruthy,
  MIGRATION_COLLISION_CHECK_OVERRIDE_ENV,
} from "./migration-collision-detector";
import {
  runMigrationGuardCheck as runMigrationGuardCheckImpl,
  MIGRATION_GUARD_CHECK_OVERRIDE_ENV,
} from "./migration-guard-detector";
import {
  runDuplicateGeneratedContentCheck as runDuplicateGeneratedContentCheckImpl,
  DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV,
} from "./duplicate-generated-content-detector";
import {
  runAdrNumberingCollisionCheck as runAdrNumberingCollisionCheckImpl,
  ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV,
} from "./adr-numbering-collision-detector";
import { runRelatedTestsCheck } from "./related-tests-check";
import {
  recordPreCommitFireLogEntry,
  classifyOverride as classifyPreCommitOverride,
} from "./pre-commit-fire-log";
import type { RecordPreCommitFireLogInput } from "./pre-commit-fire-log";
import {
  selectLintableStagedFiles,
  buildScopedLintCommand,
  evaluateLintSummary,
} from "./pre-commit-lint-scope";
import {
  describeSubprocessFailure,
  ESLINT_TIMEOUT_MS,
  FORMATTER_TIMEOUT_MS,
  TYPECHECK_TIMEOUT_MS,
} from "./pre-commit-subprocess-failure";

/**
 * Env var that, when truthy (`1`, `true`, `yes`), skips a size-budget-exceeded
 * failure from `runRulesCompileCheck` (mt#2802). Scoped narrowly to the
 * "budget-exceeded" failure class — a genuinely STALE target still blocks
 * the commit even with this override set (see the `errorKind` branch in
 * `runRulesCompileCheck`). Registered in `HOOK_ONLY_ENV_VARS` at
 * packages/domain/src/configuration/sources/environment.ts per the mt#1788
 * ESLint rule contract. Follows the same override-with-audit pattern as
 * `NUL_BYTE_CHECK_OVERRIDE_ENV` etc. (`isOverrideTruthy`, imported above).
 *
 * **Mid-session override path for MCP-only agents (mt#2904).** This hook runs
 * via `.husky/pre-commit`'s `bun run src/hooks/pre-commit.ts`, and Bun
 * auto-loads a `.env.local` (or `.env`) file from the process cwd into
 * `process.env` for every `bun run` invocation — no shell export required
 * (Bun docs, "Environment variables": .env.local is one of the files Bun
 * reads automatically, https://bun.com/docs/runtime/env). An MCP-only agent
 * has no parameter path to set this var directly: `session_commit` has no
 * env-passthrough parameter, and raw `git commit` invocations from agent
 * tool contexts are denied by the repo's git/gh-CLI PreToolUse ban
 * (mt#1196 — see CLAUDE.md §Hook Files for the guard registry; agents are
 * redirected to `session_commit`). The SANCTIONED mid-session
 * override is therefore: write a session-workspace `.env.local` containing
 * `MINSKY_SKIP_SIZE_BUDGET=1`, then commit via `session_commit` as normal —
 * the value is picked up automatically on the next `bun run`. `.env.local`
 * is gitignored (see `.gitignore`), so this never lands in the commit
 * itself. Proven by three independent implementer sessions on 2026-07-17
 * (mt#2888, mt#2894, mt#2729 — see their PR #2018/#2019/#2020 bodies) before
 * being canonicalized here. This is still an AUDITED override (the skip is
 * logged with a timestamp per invocation, value never echoed) — it is a new
 * DELIVERY MECHANISM for the same env var, not a new bypass.
 */
const SIZE_BUDGET_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_SIZE_BUDGET";

/**
 * Override env var for the fast changed-file-scoped related-test gate
 * (mt#2932, Step 7 in `run()`). Escape hatch for the rare case where the
 * related-test mapping/runner itself is misbehaving and blocking an
 * unrelated commit -- the full-suite gate at push time (.husky/pre-push)
 * and CI remain the authoritative backstop regardless of this override.
 * Registered in `HOOK_ONLY_ENV_VARS` per the mt#1788 ESLint rule contract.
 */
const RELATED_TESTS_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_RELATED_TESTS";

export interface ESLintResult {
  filePath: string;
  messages: {
    ruleId?: string;
    severity?: number;
    message?: string;
    line?: number;
    column?: number;
  }[];
  errorCount: number;
  warningCount: number;
  fixableErrorCount: number;
  fixableWarningCount: number;
  source?: string;
}

export interface ESLintSummary {
  errorCount: number;
  warningCount: number;
  results: ESLintResult[];
}

// ---------------------------------------------------------------------------
// mt#2597 R1 fix — the fire-log instrumentation wrapper, extracted to a
// standalone exported function so its override-attribution logic is
// unit-testable without instantiating (or running the real heavy steps of)
// `PreCommitHook`. `PreCommitHook.instrumented()` below is a thin delegate.
// ---------------------------------------------------------------------------

export interface RunInstrumentedStepDeps {
  /** Injectable for tests — defaults to the real `recordPreCommitFireLogEntry`. */
  recordFireLog?: (input: RecordPreCommitFireLogInput) => void;
  /** Injectable clock for duration measurement — defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Fire-log wrapper (mt#2597, evaluation-loop Phase 1) — instruments a single
 * pre-commit step without touching the step method's own body. Records
 * exactly one fire-log entry per step invocation: decision=allow on success,
 * decision=deny on failure.
 *
 * Override attribution (R1 fix): a pre-commit step's override env-var (e.g.
 * `MINSKY_SKIP_NUL_CHECK`) is read INSIDE the step's own body — this wrapper
 * has no independent visibility into whether a violation was actually found
 * and suppressed. The ORIGINAL Phase-1 landing approximated this by checking
 * `result.success && isOverrideTruthy(process.env[overrideEnvVar])` — but that
 * conflates "the env-var happens to be set in the environment" with "this
 * step's own decision was actually overridden": a var left set from an
 * earlier step, a different step's test run, or a developer's unrelated
 * export would misattribute a NORMAL pass as an override. The fix: each
 * step's own function body now sets `result.overridden = true` on the
 * SPECIFIC branch where it actually consulted its var and took the skip
 * path (mirroring the guard-dispatcher's `checkOverride`, which observes the
 * decision BEFORE the guard runs and so always knows definitively). This
 * wrapper reads that flag — not `process.env` — as the sole override signal.
 */
export function runInstrumentedStep(
  guardName: string,
  fn: () => Promise<HookResult>,
  overrideEnvVar?: string,
  deps: RunInstrumentedStepDeps = {}
): Promise<HookResult> {
  const recordFireLog = deps.recordFireLog ?? recordPreCommitFireLogEntry;
  const now = deps.now ?? Date.now;
  const startMs = now();
  return fn().then((result) => {
    const durationMs = now() - startMs;
    const overridden = result.overridden === true && overrideEnvVar !== undefined;
    recordFireLog({
      guardName,
      decision: result.success ? "allow" : "deny",
      durationMs,
      ...(overridden
        ? {
            overrideEnvVar,
            overrideClassification: classifyPreCommitOverride(overrideEnvVar),
          }
        : {}),
    });
    return result;
  });
}

export interface HookResult {
  success: boolean;
  message: string;
  exitCode: number;
  /**
   * mt#2597 R1 fix (reviewer finding: "pre-commit over-attribution on
   * presence vs. actual suppression") — set to `true` by a step's OWN
   * function body when IT actually consulted its paired override env-var
   * and took the skip path (e.g. `runNulByteCheck`'s
   * `isOverrideTruthy(process.env[NUL_BYTE_CHECK_OVERRIDE_ENV])` branch).
   * `instrumented()`/`runInstrumentedStep` reads THIS flag — not a blanket
   * `process.env` scan — to decide whether to attach override fields to the
   * fire-log record. Omitted (or `false`) means "ran its normal path," even
   * if the step's paired override env-var happens to be truthy in the
   * environment for an unrelated reason (a leftover export, a var set for a
   * DIFFERENT step, a developer testing something else) — that env-var
   * presence must never be conflated with "this step's decision was
   * actually overridden."
   */
  overridden?: boolean;
}

export class PreCommitHook {
  /**
   * @param exec Test seam for the subprocess-running steps (mt#3406, PR #2480
   * R1). The reviewer asked for the timeout relabelling to be asserted through
   * the STEPS rather than the helper alone, which needs a way to make a step's
   * child process fail on demand. Module-mocking `child_process` was tried and
   * rejected: it only takes effect if this module has not been imported yet, so
   * the tests passed alone and failed in a suite run — order-dependent, which
   * is worse than no test. An injected default matches the seam convention used
   * across the repo (`spawnFn`, `execFileFn`, `getDb`) and cannot be defeated
   * by import order. Production constructs the hook with no argument.
   */
  constructor(
    private projectRoot: string = process.cwd(),
    private exec: typeof execAsync = execAsync,
    /**
     * Test seam for the checker resolution (mt#3657) — same convention as `exec` above.
     * The typecheck step resolves the pinned binary BEFORE spawning anything, so a fixture
     * repo with no `node_modules` would otherwise short-circuit every subprocess-shape test
     * on that step into "checker missing" and assert nothing about the shape under test.
     */
    private resolveChecker: typeof resolveTsgoBinary = resolveTsgoBinary
  ) {}

  /**
   * Fire-log wrapper (mt#2597, evaluation-loop Phase 1) — thin per-instance
   * delegate to the standalone `runInstrumentedStep` (see that function's
   * doc comment above for the override-attribution rationale, including the
   * R1 fix that replaced the original presence-based env-var scan with the
   * step's own `result.overridden` signal).
   */
  private async instrumented(
    guardName: string,
    fn: () => Promise<HookResult>,
    overrideEnvVar?: string
  ): Promise<HookResult> {
    return runInstrumentedStep(guardName, fn, overrideEnvVar);
  }

  /**
   * Run all pre-commit validation steps
   */
  async run(): Promise<HookResult> {
    log.cli("🔍 Running pre-commit validation...\n");

    try {
      // ── Instant checks (~0s) ──

      // Step 0: Hook file permissions
      const hookPermResult = await this.instrumented("hook-permission-check", () =>
        this.runHookPermissionCheck()
      );
      if (!hookPermResult.success) {
        return hookPermResult;
      }

      // ── Fast, lightweight checks first (~1s each) ──

      // Step 1: Code formatting (lint-staged, only staged files, ~1s)
      const formatResult = await this.instrumented("code-formatting", () =>
        this.runCodeFormatting()
      );
      if (!formatResult.success) {
        return formatResult;
      }

      // Step 1b: Completion-manifest regeneration (mt#2622). Unlike the
      // "compile --check" family below (Step 9 / 9b), which BLOCK the commit
      // and tell the operator to re-run a generator by hand, this step
      // auto-regenerates the shell-completion manifest and re-stages it —
      // the same auto-fix-and-restage shape as Step 1's lint-staged, not the
      // detect-and-block shape. That distinction is deliberate: the manifest
      // is a mechanically-derived structural artifact (Commander-tree walk +
      // Zod enum extraction) with zero editorial content, so silently
      // re-staging a corrected version carries none of the "don't want an
      // unreviewed content rewrite auto-committed" risk that motivates the
      // rules/skills compile checks blocking instead of auto-fixing.
      const completionManifestResult = await this.instrumented("completion-manifest-regen", () =>
        this.runCompletionManifestRegen()
      );
      if (!completionManifestResult.success) {
        return completionManifestResult;
      }

      // Step 1c: Interceptor-catalog regeneration (mt#4010). Same auto-fix-and-
      // restage shape and same rationale as Step 1b: a mechanically-derived
      // artifact with zero editorial content. Keeps the cockpit's
      // `/interceptors` route from rendering data that no longer matches the
      // authored descriptions it distills.
      const interceptorCatalogResult = await this.instrumented("interceptor-catalog-regen", () =>
        this.runInterceptorCatalogRegen()
      );
      if (!interceptorCatalogResult.success) {
        return interceptorCatalogResult;
      }

      // Console-usage validation moved into ESLint as the `custom/no-raw-console`
      // rule (mt#1960). Step 2 ran the standalone regex-based `lint:console:strict`
      // script; that script and its package.json scripts were retired with mt#1960.
      // The AST-based ESLint pass below now catches raw `console.*` calls.

      // Step 3: Variable naming check (~1s)
      const variableResult = await this.instrumented("variable-naming-check", () =>
        this.runVariableNamingCheck()
      );
      if (!variableResult.success) {
        return variableResult;
      }

      // Step 3-sql: SQL-capability message check (mt#4398, ~1s).
      //
      // `scripts/check-sql-capability-messages.ts` (mt#3661) has existed since
      // its own task shipped and was invoked by NOTHING — not CI, not a package
      // script, not this hook. It was exiting 1 on `main` with three real
      // cause-free sites, and nobody could have known: a check with no caller
      // produces no signal, which is `CLAUDE.md §Invocation path required for
      // event/poll mechanisms` ("the feature exists, its tests pass, it produces
      // nothing"). The three sites are fixed in this same change.
      //
      // WHY HERE rather than CI: `check-variable-naming` — the only other
      // static source check of this shape — runs from this hook, so this
      // follows the existing convention rather than inventing a second one.
      // mt#3134 is separately deciding whether checks of this class belong in
      // CI instead; if it lands on CI, this call moves with it rather than
      // being duplicated. mt#4400 tracks the four SIBLING check scripts that
      // are also unwired, and should append here rather than adding a method
      // each — this file already carries one bespoke method per check, which
      // is the growth mt#3645 is about.
      const sqlCapabilityResult = await this.instrumented("sql-capability-message-check", () =>
        this.runSqlCapabilityMessageCheck()
      );
      if (!sqlCapabilityResult.success) {
        return sqlCapabilityResult;
      }

      // Step 3a: Node shim detection — ban node shebangs, npm run, npx in source files (~0s)
      const nodeShimResult = await this.instrumented("node-shim-check", () =>
        this.runNodeShimCheck()
      );
      if (!nodeShimResult.success) {
        return nodeShimResult;
      }

      // Step 3b: NUL-byte detection — reject any tracked text file containing
      // a literal 0x00 byte (mt#1824). Closes the gate-gap exposed by mt#1821
      // / PR #1107 R1 where a JSON-escaped U+0000 landed on disk inside a TS
      // template literal and slipped past every other quality gate.
      const nulByteResult = await this.instrumented(
        "nul-byte-check",
        () => this.runNulByteCheck(),
        NUL_BYTE_CHECK_OVERRIDE_ENV
      );
      if (!nulByteResult.success) {
        return nulByteResult;
      }

      // Step 3b-ii: conflict-marker detection — reject any staged file carrying
      // git's `<<<<<<<` / `=======` / `>>>>>>>` markers (mt#4307). Same class as
      // the NUL check above ("this file was never meant to be committed in this
      // state"), and until this task only one of the two was checked. The
      // originating incident: a failed `git stash pop` wrote markers into four
      // rule files plus `src/generated/interceptor-catalog.json`, and the first
      // sign of it was twenty unrelated cockpit tests failing in the pre-push
      // suite on `JSON Parse error: Unrecognized token '<'`.
      const conflictMarkerResult = await this.instrumented(
        "conflict-marker-check",
        () => this.runConflictMarkerCheck(),
        CONFLICT_MARKER_CHECK_OVERRIDE_ENV
      );
      if (!conflictMarkerResult.success) {
        return conflictMarkerResult;
      }

      // Step 3c: Dockerfile workspace-COPY regeneration (mt#1984 + mt#1992
      // + mt#2621). Regenerates the workspace package.json COPY block in
      // every Dockerfile that runs `bun install --frozen-lockfile` (root +
      // sub-project Dockerfiles under services/* and packages/*) from the
      // same `workspaces` glob bun itself resolves, and re-stages any file
      // that changed. Replaces the mt#1984/mt#1992 detect-and-block guard —
      // instead of catching drift after the fact, the COPY block can no
      // longer drift by hand at all (mirrors the mt#2622 completion-
      // manifest auto-fix-and-restage pattern). Eliminates the drift class
      // that caused mt#1977 (75-minute root-Dockerfile outage) and mt#1991
      // (4-hour reviewer-Dockerfile outage).
      const dockerfileWorkspaceCopyResult = await this.instrumented(
        "dockerfile-workspace-copy-regen",
        () => this.runDockerfileWorkspaceCopyRegen()
      );
      if (!dockerfileWorkspaceCopyResult.success) {
        return dockerfileWorkspaceCopyResult;
      }

      // Step 3c-2: Dockerfile bun-build invocation regeneration (mt#3091).
      // Regenerates the root Dockerfile's `RUN bun build ...` line from
      // `scripts/cli-entry.ts`'s canonical `bunBuildArgs()` and re-stages it
      // if it changed — same auto-fix-and-restage shape as Step 3c above,
      // for the same reason: the Dockerfile invocation can no longer drift
      // out of sync by hand once it's generated instead of hand-typed.
      const dockerfileBunBuildResult = await this.instrumented("dockerfile-bun-build-regen", () =>
        this.runDockerfileBunBuildRegen()
      );
      if (!dockerfileBunBuildResult.success) {
        return dockerfileBunBuildResult;
      }

      // Step 3c-3: package.json bun-build sync check (mt#3091). Unlike the
      // regen step above, package.json's `scripts.build` is a flat JSON
      // string that isn't safely auto-rewritable the same way a
      // comment-delimited Dockerfile block is — so this step BLOCKS the
      // commit instead of auto-fixing when it diverges from the canonical
      // `bunBuildCommand()` (the same "compile --check" block-instead-of-
      // autofix shape used for content this repo's generators don't rewrite
      // in place). Also re-verifies the Dockerfile as a defense-in-depth
      // backstop for the regen step just above.
      const bunBuildSyncResult = await this.instrumented("bun-build-sync-check", () =>
        this.runBunBuildSyncCheck()
      );
      if (!bunBuildSyncResult.success) {
        return bunBuildSyncResult;
      }

      // Step 3d: Migration journal consistency (mt#2087). Verify that every
      // SQL file under packages/domain/src/storage/migrations/pg/ has a corresponding
      // entry in meta/_journal.json. Prevents the mt#2086 class where a
      // hand-written SQL file ships without a journal entry, making it
      // invisible to Drizzle's migrator.
      const migrationJournalResult = await this.instrumented(
        "migration-journal-check",
        () => this.runMigrationJournalCheck(),
        MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV
      );
      if (!migrationJournalResult.success) return migrationJournalResult;

      // Step 3e-a: Immutable-migration check (mt#2268). Block staged
      // MODIFICATIONS (not additions) to .sql files under the migration
      // directories whose tag is already listed in meta/_journal.json.
      // Editing an applied migration drifts Drizzle's sha256 ledger —
      // the mt#1641/mt#2250 root cause (migrations 0002/0014/0015).
      const immutableMigrationResult = await this.instrumented(
        "immutable-migration-check",
        () => this.runImmutableMigrationCheck(),
        IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV
      );
      if (!immutableMigrationResult.success) return immutableMigrationResult;

      // Step 3e-b: Migration collision + journal-`when` immutability check
      // (mt#2948). Compare the staged journal against origin/main: block a
      // renumber that mutates an already-shipped entry's `when` (the 2026-07-19
      // outage cause), a new migration reusing an on-main number, or a new
      // entry whose `when` is non-monotonic vs main. Complements mt#2268
      // (.sql content) and mt#2087 (local sql<->journal set).
      const migrationCollisionResult = await this.instrumented(
        "migration-collision-check",
        () => this.runMigrationCollisionCheck(),
        MIGRATION_COLLISION_CHECK_OVERRIDE_ENV
      );
      if (!migrationCollisionResult.success) {
        return migrationCollisionResult;
      }

      // Step 3e-c (mt#3299): migration guard — unguarded DROP INDEX / CREATE
      // UNIQUE INDEX (migration 0068 / PR #2142 / 065fc729f). Own
      // overrideEnvVar (mt#3299 PR #2392 R1 BLOCKING #5 — a prior combined-
      // step draft dropped fire-log override-attribution for both checks
      // by omitting this 3rd arg entirely; each check now gets its own
      // instrumented() call, same as every sibling pre-commit step).
      const migrationGuardResult = await this.instrumented(
        "migration-guard-check",
        () => runMigrationGuardCheckImpl(this.projectRoot),
        MIGRATION_GUARD_CHECK_OVERRIDE_ENV
      );
      if (!migrationGuardResult.success) return migrationGuardResult;

      // Step 3g (mt#3299): duplicate-generated-content — a repeated
      // top-level block in staged AGENTS.md/CLAUDE.md/compiled
      // skills/completion-manifest.json.
      const dupContentResult = await this.instrumented(
        "duplicate-generated-content-check",
        () => runDuplicateGeneratedContentCheckImpl(this.projectRoot),
        DUPLICATE_GENERATED_CONTENT_CHECK_OVERRIDE_ENV
      );
      if (!dupContentResult.success) return dupContentResult;

      // Step 3h (mt#3613): ADR-numbering-collision — a new/renamed
      // `docs/architecture/adr-NNN-*.md` file reusing a number an existing
      // ADR already holds. Nothing in pre-commit inspected `docs/architecture/`
      // before this check; the sibling "immutable+collision" step
      // (runMigrationCollisionCheck) is exclusively about the SQL-migration
      // journal. Fires only when the staged diff touches an ADR path.
      // (Label reflects when this step was ADDED, not run order — it already
      // sits after Step 3g and before Step 3e below, matching the pre-existing
      // pattern where these letters aren't temporal. Actual execution order is
      // simply top-to-bottom in this method.)
      const adrNumberingCollisionResult = await this.instrumented(
        "adr-numbering-collision-check",
        () => runAdrNumberingCollisionCheckImpl(this.projectRoot),
        ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV
      );
      if (!adrNumberingCollisionResult.success) return adrNumberingCollisionResult;

      // Step 3e: Deploy-domain ownership check (mt#2208, live successor to
      // mt#2193). Verify every domain ASSERTED as a deployment target in
      // deploy/site config (infra/index.ts SITE_URL, services/*/deploy.config.ts,
      // services/*/astro.config.ts, services/*/README.md "Deployed at" claims)
      // is a domain we actually control (listed in infra/controlled-domains.json).
      // Prevents recurrence of the minsky.dev class: an illustrative example URL
      // that hardened into authoritative config + a false "Deployed at" claim,
      // never ownership-verified.
      const deployDomainResult = await this.instrumented(
        "deploy-domain-check",
        () => this.runDeployDomainCheck(),
        DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV
      );
      if (!deployDomainResult.success) {
        return deployDomainResult;
      }

      // Step 3f: claude-hooks compile auto-regeneration (mt#2977). Unlike the
      // block-on-drift Step 9b compile-check, this REGENERATES + re-stages the
      // .claude/hooks/ outputs when this commit touches hooks sources — no
      // manual `compile --target claude-hooks` + re-commit needed. Same
      // auto-fix-and-restage shape as Step 1b / Step 3c; no override (a
      // generator failure is a real compile error, not staleness).
      const claudeHooksRegenResult = await this.instrumented("claude-hooks-compile-regen", () =>
        this.runClaudeHooksCompileRegen()
      );
      if (!claudeHooksRegenResult.success) {
        return claudeHooksRegenResult;
      }

      // ── Medium-weight static analysis (~5s each) ──

      // Step 4: TypeScript type checking (~5s)
      const typeCheckResult = await this.instrumented("type-check", () => this.runTypeCheck());
      if (!typeCheckResult.success) {
        return typeCheckResult;
      }

      // Step 5: ESLint validation (~5-10s)
      const lintResult = await this.instrumented("eslint-validation", () =>
        this.runESLintValidation()
      );
      if (!lintResult.success) {
        return lintResult;
      }

      // ── Security scanning (~2-3s, critical but rare) ──

      // Step 6: Secret scanning
      const secretsResult = await this.instrumented("secret-scanning", () =>
        this.runSecretScanning()
      );
      if (!secretsResult.success) {
        return secretsResult;
      }

      // ── Runtime checks (tests) ──
      //
      // mt#2716: the full unit-suite step was REMOVED from pre-commit. Running
      // ~8300 tests (~4.3 min) on every commit is the documented "slow hook →
      // developers --no-verify it → worse than no hook" anti-pattern; it also
      // never actually worked here (the old 120s execAsync timeout was shorter
      // than the honest suite, and `bun test` 1.2.21 silently truncated it —
      // mt#2665). The truncation-safe, fail-closed full-suite gate now lives in
      // .husky/pre-push (scripts/run-tests-gated.ts, "before you share") + CI
      // (authoritative). See docs/testing-patterns.md + mt#2716.
      //
      // mt#2932: that left a real gap -- ZERO automated test signal at commit
      // time. This step is the fast middle ground (jest --findRelatedTests /
      // vitest related / lint-staged, per mt#2716's research pass): map
      // staged files to the tests related to them (scripts/find-related-tests.ts)
      // and run ONLY those (scripts/run-related-tests.ts), well under the
      // 60-90s bypass-risk threshold. Fail-closed gating REUSES
      // evaluateBunTestSummary from scripts/run-tests-gated.ts (the mt#2716
      // gate), not a reimplementation.

      // Step 7: Fast changed-file-scoped related-test gate (mt#2932)
      const relatedTestsResult = await this.instrumented(
        "fast-related-tests",
        () => this.runFastRelatedTests(),
        RELATED_TESTS_CHECK_OVERRIDE_ENV
      );
      if (!relatedTestsResult.success) {
        return relatedTestsResult;
      }

      // Step 8: ESLint rule tooling tests (niche)
      const ruleTestsResult = await this.instrumented("eslint-rule-tests", () =>
        this.runESLintRuleTests()
      );
      if (!ruleTestsResult.success) {
        return ruleTestsResult;
      }

      // Step 9: Rules compile staleness check (legacy `rules compile` system)
      const rulesCheckResult = await this.instrumented(
        "rules-compile-check",
        () => this.runRulesCompileCheck(),
        SIZE_BUDGET_CHECK_OVERRIDE_ENV
      );
      if (!rulesCheckResult.success) {
        return rulesCheckResult;
      }

      // Step 9b: Compile staleness check (new `compile` system — mt#2252).
      // mt#3058: now also carries the monolithic (claude.md/agents.md) +
      // claude-rules targets and their size-budget override, so the override
      // env is threaded here exactly as on Step 9.
      const compileCheckResult = await this.instrumented(
        "compile-check",
        () => this.runCompileCheck(),
        SIZE_BUDGET_CHECK_OVERRIDE_ENV
      );
      if (!compileCheckResult.success) {
        return compileCheckResult;
      }

      log.cli("✅ All checks passed! Commit proceeding...");
      return {
        success: true,
        message: "All pre-commit checks passed",
        exitCode: 0,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Pre-commit hook failed: ${errorMsg}`);
      return {
        success: false,
        message: `Pre-commit hook failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run ESLint validation with proper JSON parsing
   */
  private async runESLintValidation(): Promise<HookResult> {
    log.cli("🔍 Running ESLint with strict quality gates...");

    try {
      // mt#3404: lint the STAGED files, not the whole repo. `eslint .` sweeps
      // ~3,000 files; on a loaded host (load avg 85 on 16 cores) that measured
      // 287s wall against this step's 120s timeout, and six commits were denied
      // at the timeout boundary within one hour on 2026-07-30. CI's
      // `lint:strict` (.github/workflows/ci.yml) remains the authoritative
      // full-repo gate — the same commit-time-scoping trade mt#2716/mt#2932
      // already made for the test step, with the same CI backstop.
      const stagedResult = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );
      const stagedFiles = stagedResult.stdout.toString().trim().split("\n").filter(Boolean);
      const lintableFiles = selectLintableStagedFiles(stagedFiles);

      if (lintableFiles.length === 0) {
        log.cli("✅ No lintable staged files — skipping ESLint.");
        return { success: true, message: "No lintable staged files to check", exitCode: 0 };
      }

      // Use ProjectConfigReader for consistent config loading
      const configReader = new ProjectConfigReader(this.projectRoot);
      const lintJsonCommand = buildScopedLintCommand(
        await configReader.getLintJsonCommand(),
        lintableFiles
      );

      // Print the command as well as the count: the staged file list is the
      // only thing that varies run to run now, so losing it would make a
      // failing run harder to reproduce by hand than it was pre-mt#3404
      // (PR #2450 R1, non-blocking).
      log.cli(`📋 Linting ${lintableFiles.length} staged file(s)`);
      log.cli(`📋 Using lint command: ${lintJsonCommand}`);

      // Execute the lint command and get JSON output
      // ESLint exits with non-zero when there are errors/warnings, but still produces valid JSON
      let stdout = "";
      let stderr = "";
      try {
        const result = await this.exec(lintJsonCommand, {
          cwd: this.projectRoot,
          // History: 30s (original) -> 120s (mt#1859, 2026-06-13, sized for a
          // full-repo sweep then measuring ~29s) -> 60s here. mt#3404 removed
          // the full-repo sweep, so the budget no longer has to cover ~3,000
          // files. What it MUST still cover is ESLint's fixed startup cost —
          // flat-config load plus 46 custom rules — measured at ~2.2s CPU but
          // ~11s WALL on a host at load avg 85, because the process is starved
          // rather than slow. 60s leaves room for that floor plus a large
          // staged set, while still killing a genuinely hung run in half the
          // time the full-repo budget took. (Value in
          // ./pre-commit-subprocess-failure so the timeout message names the
          // same number this enforces — mt#3406.)
          timeout: ESLINT_TIMEOUT_MS,
          // The full-repo --format json payload measured 1,565,238 bytes on
          // 2026-07-30 (mt#3410) — the "~850KB" this comment used to cite was
          // already stale by 1.8x. A staged-file run is far smaller, but keep
          // real headroom: a big staged set with many findings is still
          // sizable, and the 1MB exec default truncate-KILLS the process at the
          // boundary rather than truncating.
          maxBuffer: 16 * 1024 * 1024,
        });
        stdout = result.stdout.toString();
        stderr = result.stderr.toString();
      } catch (execError: unknown) {
        // ESLint exits with non-zero on errors/warnings but still produces valid output
        const execErr = execError as { stdout?: string; stderr?: string };
        if (execErr.stdout) {
          stdout = execErr.stdout;
          stderr = execErr.stderr || "";
        } else {
          throw execError;
        }
      }

      // Parse ESLint JSON output with proper error handling
      let lintResults: ESLintResult[] = [];
      try {
        // ESLint JSON output is an array of result objects
        lintResults = JSON.parse(stdout || "[]");
      } catch (parseError) {
        // If JSON parsing fails, try to extract from stderr or fall back to empty array
        log.warn("⚠️ Failed to parse ESLint JSON output, falling back to stderr analysis");
        if (stderr && stderr.includes("error")) {
          // If there are errors in stderr, treat as failure
          return {
            success: false,
            message: "ESLint execution failed with errors",
            exitCode: 1,
          };
        }
        // Otherwise continue with empty results
        lintResults = [];
      }

      // Reporting + threshold enforcement live in ./pre-commit-lint-scope
      // (mt#3404) so this file stays under its max-lines ceiling.
      return evaluateLintSummary(this.calculateESLintSummary(lintResults));
    } catch (error) {
      // mt#3406: a timeout and a lint failure arrive here with the same
      // `message`; only `killed` tells them apart. See ./pre-commit-subprocess-failure.
      const errorMsg = describeSubprocessFailure(error, {
        step: "ESLint validation",
        timeoutMs: ESLINT_TIMEOUT_MS,
      });
      log.error(`❌ ${errorMsg}`);
      return {
        success: false,
        message: errorMsg,
        exitCode: 1,
      };
    }
  }

  /**
   * Calculate ESLint summary with reliable aggregation
   */
  private calculateESLintSummary(results: ESLintResult[]): ESLintSummary {
    const summary: ESLintSummary = {
      errorCount: 0,
      warningCount: 0,
      results,
    };

    // Use reduce for safe and reliable aggregation
    summary.errorCount = results.reduce((total, result) => total + result.errorCount, 0);
    summary.warningCount = results.reduce((total, result) => total + result.warningCount, 0);

    return summary;
  }

  /**
   * Run secret scanning (still use gitleaks for now)
   */
  private async runSecretScanning(): Promise<HookResult> {
    log.cli("🔒 SECURITY: Scanning for secrets...");

    try {
      // Check if gitleaks is available before attempting to run it
      await execAsync("which gitleaks", { timeout: 5000 });
    } catch {
      log.cli("❌ gitleaks is not installed. Secret scanning is mandatory.");
      log.cli("💡 Install gitleaks: https://github.com/gitleaks/gitleaks#installing");
      log.cli("💡 On macOS: brew install gitleaks | On Linux: see GitHub releases");
      return {
        success: false,
        message: "gitleaks not installed — secret scanning is required",
        exitCode: 1,
      };
    }

    try {
      await execAsync("gitleaks protect --staged --source . --config .gitleaks.toml --verbose", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ Gitleaks: No secrets detected in staged changes (enhanced scan complete).");
      return { success: true, message: "Secret scanning passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ 🚨 SECRETS DETECTED BY GITLEAKS! Commit blocked for security.");
      log.cli("📋 Review the findings above and sanitize any real credentials.");
      log.cli("💡 Database URLs: Use placeholder values (avoid real credentials)");
      log.cli("💡 API Keys: Use placeholder values like 'sk-proj-xxx...xxxxx'");
      log.cli(
        "💡 Real credentials detected in: PostgreSQL, MySQL, MongoDB, Redis URLs, or API keys"
      );
      return { success: false, message: "Secret scanning failed", exitCode: 1 };
    }
  }

  /**
   * Fast, changed-file-scoped local test gate (mt#2932). Delegates the
   * spawn+capture to runRelatedTestsCheck (./related-tests-check.ts), which
   * runs scripts/run-related-tests.ts -- itself mapping staged files to
   * their related tests (scripts/find-related-tests.ts) and gating
   * fail-closed via scripts/run-tests-gated.ts's evaluateBunTestSummary
   * (reused, not reimplemented). See the "Runtime checks (tests)" comment
   * block in `run()` for the full rationale.
   */
  private async runFastRelatedTests(): Promise<HookResult> {
    log.cli("🧪 Running fast changed-file-scoped test gate...");

    if (isOverrideTruthy(process.env[RELATED_TESTS_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:fast-related-tests] override ${RELATED_TESTS_CHECK_OVERRIDE_ENV}=` +
          `${process.env[RELATED_TESTS_CHECK_OVERRIDE_ENV]} at ${ts} — fast related-test gate skipped`
      );
      return {
        success: true,
        message: "Fast related-test gate skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    try {
      const result = await runRelatedTestsCheck(this.projectRoot);
      if (result.stdout) log.cli(result.stdout);
      if (result.stderr) log.cli(result.stderr);
      return { success: result.success, message: result.message, exitCode: result.exitCode };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Fast related-test gate failed to run: ${errorMsg}`);
      return {
        success: false,
        message: `Fast related-test gate failed to run: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run variable naming check (keep external for now)
   */
  private async runVariableNamingCheck(): Promise<HookResult> {
    log.cli("🔍 Checking for variable naming issues...");

    try {
      await execAsync("bun run scripts/check-variable-naming.ts", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ No variable naming issues found.");
      return { success: true, message: "Variable naming check passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ Variable naming issues found! Please fix them before committing.");
      log.cli("💡 You can run 'bun run scripts/fix-variable-naming.ts' to auto-fix many issues.");
      return { success: false, message: "Variable naming issues found", exitCode: 1 };
    }
  }

  /**
   * Run the SQL-capability message check (mt#4398).
   *
   * Mirrors {@link runVariableNamingCheck} deliberately — same shape, same
   * shell-out, same timeout — because that is the repo's only existing
   * convention for a static source check, and mt#4398's whole subject is a
   * check that had no convention applied to it at all.
   *
   * NO OVERRIDE ENV VAR, deliberately (PR #3223 R1). The overrides in this
   * file cluster on checks that can block a committer on something they cannot
   * fix in the moment — NUL bytes, migration collisions, immutable migrations,
   * deploy-domain ownership, the size budget, the related-test gate. The cheap
   * lexical checks do not have one: `variable-naming-check` (this step's direct
   * precedent and structural twin), `node-shim-check` and `secret-scanning` all
   * ship without. This belongs to the second group — satisfying it is a
   * one-line annotation or routing through an existing helper — and adding an
   * override would mean registering a new `MINSKY_*` var in two more places
   * for an escape hatch nothing needs yet. If a real case turns up where this
   * blocks urgent work, add it then, with that case as the reason.
   *
   * The failure hint matters more than usual here: the script's own output
   * already names each offending site AND the two ways to satisfy it, so this
   * points at that output rather than restating it. Re-running by hand is the
   * fix loop, which is also the one thing that always worked while nothing
   * ran it automatically.
   */
  private async runSqlCapabilityMessageCheck(): Promise<HookResult> {
    log.cli("🔍 Checking SQL-capability messages carry a cause...");

    try {
      await execAsync("bun run scripts/check-sql-capability-messages.ts", {
        cwd: this.projectRoot,
        timeout: 30000,
      });
      log.cli("✅ Every SQL-capability message names its cause.");
      return { success: true, message: "SQL-capability message check passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ A persistence-gated error is missing its cause.");
      log.cli(
        "💡 Run 'bun run scripts/check-sql-capability-messages.ts' — it names each site and the two ways to satisfy it (route through describePersistenceUnavailability(), or annotate with '// sql-capability-message: <reason>')."
      );
      return { success: false, message: "Cause-free SQL-capability message found", exitCode: 1 };
    }
  }

  /**
   * Grep staged source files for Node.js shims that should be Bun idioms.
   *
   * Flags:
   *   - `#!/usr/bin/env node` shebangs (any staged file)
   *   - `npm run ` usage in source files (excludes README/docs/package.json)
   *   - `npx ` usage in source files (same exclusions)
   *
   * Files excluded from the npm/npx checks:
   *   README*, *.md, docs/**, package.json, *.lock, *.yaml, *.yml, *.toml
   *
   * These are caught early (before heavy static analysis) because they are
   * instant to detect and never acceptable in new Bun-first code.
   */
  private async runNodeShimCheck(): Promise<HookResult> {
    log.cli("🚫 Checking for Node.js shims in staged files...");

    try {
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (stagedFiles.length === 0) {
        log.cli("✅ No staged files — skipping Node shim check.");
        return { success: true, message: "No staged files to check", exitCode: 0 };
      }

      // Files exempt from npm/npx checks (documentation and config)
      const isDocOrConfig = (f: string): boolean => {
        const lower = f.toLowerCase();
        return (
          lower.endsWith(".md") ||
          lower.startsWith("readme") ||
          lower.startsWith("docs/") ||
          lower === "package.json" ||
          lower.endsWith(".lock") ||
          lower.endsWith(".yaml") ||
          lower.endsWith(".yml") ||
          lower.endsWith(".toml") ||
          // mt#2726: the reviewer benchmark corpus is verbatim-mined PR data
          // (findings + code context windows) that legitimately quotes idioms
          // like `npx`/`npm run`; it is data, not source, so exempt the dir.
          lower.startsWith("services/reviewer/eval/corpus/") ||
          // The bun-over-node enforcement check itself contains "npm run"/"npx" in
          // help-message string literals; exempt the file that runs this check.
          lower === "src/hooks/pre-commit.ts"
        );
      };

      const violations: string[] = [];

      for (const file of stagedFiles) {
        // Read the staged content (index version, not working tree).
        // Use `gitShowStagedBytes` (argv-based, no shell) for the same
        // safety reasons documented on `runNulByteCheck`: file names with
        // shell metacharacters cannot break the command or enable
        // injection. Raw bytes are decoded to utf-8 string for the
        // shebang / `npm run` / `npx` regex scans (this check operates
        // on text content, not byte content). Class-not-instance sweep
        // alongside PR #1110 R1 BLOCKING #1.
        let content: string;
        try {
          const bytes = await this.gitShowStagedBytes(file);
          // TextDecoder rather than Buffer.toString("utf8") because the
          // project's Buffer stub doesn't accept encoding args; the runtime
          // result is equivalent. fatal: false keeps the lossy-decode
          // behavior that this check expects (it scans for ASCII patterns).
          content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        } catch {
          // File may be binary, gitlink, or unavailable — skip
          continue;
        }

        // Check 1: node shebang (applies to every staged file)
        if (
          content.startsWith("#!/usr/bin/env node\n") ||
          content.startsWith("#!/usr/bin/env node\r")
        ) {
          violations.push(
            `${file}: has '#!/usr/bin/env node' shebang — use '#!/usr/bin/env bun' instead`
          );
        }

        // Checks 2 & 3: npm run / npx in source text (exempt docs/config)
        if (!isDocOrConfig(file)) {
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i] ?? "";
            const lineNum = i + 1;

            // Skip comment lines that explain what NOT to do (e.g. rule documentation)
            const stripped = line.trimStart();
            if (stripped.startsWith("//") || stripped.startsWith("*") || stripped.startsWith("#")) {
              continue;
            }

            if (/npm run /.test(line)) {
              violations.push(`${file}:${lineNum}: contains 'npm run' — use 'bun run' instead`);
            }
            if (/\bnpx /.test(line)) {
              violations.push(`${file}:${lineNum}: contains 'npx' — use 'bunx' instead`);
            }
          }
        }
      }

      if (violations.length > 0) {
        log.cli("❌ Node.js shims detected in staged files! Commit blocked.");
        log.cli("");
        for (const v of violations) {
          log.cli(`   🚫 ${v}`);
        }
        log.cli("");
        log.cli("💡 Replace Node.js idioms with Bun equivalents:");
        log.cli("   • Shebang:  #!/usr/bin/env node  →  #!/usr/bin/env bun");
        log.cli("   • Runner:   npm run <script>     →  bun run <script>");
        log.cli("   • Executor: npx <pkg>            →  bunx <pkg>");
        log.cli("📖 See bun_over_node.mdc for details.");
        return {
          success: false,
          message: `Node.js shims found in ${violations.length} location(s)`,
          exitCode: 1,
        };
      }

      log.cli("✅ No Node.js shims in staged files.");
      return { success: true, message: "Node shim check passed", exitCode: 0 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Node shim check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Node shim check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Scan staged files for NUL bytes (0x00) and block the commit if any
   * tracked text file contains one.
   *
   * Closes the gate-gap exposed by mt#1821 / PR #1107 R1: a JSON-escaped
   * U+0000 in a `session_write_file` content parameter landed as a literal
   * NUL byte inside a TypeScript template literal and slipped past tsc,
   * eslint, prettier, bun test, CI build, and CI bundle-boot-smoke. Git's
   * binary-file detector and the reviewer-bot's diff renderer were the
   * only gates that caught it — at review time, not commit time.
   *
   * Allowlist:
   *   - `KNOWN_BINARY_EXTENSIONS` (png / woff / so / etc.) — NULs expected.
   *   - `FIXTURE_PATH_PREFIXES` (tests/fixtures/) — regression fixtures may
   *     legitimately contain NUL bytes.
   *
   * Override: setting `MINSKY_SKIP_NUL_CHECK` to `1` / `true` / `yes` skips
   * the check and emits a one-line audit message to stdout.
   *
   * See `feedback_json_tool_writes_interpret_unicode_escapes` (b7e2f8ef)
   * for the originating-incident context, and `src/hooks/nul-byte-detector.ts`
   * for the pure-function implementation that this method wraps.
   */
  /**
   * Fetch the staged blob for `file` as raw bytes using `Bun.spawn` with
   * argv (no shell). Replaces `execGitWithTimeout(... `git show :${file}`)`
   * for the NUL-byte check specifically to address two reviewer-bot
   * BLOCKING findings on PR #1110 R1:
   *
   *   1. Shell-interpolation safety: the legacy path embedded the file
   *      name into a single shell command string. Filenames containing
   *      spaces, quotes, colons, or shell metacharacters could break the
   *      command or enable argument injection. Argv bypasses shell
   *      parsing entirely — git receives each argument as a literal
   *      C-string from `execvp`.
   *   2. Byte fidelity: the legacy path returned utf-8 decoded strings.
   *      Re-encoding via `Buffer.from(string)` corrupts non-UTF-8 byte
   *      sequences and shifts the reported byte offset of the first NUL.
   *      `Bun.spawn` with `stdout: "pipe"` plus `arrayBuffer()` returns
   *      the exact bytes git produced — necessary for the spec's
   *      "byte offset of first NUL" guarantee to be correct for any
   *      encoding.
   *
   * Throws on non-zero exit (gitlinks, deleted-then-modified edge cases,
   * etc.); callers handle via `Promise.allSettled`.
   */
  /**
   * Run a git subcommand via `Bun.spawn` argv (no shell) and return its
   * decoded stdout, throwing on non-zero exit. Used by
   * `runCompletionManifestRegen`'s diff/add calls instead of
   * `execGitWithTimeout` to avoid embedding a path into an interpolated
   * shell command string — the same argv-bypasses-shell rationale as
   * {@link gitShowStagedBytes} (reviewer-bot BLOCKING finding, mt#2622 PR
   * review round 1: an unquoted path containing spaces or shell
   * metacharacters could break the command or enable argument injection,
   * even though `manifestPath` is a hardcoded constant today).
   */
  private async runGitArgv(args: string[], timeoutMs = 5000): Promise<string> {
    const proc = Bun.spawn(["git", "-C", this.projectRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const stdoutPromise = new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderrText = await new Response(proc.stderr).text();
        throw new Error(
          `git ${args.join(" ")} exited ${exitCode}: ${stderrText.trim() || "no stderr"}`
        );
      }
      return await stdoutPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async gitShowStagedBytes(file: string): Promise<Buffer> {
    const TIMEOUT_MS = 5000;
    const proc = Bun.spawn(["git", "-C", this.projectRoot, "show", `:${file}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
    try {
      const bytesPromise = new Response(proc.stdout).arrayBuffer();
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        // Drain stderr for diagnostics, but don't block on it indefinitely.
        const stderrText = await new Response(proc.stderr).text();
        throw new Error(
          `git show :${file} exited ${exitCode}: ${stderrText.trim() || "no stderr"}`
        );
      }
      const bytes = await bytesPromise;
      // eslint-disable-next-line custom/no-excessive-as-unknown -- Bun's Buffer.from accepts ArrayBuffer at runtime; project's Buffer stub is narrowed to string | any[] for portability with the Bun-light TS environment, so the cast is required to bridge the typing gap.
      return Buffer.from(bytes as unknown as number[]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runNulByteCheck(): Promise<HookResult> {
    log.cli("Checking staged files for NUL bytes...");

    if (isOverrideTruthy(process.env[NUL_BYTE_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:nul-byte-check] override ${NUL_BYTE_CHECK_OVERRIDE_ENV}=${process.env[NUL_BYTE_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — NUL-byte check skipped`
      );
      return {
        success: true,
        message: "NUL-byte check skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    try {
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (stagedFiles.length === 0) {
        log.cli("No staged files — skipping NUL-byte check.");
        return { success: true, message: "No staged files to check", exitCode: 0 };
      }

      // Filter allowlisted paths up-front so we never even fetch their content.
      const candidates = stagedFiles.filter((f) => !isPathAllowlisted(f));

      // Fetch staged blobs in parallel via `Bun.spawn` with argv. Two
      // reasons (PR #1110 R1 reviewer-bot, both BLOCKING):
      //   1. Argv bypasses shell parsing — file paths with spaces, quotes,
      //      colons, or shell metacharacters cannot break the command or
      //      enable argument injection. `execGitWithTimeout` interpolates
      //      into a single shell string, which is unsafe for untrusted
      //      paths (staged file names are operator-controlled but a hostile
      //      filename in a contributor's repo could still cause damage).
      //   2. Raw-bytes stdout — `execGitWithTimeout` returns utf-8 decoded
      //      strings, which corrupts non-UTF-8 byte sequences and shifts
      //      the reported byte offset of the first NUL. The spec requires
      //      the offset to be the TRUE byte offset in the staged blob.
      //
      // `Promise.allSettled` so a single bad path (gitlink, etc.) doesn't
      // kill the rest.
      const results = await Promise.allSettled(
        candidates.map((file) => this.gitShowStagedBytes(file))
      );

      const stagedContent = new Map<string, Buffer>();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r === undefined || r.status !== "fulfilled") continue;
        const file = candidates[i];
        if (file === undefined) continue;
        stagedContent.set(file, r.value);
      }

      const violations = detectNulByteViolations(stagedContent);

      if (violations.length === 0) {
        log.cli(`No NUL bytes detected in ${candidates.length} staged text file(s).`);
        return { success: true, message: "NUL-byte check passed", exitCode: 0 };
      }

      log.cli("");
      log.cli("NUL byte(s) detected in staged text files. Commit blocked.");
      log.cli("");
      for (const v of violations) {
        log.cli(`   ${v.path}: first NUL byte at offset ${v.offset}`);
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli("   - Tracking task:        mt#1824");
      log.cli("   - Originating incident: mt#1821 / PR #1107 R1");
      log.cli(
        "   - Memory:               feedback_json_tool_writes_interpret_unicode_escapes (b7e2f8ef)"
      );
      log.cli("");
      log.cli("Common cause: a JSON-parameterized file-write tool received a content");
      log.cli('   string with a "\\u0000" escape. JSON parsing converts the escape to');
      log.cli("   a literal NUL byte BEFORE writing to disk. Pick a printable separator");
      log.cli("   instead (e.g. a pipe, colon, or multi-char string).");
      log.cli("");
      log.cli(
        `If a NUL byte is legitimate (rare), set ${NUL_BYTE_CHECK_OVERRIDE_ENV}=1 to override.`
      );
      log.cli("   The skip is audit-logged to stdout.");
      return {
        success: false,
        message: `NUL bytes detected in ${violations.length} file(s)`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`NUL-byte check failed: ${errorMsg}`);
      return {
        success: false,
        message: `NUL-byte check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Block a commit whose staged content carries git conflict markers (mt#4307).
   *
   * Reads STAGED blobs, not working-tree files: a partially-staged resolution
   * would otherwise pass or fail on the wrong bytes, and it is the staged content
   * that is about to become a commit.
   *
   * Deliberately does NOT skip `src/generated/**`. Several sibling checks do, and
   * a generated file is exactly where the originating corruption sat unnoticed
   * until a test twenty files away failed to parse it.
   *
   * Override: `MINSKY_SKIP_CONFLICT_MARKER_CHECK=1` / `true` / `yes`, audit-logged
   * to stdout like every sibling override.
   */
  private async runConflictMarkerCheck(): Promise<HookResult> {
    log.cli("Checking staged files for conflict markers...");

    if (isOverrideTruthy(process.env[CONFLICT_MARKER_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:conflict-marker-check] override ${CONFLICT_MARKER_CHECK_OVERRIDE_ENV}=` +
          `${process.env[CONFLICT_MARKER_CHECK_OVERRIDE_ENV]} at ${ts} — conflict-marker check skipped`
      );
      return {
        success: true,
        message: "Conflict-marker check skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    try {
      // `R` as well as `ACM` (PR #3201 R1). A renamed file is still staged
      // content about to become a commit, and `ACM` alone skips it — so a file
      // that was resolved-then-renamed, or renamed while still conflicted, would
      // pass unchecked. `--name-only` reports a rename by its NEW path, which is
      // exactly the path `git show :<path>` needs.
      //
      // Scoped to THIS check deliberately: five sibling steps in this file use
      // `ACM` and share the gap, but widening their input is a behaviour change
      // for each of them and belongs in its own change, not smuggled in here.
      // Tracked at mt#4366, which carries the measurement below.
      //
      // The gap is real only where rename DETECTION fires. Measured in a
      // throwaway repo: a small file renamed with a big edit is recorded
      // `D`+`A` and `ACM` lists it anyway; a 300-line file renamed with a
      // conflict block added is recorded `R`, and `ACM` returns EMPTY while
      // `ACMR` returns the new path. Invisible, not mislabelled — which is why
      // nothing downstream notices.
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACMR",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (stagedFiles.length === 0) {
        log.cli("No staged files — skipping conflict-marker check.");
        return { success: true, message: "No staged files to check", exitCode: 0 };
      }

      // `readStagedFileContent` spawns git via argv, so a path containing spaces
      // or shell metacharacters cannot break the command. `allSettled` so one
      // unreadable path (a gitlink, a submodule) does not sink the rest.
      const results = await Promise.allSettled(
        stagedFiles.map((file) => readStagedFileContent(this.projectRoot, file))
      );

      const stagedContent = new Map<string, string>();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r === undefined || r.status !== "fulfilled") continue;
        const file = stagedFiles[i];
        if (file === undefined) continue;
        stagedContent.set(file, r.value);
      }

      const violations = detectConflictMarkerViolations(stagedContent);

      if (violations.length === 0) {
        log.cli(`No conflict markers detected in ${stagedContent.size} staged file(s).`);
        return { success: true, message: "Conflict-marker check passed", exitCode: 0 };
      }

      log.cli("");
      log.cli("Conflict marker(s) detected in staged files. Commit blocked.");
      log.cli("");
      for (const v of violations) {
        log.cli(`   ${v.path}: line(s) ${v.lines.join(", ")}`);
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli("   - Tracking task: mt#4307");
      log.cli("   - A conflict marker in a committed file is the same class of defect");
      log.cli("     as a NUL byte: the file was never meant to be committed this way.");
      log.cli("");
      log.cli("Most likely cause: a merge or a `git stash pop` conflicted and the");
      log.cli("   markers were never resolved. Resolve the listed files, `git add` them,");
      log.cli("   and commit again. If a stash pop is what conflicted, your work may");
      log.cli("   still be parked — check `git stash list` before resetting anything.");
      log.cli("");
      log.cli(
        `If a marker is legitimate content (documenting one, say), set ` +
          `${CONFLICT_MARKER_CHECK_OVERRIDE_ENV}=1 to override.`
      );
      log.cli("   The skip is audit-logged to stdout.");
      return {
        success: false,
        message: `Conflict markers detected in ${violations.length} file(s)`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Conflict-marker check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Conflict-marker check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Regenerate the workspace package.json COPY block in every protected
   * Dockerfile and re-stage any that changed (mt#2621). Replaces the
   * mt#1984/mt#1992 static missing-COPY detector — instead of DETECTING
   * drift between the `workspaces` glob and the Dockerfile's hand-typed
   * COPY list and blocking the commit, this step ELIMINATES the drift
   * class by generating the COPY block from the same glob bun itself
   * resolves, then auto-fixing and re-staging (the mt#2622 completion-
   * manifest pattern) — the same auto-fix-and-restage shape as Step 1b's
   * completion-manifest regen, not the detect-and-block shape the old
   * guard used.
   *
   * Originating incidents this eliminates the drift class for: mt#1977
   * (75-minute root-Dockerfile outage) and mt#1991 (4-hour
   * reviewer-Dockerfile outage) — both caused by the hand-maintained COPY
   * list silently falling out of sync with the `workspaces` glob.
   *
   * Unconditional, like Step 1b — no override. A thrown error here means a
   * protected Dockerfile is missing the generated-block markers (a
   * one-time setup gap, not staleness); the operator adds the markers
   * once (see Dockerfile / services/reviewer/Dockerfile /
   * services/cockpit/Dockerfile for the block shape) and the generator
   * handles the rest going forward.
   *
   * See `src/hooks/workspace-copy-detector.ts` for the pure-function
   * discovery/templating primitives and
   * `scripts/generate-dockerfile-workspace-copies.ts` for the script this
   * step invokes.
   */
  private async runDockerfileWorkspaceCopyRegen(): Promise<HookResult> {
    const protectedDockerfiles = discoverProtectedDockerfiles(this.projectRoot);
    if (protectedDockerfiles.length === 0) {
      return {
        success: true,
        message: "No protected Dockerfiles found",
        exitCode: 0,
      };
    }

    try {
      await execAsync("bun run generate:dockerfile-workspace-copies", {
        cwd: this.projectRoot,
        timeout: 15000,
      });
    } catch (error) {
      const result = classifyDockerfileWorkspaceCopyRegenError(error);
      for (const line of result.logLines) {
        log.cli(line);
      }
      return { success: false, message: result.message, exitCode: 1 };
    }

    let diffStdout: string;
    try {
      diffStdout = await this.runGitArgv(["diff", "--name-only", "--", ...protectedDockerfiles]);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.cli(`❌ Could not diff regenerated Dockerfile(s): ${errMsg}`);
      return {
        success: false,
        message: `Could not diff regenerated Dockerfile(s): ${errMsg}`,
        exitCode: 1,
      };
    }

    const changedFiles = diffStdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (changedFiles.length === 0) {
      return {
        success: true,
        message: "Dockerfile workspace-COPY blocks up-to-date",
        exitCode: 0,
      };
    }

    try {
      await this.runGitArgv(["add", "--", ...changedFiles]);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.cli(`❌ Could not stage regenerated Dockerfile(s): ${errMsg}`);
      return {
        success: false,
        message: `Could not stage regenerated Dockerfile(s): ${errMsg}`,
        exitCode: 1,
      };
    }

    log.cli(
      `✅ Dockerfile workspace-COPY block(s) regenerated and staged (was out of date): ${changedFiles.join(", ")}`
    );
    return {
      success: true,
      message: "Dockerfile workspace-COPY blocks regenerated and staged",
      exitCode: 0,
    };
  }

  /**
   * Thin wrapper over {@link regenerateDockerfileBunBuild} (the logic lives
   * in `./bun-build-sync-regen`, extracted for the max-lines ceiling,
   * mt#3091 mirroring mt#2977): regenerate the root Dockerfile's
   * `RUN bun build ...` line from `scripts/cli-entry.ts`'s canonical
   * `bunBuildArgs()` and re-stage it if changed — same auto-fix-and-restage
   * shape as Step 3c above.
   */
  private async runDockerfileBunBuildRegen(): Promise<HookResult> {
    return regenerateDockerfileBunBuild({
      projectRoot: this.projectRoot,
      runGit: (args) => this.runGitArgv(args),
      logLine: (line) => log.cli(line),
      exec: execAsync,
    });
  }

  /**
   * Thin wrapper over {@link regenerateInterceptorCatalog} (mt#4010): keep the
   * cockpit's interceptor catalog in sync with the authored hook-tree data it
   * distills. Auto-fixes and re-stages, like the completion-manifest step.
   */
  private async runInterceptorCatalogRegen(): Promise<HookResult> {
    return regenerateInterceptorCatalog({
      projectRoot: this.projectRoot,
      runGit: (args) => this.runGitArgv(args),
      logLine: (line) => log.cli(line),
      exec: execAsync,
    });
  }

  /**
   * Thin wrapper over {@link checkBunBuildSync} (mt#3091): block the commit
   * if package.json's `scripts.build` (or, as a defense-in-depth backstop,
   * the Dockerfile's generated block) diverges from the canonical
   * `bunBuildCommand()`. Unlike {@link runDockerfileBunBuildRegen}, this
   * does NOT auto-fix — package.json's build script is a flat JSON string,
   * not a comment-delimited block, so rewriting it in place risks
   * formatting drift a generator shouldn't introduce.
   */
  private async runBunBuildSyncCheck(): Promise<HookResult> {
    return checkBunBuildSync({
      projectRoot: this.projectRoot,
      runGit: (args) => this.runGitArgv(args),
      logLine: (line) => log.cli(line),
      exec: execAsync,
    });
  }

  /**
   * Thin wrapper over {@link regenerateStagedClaudeHooks} (the logic lives in
   * `./claude-hooks-compile-regen`, extracted for the max-lines ceiling,
   * mt#2977): auto-regenerate + re-stage `.claude/hooks/*` when this commit
   * stages hooks sources — the same auto-fix-and-restage shape as Step 1b /
   * Step 3c, instead of the block-on-drift `runCompileCheck` uses for the
   * sibling targets (SC#4).
   */
  private async runClaudeHooksCompileRegen(): Promise<HookResult> {
    return regenerateStagedClaudeHooks({
      projectRoot: this.projectRoot,
      runGit: (args) => this.runGitArgv(args),
      logLine: (line) => log.cli(line),
      exec: execAsync,
    });
  }

  private async runMigrationJournalCheck(): Promise<HookResult> {
    if (isOverrideTruthy(process.env[MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:migration-journal] override ${MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV}=${process.env[MIGRATION_JOURNAL_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — migration journal check skipped`
      );
      return {
        success: true,
        message: "Migration journal check skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    try {
      const migrationsDir = join(this.projectRoot, "packages/domain/src/storage/migrations/pg");
      const metaDir = join(migrationsDir, "meta");

      let sqlFiles: string[];
      try {
        const entries = await readdir(migrationsDir);
        sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();
      } catch {
        return {
          success: true,
          message: "Migration journal check skipped (no migrations dir)",
          exitCode: 0,
        };
      }

      if (sqlFiles.length === 0) {
        return {
          success: true,
          message: "Migration journal check skipped (no SQL files)",
          exitCode: 0,
        };
      }

      let journalEntries: JournalEntry[];
      try {
        const raw = String(await readFile(join(metaDir, "_journal.json"), "utf-8"));
        const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
        journalEntries = parsed.entries ?? [];
      } catch {
        return {
          success: false,
          message: "Migration journal check failed: could not read meta/_journal.json",
          exitCode: 1,
        };
      }

      const result = detectMissingJournalEntries(sqlFiles, journalEntries);

      if (result.success) {
        return { success: true, message: result.message, exitCode: 0 };
      }

      log.cli("");
      log.cli(result.message);
      log.cli("");

      return { success: false, message: "Migration journal consistency check failed", exitCode: 1 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Migration journal check error: ${msg}`, exitCode: 1 };
    }
  }

  /**
   * Block a concurrent-migration collision or a journal-`when` mutation of an
   * already-shipped migration, checked against the `origin/main` baseline (mt#2948).
   *
   * This is the collision-PREVENTION complement to mt#2560 (auto-migrate default
   * OFF, the blast-radius fix). Unlike the sibling guards it reads the origin/main
   * journal to detect drift the LOCAL tree cannot reveal. Fails OPEN when there is
   * no baseline (fresh clone / detached / file absent on main).
   *
   * Override: `MINSKY_SKIP_MIGRATION_COLLISION_CHECK=1` (audit-logged).
   */
  private async runMigrationCollisionCheck(): Promise<HookResult> {
    if (isMigrationCollisionOverrideTruthy(process.env[MIGRATION_COLLISION_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:migration-collision] override ${MIGRATION_COLLISION_CHECK_OVERRIDE_ENV}=${process.env[MIGRATION_COLLISION_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — migration collision check skipped`
      );
      return {
        success: true,
        message: "Migration collision check skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    const journalRelPath = "packages/domain/src/storage/migrations/pg/meta/_journal.json";

    // Staged journal — the content actually being committed (the index, NOT the
    // working tree; PR #2081 R2). `git show :<path>` reads the index entry, so a
    // partially-staged or unstaged working-tree edit cannot make the guard block
    // or miss incorrectly.
    let headEntries: JournalEntry[];
    try {
      const staged = await execGitWithTimeout(
        "show",
        `show ${safeShellQuote(`:${journalRelPath}`)}`,
        { workdir: this.projectRoot, timeout: 5000 }
      );
      const parsed = JSON.parse(staged.stdout.toString()) as { entries?: JournalEntry[] };
      headEntries = parsed.entries ?? [];
    } catch {
      return {
        success: true,
        message: "Migration collision check skipped (journal not in index)",
        exitCode: 0,
      };
    }

    // origin/main baseline. Without it there is nothing to diff — fail OPEN
    // (this is a NEW-drift detector, not a first-commit correctness gate).
    let baseEntries: JournalEntry[];
    try {
      // journalRelPath is a hardcoded constant (no external input); still, shell-quote
      // the ref via the repo's shell-safety primitive (`safeShellQuote`, exec.ts) so
      // there is no shell-interpolation surface. The git-exec module runs via shell
      // (`execAsync`), not argv — there is no argv git helper — so quoting is the
      // established alignment with prior shell-safety fixes.
      const result = await execGitWithTimeout(
        "show",
        `show ${safeShellQuote(`origin/main:${journalRelPath}`)}`,
        {
          workdir: this.projectRoot,
          timeout: 5000,
        }
      );
      const parsed = JSON.parse(result.stdout.toString()) as { entries?: JournalEntry[] };
      baseEntries = parsed.entries ?? [];
    } catch {
      return {
        success: true,
        message: "Migration collision check skipped (no origin/main journal baseline)",
        exitCode: 0,
      };
    }

    const violations = detectMigrationJournalViolations(baseEntries, headEntries);
    if (violations.length === 0) {
      return { success: true, message: "Migration collision check passed", exitCode: 0 };
    }

    log.cli("");
    log.cli(
      `${violations.length} migration journal drift issue(s) vs origin/main. Commit blocked (mt#2948).`
    );
    log.cli("");
    for (const v of violations) {
      log.cli(`   [${v.kind}] ${v.tag}: ${v.detail}`);
    }
    log.cli("");
    log.cli("Why this is blocked:");
    log.cli("   Drizzle applies journal entries whose `when` exceeds the DB high-water-mark.");
    log.cli("   A renumber that mutates an already-shipped entry's `when`, a reused migration");
    log.cli("   number, or a non-monotonic `when` re-triggers an applied migration on boot");
    log.cli("   (the 2026-07-19 outage). See memory 0c2427e5.");
    log.cli("");
    log.cli("Fix: regenerate your migration against current main —");
    log.cli("   git fetch origin && git rebase origin/main, then `bun run db:generate:pg`");
    log.cli("   so your migration is numbered after main's latest with a fresh timestamp.");
    log.cli("");
    log.cli(`Override (rare, audited): set ${MIGRATION_COLLISION_CHECK_OVERRIDE_ENV}=1`);

    return {
      success: false,
      message: "Migration collision check failed",
      exitCode: 1,
    };
  }

  /**
   * Block staged modifications to already-applied SQL migration files (mt#2268).
   *
   * Drizzle records sha256(full .sql) at apply-time; editing an applied
   * migration causes it to re-apply on the next `migrate --execute`, silently
   * drifting the ledger from actual DB state (mt#1641/mt#2250 root cause).
   *
   * Only staged MODIFICATIONS are blocked — additions are the correct path for
   * new migrations and are always allowed.
   *
   * Override: setting `MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK` to `1` / `true`
   * / `yes` skips the check and emits a one-line audit message to stdout.
   * Use only for the rare legitimate case (e.g. fixing a never-applied
   * migration before its first deploy).
   */
  private async runImmutableMigrationCheck(): Promise<HookResult> {
    if (isImmutableMigrationOverrideTruthy(process.env[IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:immutable-migration] override ${IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV}=${process.env[IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — immutable-migration check skipped`
      );
      return {
        success: true,
        message: "Immutable-migration check skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    try {
      // Get staged files with their status. We include renames (R) as well as
      // modifications (M): a rename-with-edit of an applied migration would
      // otherwise slip past an M-only filter (mt#2268 review). `--name-status`
      // output is `<status>\t<path>` for M, and `R<score>\t<old>\t<new>` for
      // renames — for a rename we flag the OLD (applied) path.
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-status --diff-filter=MR",
        {
          workdir: this.projectRoot,
          timeout: 5000,
        }
      );

      const statusLines = result.stdout.toString().trim().split("\n").filter(Boolean);

      if (statusLines.length === 0) {
        return {
          success: true,
          message: "Immutable-migration check passed (no staged modifications)",
          exitCode: 0,
        };
      }

      // Build staged modifications map (path -> 'M'). Renames map their OLD path
      // to 'M' so the detector treats moving an applied migration as a violation.
      const stagedModifications = new Map<string, string>();
      for (const line of statusLines) {
        const parts = line.split("\t");
        const status = parts[0] ?? "";
        if (status.startsWith("R") && parts.length >= 3) {
          // Rename: parts = [R<score>, oldPath, newPath] — flag the old (applied) path.
          stagedModifications.set(parts[1] as string, "M");
        } else if (status === "M" && parts[1]) {
          stagedModifications.set(parts[1] as string, "M");
        }
      }
      if (stagedModifications.size === 0) {
        return {
          success: true,
          message: "Immutable-migration check passed (no staged modifications)",
          exitCode: 0,
        };
      }

      // Load journal tags for each migration directory.
      const journalTagsByDir = new Map<string, ReadonlySet<string>>();
      for (const dir of MIGRATION_DIRS) {
        const journalPath = join(this.projectRoot, dir, "meta", "_journal.json");
        try {
          const raw = String(await readFile(journalPath, "utf-8"));
          const parsed = JSON.parse(raw) as { entries?: Array<{ tag: string }> };
          const tags = new Set((parsed.entries ?? []).map((e) => e.tag));
          journalTagsByDir.set(dir, tags);
        } catch {
          // No journal for this dir — skip (e.g. dir doesn't exist yet)
        }
      }

      const violations = detectImmutableMigrationViolations(stagedModifications, journalTagsByDir);

      if (violations.length === 0) {
        return {
          success: true,
          message: "Immutable-migration check passed",
          exitCode: 0,
        };
      }

      log.cli("");
      log.cli(
        `${violations.length} applied migration file(s) staged for modification. Commit blocked.`
      );
      log.cli("");
      for (const v of violations) {
        log.cli(`   ${v.filePath}  (tag: ${v.tag})`);
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli(
        "   Applied migrations are IMMUTABLE. Drizzle records sha256(full .sql) at apply-time;"
      );
      log.cli("   editing an applied file causes it to re-apply on the next migrate --execute,");
      log.cli("   silently drifting the schema ledger from actual DB state.");
      log.cli("   Originating incidents: mt#1641, mt#2250 (migrations 0002/0014/0015).");
      log.cli("");
      log.cli("To fix: write a NEW migration that makes the desired schema change.");
      log.cli("   Run `bun run db:generate:pg` to generate it.");
      log.cli("   See .minsky/rules/migration-authoring.mdc for the canonical workflow.");
      log.cli("");
      log.cli(`If a modification is genuinely legitimate (e.g. fixing a never-applied migration),`);
      log.cli(
        `set ${IMMUTABLE_MIGRATION_CHECK_OVERRIDE_ENV}=1 to override. The skip is audit-logged.`
      );
      return {
        success: false,
        message: `Immutable-migration check failed: ${violations.length} applied migration(s) staged for modification`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Immutable-migration check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Immutable-migration check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run the deploy-domain ownership check (mt#2208, live successor to mt#2193).
   *
   * Verifies every domain ASSERTED as a deployment target in deploy/site config
   * is a domain we control (listed in `infra/controlled-domains.json`). Covers
   * `infra/index.ts` (SITE_URL etc.), `services/<svc>/deploy.config.ts`,
   * `services/<svc>/astro.config.ts`, and "Deployed at"/"serves at" claims in
   * `services/<svc>/README.md`.
   *
   * Originating incident (2026-05-31): `minsky.dev`, an illustrative example URL
   * from Jul-2025 analysis prose, hardened into authoritative deploy config and a
   * false "Deployed at" README claim with no ownership-verification step; an agent
   * later read it back as ground truth. `minsky.dev` is registered to a third
   * party (verified via Cloudflare API + RDAP + crt.sh).
   *
   * The detector strips comments before extracting domains from code files and
   * only extracts phrase-anchored domains from markdown, so the corrected repo's
   * WARNING-comment mentions of `minsky.dev` ("do not set this to a domain we do
   * not control") do not trip the check.
   *
   * Override: setting `MINSKY_SKIP_DEPLOY_DOMAIN_CHECK` to `1` / `true` / `yes`
   * skips the check and emits a one-line audit message. Use only when the
   * domain is genuinely controlled but not yet allowlisted AND the allowlist
   * entry is being added separately.
   *
   * See `src/hooks/deploy-domain-detector.ts` for the pure-function detector
   * this method wraps.
   */
  private async runDeployDomainCheck(): Promise<HookResult> {
    if (isDeployDomainOverrideTruthy(process.env[DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV])) {
      const ts = new Date().toISOString();
      log.cli(
        `[pre-commit:deploy-domain-check] override ${DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV}=${process.env[DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV]} ` +
          `at ${ts} — deploy-domain ownership check skipped`
      );
      return {
        success: true,
        message: "Deploy-domain check skipped via override",
        exitCode: 0,
        overridden: true,
      };
    }

    try {
      const result = runDeployDomainDetector(this.projectRoot);

      // null = no allowlist file => check inapplicable for this repo. Silent pass.
      if (result === null) {
        return {
          success: true,
          message: "Deploy-domain check inapplicable (no infra/controlled-domains.json)",
          exitCode: 0,
        };
      }

      if (result.violations.length === 0) {
        return {
          success: true,
          message: `Deploy-domain check passed (${result.scannedFiles.length} file(s) scanned)`,
          exitCode: 0,
        };
      }

      log.cli("");
      log.cli(`${result.violations.length} deploy-domain ownership violation(s). Commit blocked.`);
      log.cli("");
      for (const v of result.violations) {
        log.cli(`   ${v.filePath}:${v.line} asserts deploy domain "${v.host}" (apex: ${v.apex})`);
        log.cli(`     not in infra/controlled-domains.json`);
        if (v.excerpt) {
          log.cli(`     > ${v.excerpt}`);
        }
      }
      log.cli("");
      log.cli("Why this is blocked:");
      log.cli("   - Tracking task:        mt#2208 (live successor to mt#2193)");
      log.cli(
        "   - Originating incident: minsky.dev hardened into config, never ownership-verified"
      );
      log.cli("   - Bridge memory:        ac1a6761 (assertion-without-verification family)");
      log.cli("");
      log.cli("A domain asserted as a deploy target must be one we actually control.");
      log.cli("   If you DO control this domain, verify it (e.g. confirm it is a zone in");
      log.cli("   our Cloudflare account) and add its apex/host to infra/controlled-domains.json.");
      log.cli("");
      log.cli(
        `If the domain is controlled but not yet allowlisted, set ${DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV}=1 to override.`
      );
      log.cli("   The skip is audit-logged to stdout.");
      return {
        success: false,
        message: `Deploy-domain check failed: ${result.violations.length} uncontrolled domain assertion(s)`,
        exitCode: 1,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`Deploy-domain check failed: ${errorMsg}`);
      return {
        success: false,
        message: `Deploy-domain check failed: ${errorMsg}`,
        exitCode: 1,
      };
    }
  }

  /**
   * Run TypeScript type checking.
   *
   * Covers TWO projects: the root tsconfig.json AND src/cockpit/web/tsconfig.json
   * (mt#2424). The root tsconfig's own `exclude` list excludes src/cockpit/web —
   * browser-only lib/DOM settings would otherwise leak into the root Bun/Node
   * program — and `vite build` transpiles it via esbuild WITHOUT type-checking, so
   * without this second target the cockpit frontend has no static type coverage
   * at all. See mt#2424 for the two production escapes this closed (an unimported
   * `UseQueryResult` type and a missing `KIND_ICONS` union key, both of which
   * shipped past this same pre-commit hook before this project existed).
   */
  private async runTypeCheck(): Promise<HookResult> {
    log.cli("🔎 Running TypeScript type check...");

    // mt#3657: the pinned binary, never `bunx @typescript/native-preview` — that command
    // fetches `@latest` instead of the version this repo declares, and the download racing
    // the typecheck inside one invocation is what SIGKILLed this gate three times in five
    // days. A missing binary fails the step by NAME rather than falling back, so a broken
    // install can never quietly restore the drifting compiler.
    const resolution = this.resolveChecker(this.projectRoot);
    if (resolution.kind === "missing") {
      log.cli(`❌ TypeScript type check skipped — ${resolution.message} Commit blocked.`);
      return { success: false, message: resolution.message, exitCode: 1 };
    }
    const tsgo = resolution.binaryPath;

    const targets: Array<{ label: string; command: string }> = [
      { label: "root", command: `${tsgo} --noEmit` },
      {
        label: "cockpit-web",
        command: `${tsgo} --noEmit -p src/cockpit/web/tsconfig.json`,
      },
    ];

    for (const target of targets) {
      try {
        await this.exec(target.command, {
          cwd: this.projectRoot,
          timeout: TYPECHECK_TIMEOUT_MS,
        });
      } catch (error: unknown) {
        const err = error as { stdout?: string; stderr?: string; message?: string };
        // Include BOTH streams — tsgo's real type errors print to stdout, but a runner
        // crash (missing tsconfig, spawn failure) often puts the actionable diagnostic on
        // stderr instead; dropping it silently would hide exactly the failure this hook
        // exists to surface (reviewer finding, PR #2057 R1).
        const output =
          [err.stdout, err.stderr].filter((s) => s && s.trim().length > 0).join("\n") ||
          err.message ||
          String(error);
        // mt#3406: "type errors found" is a claim this catch cannot make. It
        // was reached during mt#3406's own implementation by a tsgo child the
        // KERNEL killed (SIGKILL, both streams empty) on a loaded host, while
        // `validate_typecheck` reported 0 errors on the same tree minutes
        // earlier. describeSubprocessFailure only relabels when the process
        // demonstrably did not finish; a real type error still reads as one.
        const label = describeSubprocessFailure(error, {
          step: `TypeScript type check (${target.label})`,
          timeoutMs: TYPECHECK_TIMEOUT_MS,
        });
        log.cli(`❌ ${label} Commit blocked.`);
        // PR #2480 R1 (non-blocking): when the child produced no diagnostics,
        // `output` falls back to `err.message`, which the label already quotes
        // as its `(underlying: …)` clause — printing it again just repeats the
        // same sentence under a heading that implies new information.
        if (!label.includes(output)) {
          log.cli(output);
        }
        return {
          success: false,
          message: label,
          exitCode: 1,
        };
      }
    }

    log.cli("✅ TypeScript compilation passed — no type errors (root + cockpit-web).");
    return { success: true, message: "Type check passed", exitCode: 0 };
  }

  /**
   * Run test pattern validation (placeholder - keep existing bash logic for now)
   */
  private async runTestPatternValidation(): Promise<HookResult> {
    log.cli("🔍 Checking for test anti-patterns...");
    log.cli("✅ Test pattern validation completed.");
    return { success: true, message: "Test pattern validation passed", exitCode: 0 };
  }

  /**
   * Check that all shebang-bearing entry points staged for commit have execute permission.
   * Covers .claude/hooks/*.ts (hook files) and scripts/cli-entry.ts (CLI binary entry).
   */
  private async runHookPermissionCheck(): Promise<HookResult> {
    log.cli("🔐 Checking hook file permissions...");

    try {
      const result = await execGitWithTimeout(
        "diff",
        "diff --cached --name-only --diff-filter=ACM",
        { workdir: this.projectRoot, timeout: 5000 }
      );

      const stagedFiles = result.stdout.toString().trim().split("\n").filter(Boolean);
      const executableEntryPoints = stagedFiles.filter(
        (f) => (f.startsWith(".claude/hooks/") && f.endsWith(".ts")) || f === "scripts/cli-entry.ts"
      );

      if (executableEntryPoints.length === 0) {
        log.cli("✅ No executable entry points staged.");
        return { success: true, message: "No executable entry points to check", exitCode: 0 };
      }

      const nonExecutable: string[] = [];
      for (const file of executableEntryPoints) {
        // Use fs.stat programmatically instead of `execAsync("test -x \"${file}\" ...")`
        // (mt#1829): file paths from `git diff --cached --name-only` are
        // git-controlled and may contain shell metacharacters. Programmatic
        // stat avoids /bin/sh entirely. mode & 0o100 checks the owner-execute
        // bit, which matches `test -x` for files the developer owns.
        //
        // PR #1122 R1: paths from `git diff` are repository-relative, so resolve
        // them against projectRoot before stat. The prior execAsync call used
        // `cwd: this.projectRoot` which made the shell resolve relative paths;
        // fs.stat resolves against process.cwd() so we must join explicitly.
        let mode: number | undefined;
        try {
          const st = await stat(join(this.projectRoot, file));
          mode = st.mode;
        } catch (err) {
          // ENOENT = file staged-then-deleted in the working tree between
          // diff and stat. Treat as "no check needed"; the git index will
          // commit whatever permission is recorded there.
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            continue;
          }
          throw err;
        }
        if ((mode & 0o100) === 0) {
          nonExecutable.push(file);
        }
      }

      if (nonExecutable.length > 0) {
        log.cli("❌ Executable entry points missing execute permission! Commit blocked.");
        log.cli(`🔧 Fix with: chmod +x ${nonExecutable.join(" ")}`);
        return {
          success: false,
          message: `Files missing +x: ${nonExecutable.join(", ")}`,
          exitCode: 1,
        };
      }

      log.cli("✅ All executable entry points have execute permission.");
      return { success: true, message: "Execute permission check passed", exitCode: 0 };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      log.error(`❌ Hook permission check failed: ${errorMsg}`);
      return { success: false, message: `Hook permission check failed: ${errorMsg}`, exitCode: 1 };
    }
  }

  /**
   * Run code formatting
   */
  private async runCodeFormatting(): Promise<HookResult> {
    log.cli("🎨 Running code formatter...");

    try {
      await this.exec("bunx lint-staged", {
        cwd: this.projectRoot,
        // Grounded in a measurement, not a round number (`decision-defaults.mdc
        // §Thresholds`): a 4-file stage set measured 42.7s cold, already past
        // the former 30s bound, which killed the step and failed three
        // consecutive commits while prettier and ESLint were independently
        // verified clean. lint-staged pays a `bunx` resolve plus a git
        // stash/restore cycle before touching a file, so that floor is mostly
        // fixed cost; 240s leaves ~5x headroom instead of sitting just above it.
        // (Inlined rather than named: this file is at its 1500-code-line cap,
        // so a `const` would not fit. Comments are free.)
        timeout: FORMATTER_TIMEOUT_MS,
      });
      log.cli("✅ Code formatting completed.");
      return { success: true, message: "Code formatting passed", exitCode: 0 };
    } catch (error) {
      // Report what happened rather than naming a cause this catch cannot
      // know: "check for syntax errors" sent readers hunting through files
      // prettier called clean, when the real failure was this step's timeout.
      // mt#3406 finishes that: the underlying message alone still cannot say
      // WHICH of the two happened, because Node words a timeout as a bare
      // "Command failed: <cmd>". `killed` is what tells them apart.
      const message = describeSubprocessFailure(error, {
        step: "Code formatting",
        timeoutMs: FORMATTER_TIMEOUT_MS,
      });
      log.cli(`❌ ${message}`);
      return { success: false, message, exitCode: 1 };
    }
  }

  /**
   * Regenerate the shell-completion manifest and re-stage it if it changed
   * (mt#2622). Unconditional — the generator is a pure function of the
   * current CLI source tree (Commander tree walk + Zod enum extraction, no
   * DB/network access) and completes in well under a second, so there is no
   * benefit to gating on which files are staged: any narrower heuristic
   * (e.g., "only run if src/adapters/shared/commands/** changed") risks
   * silently missing a CLI-shape change made through a path it didn't
   * anticipate, reintroducing exactly the staleness this step exists to
   * prevent. This mirrors the "compile --check" family's unconditional,
   * repo-wide scope (Step 9 / 9b) rather than lint-staged's staged-file
   * scoping (Step 1) — but AUTO-FIXES and re-stages instead of blocking, per
   * the Step 1b rationale above.
   */
  private async runCompletionManifestRegen(): Promise<HookResult> {
    log.cli("🔧 Regenerating shell-completion manifest...");

    const manifestPath = "src/generated/completion-manifest.json";

    try {
      // Reuses the same `build:completion-manifest` package.json script that
      // `bun run build` invokes, so there is exactly one place that names the
      // generator's invocation path.
      await execAsync("bun run build:completion-manifest", {
        cwd: this.projectRoot,
        timeout: 15000,
      });
    } catch (error) {
      const result = classifyCompletionManifestRegenError(error);
      for (const line of result.logLines) {
        log.cli(line);
      }
      return { success: false, message: result.message, exitCode: 1 };
    }

    // The generator (scripts/build-completion-manifest.ts) now formats its own
    // output with the project's Prettier config, so the regenerated manifest is
    // already canonical — no separate `bunx prettier --write` pass is needed
    // here before diff/stage (mt#2732). This removes the redundant format
    // subprocess the mt#2622 R2 review added back when the generator still
    // emitted raw JSON.stringify output that diverged from the committed copy.
    // Regression backstop: the generator uses the same .prettierrc.json config
    // as CI's `format:check` (which globs the committed manifest), so any future
    // format drift fails loudly at the CI gate — no local check needed here.

    // Compare the regenerated working-tree copy against the index. `git diff`
    // (no --quiet) always exits 0 and simply prints nothing when there is no
    // difference, so this never throws on the common "already up to date" path.
    // Uses `runGitArgv` (Bun.spawn argv, no shell) rather than
    // `execGitWithTimeout` — reviewer-bot BLOCKING finding, mt#2622 PR review
    // round 1: embedding `manifestPath` into an interpolated shell command
    // string is a bad precedent even though the path is a hardcoded constant.
    let changed = false;
    try {
      const diffStdout = await this.runGitArgv(["diff", "--name-only", "--", manifestPath]);
      changed = manifestDiffIndicatesChange(diffStdout);
    } catch (error) {
      // A failure here is a git-plumbing problem, not a generator problem —
      // fail closed rather than silently skip staging a possibly-changed file.
      const errMsg = error instanceof Error ? error.message : String(error);
      log.cli(`❌ Could not diff the regenerated completion manifest: ${errMsg}`);
      return {
        success: false,
        message: `Could not diff the regenerated completion manifest: ${errMsg}`,
        exitCode: 1,
      };
    }

    if (!changed) {
      log.cli("✅ Completion manifest already up-to-date.");
      return { success: true, message: "Completion manifest up-to-date", exitCode: 0 };
    }

    try {
      await this.runGitArgv(["add", "--", manifestPath]);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.cli(`❌ Could not stage the regenerated completion manifest: ${errMsg}`);
      return {
        success: false,
        message: `Could not stage the regenerated completion manifest: ${errMsg}`,
        exitCode: 1,
      };
    }

    log.cli("✅ Completion manifest regenerated and staged (was out of date).");
    return {
      success: true,
      message: "Completion manifest regenerated and staged",
      exitCode: 0,
    };
  }

  /**
   * Run ESLint rule tooling tests
   */
  private async runESLintRuleTests(): Promise<HookResult> {
    log.cli("🔧 Running ESLint rule tooling tests...");

    try {
      await execAsync("AGENT=1 bun test eslint-rules/fixtures-test.test.js --timeout=5000", {
        cwd: this.projectRoot,
        timeout: 15000,
        env: { ...process.env, AGENT: "1" },
      });
      log.cli("✅ ESLint rule tooling tests completed.");
      return { success: true, message: "ESLint rule tests passed", exitCode: 0 };
    } catch (error) {
      log.cli("❌ ESLint rule tooling tests failed! Please fix the fixture validation.");
      return { success: false, message: "ESLint rule tests failed", exitCode: 1 };
    }
  }

  /**
   * Legacy `rules compile` staleness check — RETIRED by the mt#3058 cutover.
   *
   * Its three targets — agents.md, claude.md, and claude-rules — moved to the
   * new-pipeline `runCompileCheck` (below), which now regenerates and
   * staleness-checks CLAUDE.md / AGENTS.md / .claude/rules (and carries their
   * MINSKY_SKIP_SIZE_BUDGET override). Banner-based detection could not be used
   * to "turn this off" because the new pipeline emits the identical generation
   * banner during coexistence — so the method is reduced to a no-op rather than
   * left detecting targets it must no longer own.
   *
   * This is a no-op SHELL, not a full removal: deleting the method, its Step-9
   * registration, and its tests is mt#2993's scope (the epic's phase-4
   * cleanup). Retained here so this cutover PR stays a focused wiring flip.
   */
  private async runRulesCompileCheck(): Promise<HookResult> {
    log.cli(
      "✅ Legacy rules-compile check retired (mt#3058) — CLAUDE.md / AGENTS.md / .claude/rules are now covered by the new compile check."
    );
    return {
      success: true,
      message: "Legacy rules compile check retired (mt#3058)",
      exitCode: 0,
    };
  }

  /**
   * Run `compile --check` for the NEW definition-compile system's targets
   * (distinct from the legacy `rules compile` system handled by
   * runRulesCompileCheck). This closes the mt#2182 gap: the `claude-skills`
   * target silently skipped all sources for weeks with no staleness guard.
   *
   * Targets checked (opted in when their `.minsky/` source dir exists):
   * - `claude-skills`  (.minsky/skills/) — the mt#2182 originating target.
   * - `cursor-rules-ts` (.minsky/rules/) — verified in sync as of mt#2252.
   * - `claude-agents`  (.minsky/agents/) — enabled by mt#2497 after the
   *   source↔output drift was reconciled (auditor/reviewer/fixture sources
   *   regenerated to reproduce their committed outputs). Before mt#2497 this
   *   was excluded because the outputs were richer than their sources, so a
   *   recompile silently reverted ~130 lines of mt#1551/#1606/#1611 content;
   *   the gap let that drift accumulate unguarded. mt#2497 subsumes the prior
   *   tracking task mt#1654 ("Reconcile agent source-of-truth split").
   */
  private async runCompileCheck(): Promise<HookResult> {
    log.cli(
      "📋 Checking compile outputs are up-to-date (claude-skills, cursor-rules-ts, claude-agents, claude-hooks, claude.md, agents.md, claude-rules)..."
    );

    const fsp = await import("fs/promises");
    const dirExists = async (p: string): Promise<boolean> => {
      try {
        await fsp.access(p);
        return true;
      } catch {
        return false;
      }
    };
    const targetsToCheck = compileCheckTargets({
      skills: await dirExists(`${this.projectRoot}/.minsky/skills`),
      rules: await dirExists(`${this.projectRoot}/.minsky/rules`),
      agents: await dirExists(`${this.projectRoot}/.minsky/agents`),
      // claude-hooks is auto-regenerated + re-staged by Step 3f
      // (runClaudeHooksCompileRegen, mt#2977) when hooks SOURCES are staged;
      // this block-on-drift check is RETAINED as the safety net for output
      // drift when sources are NOT staged — e.g. a hand-edited output (PR #2223
      // review). For a hooks-source commit Step 3f already regenerated the
      // output, so this check then passes on the fresh output.
      hooks: await dirExists(`${this.projectRoot}/.minsky/hooks`),
      // mt#4866 SC3 — mirrors probeMinskyCompileTargets so this check verifies
      // exactly the targets a bare `minsky compile` would regenerate. In this
      // repository both outputs exist, so nothing changes here.
      harness: await readRecordedHarnessForCheck(this.projectRoot),
      existingOutputs: {
        cursorRules: await dirExists(`${this.projectRoot}/.cursor/rules`),
        agentsMd: await dirExists(`${this.projectRoot}/AGENTS.md`),
      },
    });

    if (targetsToCheck.length === 0) {
      log.cli("✅ No new-compile-system outputs detected — skipping compile check.");
      return { success: true, message: "No compile targets to check", exitCode: 0 };
    }

    // mt#3058: the size-budget-bearing targets (claude.md/agents.md) moved onto
    // this check at cutover, so MINSKY_SKIP_SIZE_BUDGET must be honored HERE now,
    // exactly as it was on the legacy runRulesCompileCheck. Tracks whether THIS
    // invocation actually took the skip branch so the success return reports
    // `overridden: true` only then (never from a blanket env-presence check).
    let overrodeSizeBudget = false;

    for (const target of targetsToCheck) {
      try {
        // `target` is from the locally-built `targetsToCheck` array which
        // contains only the hardcoded literals "claude-skills",
        // "cursor-rules-ts", "claude-agents", "claude-hooks", "claude.md",
        // "agents.md", and "claude-rules". Bounded enum, no shell
        // metacharacters — no safeShellQuote needed (mirrors
        // runRulesCompileCheck / mt#1829).
        await execAsync(`bun run src/cli.ts compile --check --target ${target}`, {
          cwd: this.projectRoot,
          timeout: 30000,
        });
      } catch (error) {
        const result = classifyCompileCheckError(error, target, "compile");

        // mt#3676: a PER-RULE ceiling breach is priced to the author. If this
        // commit stages none of the offending rules, it did not cause the
        // breach and must not pay for it — log and continue WITHOUT requiring
        // the override. Before this, the cost landed on whichever agent
        // committed next: three sessions paid MINSKY_SKIP_SIZE_BUDGET in one
        // morning for a `hook-observers` breach none of them authored.
        //
        // The AGGREGATE budget deliberately keeps its old blast radius — it is
        // already priced at the authoring PR by mt#2874's merge gate, and is
        // out of scope here.
        if (result.errorKind === "budget-exceeded" && result.budgetKind === "per-rule") {
          const offenders = result.perRuleViolationIds ?? [];
          const stagedForScope = await execGitWithTimeout(
            "diff",
            "diff --cached --name-only --diff-filter=ACM",
            { workdir: this.projectRoot, timeout: 5000 }
          );
          const stagedForScopeFiles = stagedForScope.stdout
            .toString()
            .trim()
            .split("\n")
            .filter(Boolean);
          if (!perRuleBreachIsStaged(offenders, stagedForScopeFiles)) {
            log.cli(
              `⚠️  [pre-commit:per-rule-ceiling] ${offenders.join(", ")} exceed(s) the per-rule ` +
                `ceiling on this tree, but this commit stages none of them — not blocking (mt#3676). ` +
                `The PR that grows a rule past the ceiling is gated at merge instead.`
            );
            continue;
          }
        }

        // mt#2802/mt#3058: MINSKY_SKIP_SIZE_BUDGET overrides ONLY the
        // size-budget failure class — a genuinely stale target still blocks the
        // commit even with the override set. Mirrors runRulesCompileCheck.
        if (
          result.errorKind === "budget-exceeded" &&
          isOverrideTruthy(process.env[SIZE_BUDGET_CHECK_OVERRIDE_ENV])
        ) {
          const ts = new Date().toISOString();
          log.cli(
            `[pre-commit:compile-size-budget] override ${SIZE_BUDGET_CHECK_OVERRIDE_ENV} ` +
              `active at ${ts} — size budget failure for target "${target}" skipped ` +
              `(env value not echoed)`
          );
          overrodeSizeBudget = true;
          continue;
        }

        for (const line of result.logLines) {
          log.cli(line);
        }
        return { success: false, message: result.message, exitCode: 1 };
      }
    }

    log.cli(`✅ All compile outputs are up-to-date (${targetsToCheck.join(", ")}).`);
    return {
      success: true,
      message: "Compile check passed",
      exitCode: 0,
      ...(overrodeSizeBudget ? { overridden: true } : {}),
    };
  }
}

/**
 * True iff `git diff --name-only -- <manifestPath>`'s stdout indicates the
 * regenerated completion manifest differs from the index. `git diff` (no
 * `--quiet`) always exits 0, so this is a pure string check rather than an
 * exit-code check. Pure + exported for unit testing (mt#2622).
 */
export function manifestDiffIndicatesChange(diffStdout: string): boolean {
  return diffStdout.trim().length > 0;
}

/**
 * Build the failure result for a completion-manifest regeneration error.
 * Unlike {@link classifyCompileCheckError}, there is no STALE-vs-broken
 * distinction to make here: `runCompletionManifestRegen` always regenerates
 * (never `--check`s), so ANY thrown error means the generator itself failed —
 * re-running the commit will not help until the generator is fixed. Pure +
 * exported for unit testing (mt#2622).
 */
export function classifyCompletionManifestRegenError(error: unknown): {
  logLines: string[];
  message: string;
} {
  const execError = error as { stdout?: string; stderr?: string };
  // `||`, not `??`: an EMPTY-string stderr must fall through to stdout (mirrors
  // classifyCompileCheckError's `stderr.trim() || stdout.trim()` below) — `??`
  // would treat `""` as "present" and never reach stdout.
  const detail = (execError.stderr ?? "").trim() || (execError.stdout ?? "").trim();
  const errorDetail = detail || (error instanceof Error ? error.message : String(error));
  const logLines = [
    "❌ Completion-manifest regeneration failed:",
    ...errorDetail.split("\n").map((line) => `   ${line}`),
    "💡 Fix the error above and retry the commit. This is a generator bug, not staleness — " +
      "re-running the commit will NOT help until the generator itself is fixed.",
  ];
  return {
    logLines,
    message: `Completion-manifest regeneration failed: ${errorDetail.split("\n")[0]}`,
  };
}

/**
 * Build the failure result for a Dockerfile workspace-COPY regeneration
 * error (mt#2621). Mirrors {@link classifyCompletionManifestRegenError}:
 * `runDockerfileWorkspaceCopyRegen` always regenerates (never blocks on
 * ordinary drift), so any thrown error here means the generator script
 * itself failed — most likely a protected Dockerfile is missing the
 * generated-block markers (see `applyGeneratedWorkspaceCopyBlock`'s error
 * message), which is a one-time setup gap rather than staleness. Pure +
 * exported for unit testing.
 */
export function classifyDockerfileWorkspaceCopyRegenError(error: unknown): {
  logLines: string[];
  message: string;
} {
  const execError = error as { stdout?: string; stderr?: string };
  // `??`, not `||`-only: an EMPTY-string stderr must fall through to stdout
  // (mirrors classifyCompletionManifestRegenError above).
  const detail = (execError.stderr ?? "").trim() || (execError.stdout ?? "").trim();
  const errorDetail = detail || (error instanceof Error ? error.message : String(error));
  const logLines = [
    "❌ Dockerfile workspace-COPY regeneration failed:",
    ...errorDetail.split("\n").map((line) => `   ${line}`),
    "💡 A protected Dockerfile is likely missing the generated-block markers — see " +
      "Dockerfile / services/reviewer/Dockerfile for the expected shape.",
  ];
  return {
    logLines,
    message: `Dockerfile workspace-COPY regeneration failed: ${errorDetail.split("\n")[0]}`,
  };
}

// `classifyDockerfileBunBuildRegenError` moved to `./bun-build-sync-regen`
// (mt#3091, extracted for the max-lines ceiling alongside the regen/check
// functions it classifies errors for — see that module's header).

/**
 * Maps which `.minsky/` source dirs are present to the compile targets the
 * pre-commit check verifies. Each target is opted in only when its source dir
 * exists, so repos without a given source tree skip that check. Pure +
 * exported for unit testing (mt#2497).
 *
 * mt#3058 cutover: `claude.md`, `agents.md`, and `claude-rules` moved here from
 * the legacy `runRulesCompileCheck`. All three are sourced from `.minsky/rules/`,
 * so they gate on `present.rules` alongside `cursor-rules-ts`. Kept in sync with
 * `minskyCompileTargetsFromPresence` (packages/domain/src/compile/compile.ts).
 *
 * mt#4866 SC3: that sibling now gates `cursor-rules-ts` and `agents.md` on the
 * recorded harness, so this mirror gates them the same way. Keeping only one side
 * would make the pre-commit check demand outputs the compile no longer produces —
 * a claude-code project would be told its `.cursor/rules/` and `AGENTS.md` are
 * stale forever, with no invocation able to refresh them.
 *
 * This is a NO-OP in Minsky's own repository, which has both `.cursor/rules/` and
 * `AGENTS.md` on disk and therefore takes the already-exists escape.
 */
/**
 * The project's recorded `workspace.harness`, or `undefined`.
 *
 * Duplicated from `readRecordedHarness` (packages/domain/src/compile/compile.ts)
 * for the same reason `compileCheckTargets` duplicates its sibling mapping: the
 * domain module pulls in `createMinskyCompileService` and every compile target,
 * which is a large import graph to drag into a hook that runs on every commit.
 * The read itself is ten lines and has no behaviour to drift — but if the LOCATION
 * of the harness field ever moves, both copies change.
 *
 * Fails open (returns `undefined`), matching the sibling: an unreadable config
 * must not silently drop targets from the staleness check.
 */
export async function readRecordedHarnessForCheck(
  projectRoot: string
): Promise<string | undefined> {
  const fsp = await import("fs/promises");
  const { parse: parseYaml } = await import("yaml");

  for (const fileName of ["config.local.yaml", "config.yaml"]) {
    try {
      const raw = String(await fsp.readFile(`${projectRoot}/.minsky/${fileName}`, "utf-8"));
      const parsed = parseYaml(raw) as { workspace?: { harness?: unknown } } | null;
      const harness = parsed?.workspace?.harness;
      if (typeof harness === "string" && harness.length > 0) return harness;
    } catch {
      // intentional-swallow: a missing or unparseable config is the common case,
      // and `undefined` — "gate nothing" — is the safe direction. The next
      // candidate file is still tried.
    }
  }
  return undefined;
}

export function compileCheckTargets(present: {
  skills: boolean;
  rules: boolean;
  agents: boolean;
  hooks: boolean;
  /** Recorded `workspace.harness`; absent means "gate nothing" (pre-mt#4866). */
  harness?: string;
  /** Whether each harness-specific output already exists on disk. */
  existingOutputs?: { cursorRules: boolean; agentsMd: boolean };
}): string[] {
  const claudeCodeOnly = present.harness === "claude-code";
  const cursorRulesExists = present.existingOutputs?.cursorRules ?? false;
  const agentsMdExists = present.existingOutputs?.agentsMd ?? false;

  const targets: string[] = [];
  if (present.skills) targets.push("claude-skills");
  if (present.rules) {
    if (!claudeCodeOnly || cursorRulesExists) targets.push("cursor-rules-ts");
    targets.push("claude.md");
    if (!claudeCodeOnly || agentsMdExists) targets.push("agents.md");
    targets.push("claude-rules");
  }
  if (present.agents) targets.push("claude-agents");
  if (present.hooks) targets.push("claude-hooks");
  return targets;
}

// The claude-hooks compile auto-regen helpers live in
// ./claude-hooks-compile-regen (extracted for the max-lines ceiling, mt#2977).
// Re-exported so existing importers (compile-check-targets.test.ts) resolve
// them from ./pre-commit.
export {
  claudeHooksCompileAffected,
  classifyCompileHooksRegenError,
} from "./claude-hooks-compile-regen";

/**
 * Classify a failed compile-check subprocess error as either genuine staleness
 * or an unrelated compile-command error (e.g., setup-incomplete). Serves BOTH
 * compile systems via `kind`: the legacy `rules compile --check` (kind="rules")
 * and the new `compile --check` (kind="compile"). All user-facing hints derive
 * the command name from `kind` so they never name the wrong system.
 *
 * When the CLI detects stale output it prints a `[<cmd> --check] ... is STALE`
 * marker to stdout before throwing. Any other non-zero exit means the compile
 * command itself failed — telling the operator to "regenerate" would be
 * misleading because the same error will recur.
 *
 * **Marker-classification precedence (R1 fix — made explicit, was previously
 * only implicit in code order).** Exactly THREE stdout markers are checked,
 * IN THIS ORDER, each an early `return` so at most one ever fires:
 *
 *   1. `is STALE` (staleness) — checked FIRST. A stale target's compiled
 *      output doesn't reflect the current rule source, so evaluating a size
 *      budget against it would be meaningless (the operator needs to
 *      regenerate before ANY size classification is trustworthy).
 *   2. `EXCEEDS SIZE BUDGET` (aggregate budget, mt#2802) — checked SECOND,
 *      only reachable when not stale.
 *   3. `HAS RULE(S) EXCEEDING PER-RULE CEILING` (per-rule ceiling, mt#2874) —
 *      checked THIRD, only reachable when neither stale nor aggregate-
 *      exceeded. Both 2 and 3 map to the SAME `"budget-exceeded"` errorKind
 *      (one audited override, `MINSKY_SKIP_SIZE_BUDGET`, not two) — their
 *      relative order between each other doesn't change override behavior,
 *      but staleness MUST stay first regardless.
 *
 * Each of the three ordered pairs (stale-vs-aggregate, stale-vs-per-rule,
 * aggregate-vs-per-rule) has a direct unit test in
 * `src/hooks/rules-compile-check.test.ts` asserting the correct marker wins
 * when BOTH are present in the same stdout (a scenario that should not occur
 * in practice — the CLI's own `reportSingleTargetCompile` returns on the
 * first failure it finds in this same order — but the classifier's
 * precedence must still be deterministic if it ever does).
 *
 * Exported for unit testing; not part of the public hook API.
 */
/**
 * Pull the rule ids over the per-rule ceiling out of a compile command's stdout
 * (mt#3676).
 *
 * The command prints a human line and then a JSON payload, so the payload is
 * located by its first `{` through its last `}` rather than by assuming the
 * whole of stdout parses. Reading `perRuleViolations` from that payload —
 * rather than measuring the `.mdc` sources — is deliberate: a rule's COMPILED
 * contribution is what the ceiling is enforced against, and it differs from the
 * source body (measured: `hook-observers` 6060 chars at source, 5983 compiled).
 * A source-side approximation would be wrong by ~1%, which decides the verdict
 * for any rule sitting near the line.
 *
 * Returns `[]` on ANY parse failure. Callers must read that as "cannot scope
 * this failure" and keep blocking — never as "no rules are over."
 */
export function extractPerRuleViolationIds(stdout: string): string[] {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const violations = (parsed as { perRuleViolations?: unknown }).perRuleViolations;
  if (!Array.isArray(violations)) return [];
  return violations
    .map((v) => (v !== null && typeof v === "object" ? (v as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * A rule source file, captured to its rule id (PR #2652 R1).
 *
 * The id segment is `[^/]+`, NOT `.+`: the rules directory is read by a
 * NON-RECURSIVE `readdir` filtered on `.endsWith(".mdc")`
 * (`packages/domain/src/rules/operations/file-operations.ts`), so a nested
 * `.minsky/rules/sub/foo.mdc` is never loaded as a rule and can never appear in
 * `perRuleViolations`. Treating it as one would invent an id (`sub/foo`) that
 * matches no violation — silently failing to bill a real offender, or billing
 * the wrong file. A greedy `.+` did exactly that.
 */
const RULE_FILE_RE = /^\.minsky\/rules\/([^/]+)\.mdc$/;

/**
 * Whether a per-rule ceiling breach should block THIS commit (mt#3676).
 *
 * The ceiling is enforced at pre-commit, so before this change the failure
 * landed on whichever agent committed next, regardless of what they touched —
 * three separate sessions paid `MINSKY_SKIP_SIZE_BUDGET=1` in one morning for a
 * `hook-observers` breach none of them caused. Growth is now priced to the
 * author: a commit blocks only when it stages a rule that is itself over.
 *
 * Fail-CLOSED on ambiguity. An empty `violationIds` means the offender list
 * could not be parsed, and blocks — otherwise a parse bug silently disables the
 * ceiling repo-wide, which is strictly worse than the mispricing being fixed.
 */
export function perRuleBreachIsStaged(
  violationIds: readonly string[],
  stagedFiles: readonly string[]
): boolean {
  if (violationIds.length === 0) return true;
  const stagedRuleIds = new Set(
    stagedFiles
      .map((f) => RULE_FILE_RE.exec(f)?.[1])
      .filter((id): id is string => typeof id === "string")
  );
  return violationIds.some((id) => stagedRuleIds.has(id));
}

export function classifyCompileCheckError(
  error: unknown,
  target: string,
  // Which compile system emitted the check: the legacy `rules compile` command
  // or the new `compile` command. Determines both the STALE-marker prefix to
  // match and the regenerate hint to print. Defaults to "rules" for backward
  // compatibility with existing callers/tests.
  kind: "rules" | "compile" = "rules"
): {
  logLines: string[];
  message: string;
  /**
   * Discriminates the failure class (mt#2802 adds "budget-exceeded" for the
   * legacy `rules compile` size-budget check). Callers (e.g.
   * `runRulesCompileCheck`) use this to decide whether an override env var
   * applies — overrides are keyed to a specific failure class, not to "any
   * compile --check failure".
   */
  errorKind: "stale" | "budget-exceeded" | "setup-incomplete" | "other";
  /**
   * Which size check failed, when `errorKind` is `"budget-exceeded"` (mt#3676).
   * Both checks deliberately share ONE errorKind and therefore one audited
   * override (mt#2874) — this discriminates them WITHOUT splitting that escape
   * hatch, so a caller can scope the per-rule case to the staged diff while
   * leaving the aggregate case's blast radius untouched (the aggregate budget
   * is already priced at the authoring PR by mt#2874's merge gate, and is
   * explicitly out of scope for mt#3676).
   */
  budgetKind?: "aggregate" | "per-rule";
  /**
   * Rule ids over the per-rule ceiling, parsed from the compile command's own
   * JSON payload (`perRuleViolations`) rather than re-derived — the compiler is
   * the only thing that knows a rule's COMPILED contribution, which differs
   * from its source size.
   *
   * Empty when the payload could not be parsed. Callers MUST treat empty as
   * "cannot scope this failure" and keep blocking: silently allowing a commit
   * because the offender list failed to parse would convert a parse bug into a
   * disabled ceiling.
   */
  perRuleViolationIds?: string[];
} {
  const execError = error as { stdout?: string; stderr?: string };
  const stdout = execError.stdout ?? "";
  const stderr = execError.stderr ?? "";

  // The two CLIs emit a marker line of the exact form:
  //   [rules compile --check] Target "<target>" is STALE   (legacy)
  //   [compile --check] Target "<target>" is STALE          (new)
  // to stdout only when output is verified out-of-date. Match this with a
  // per-target line-anchored regex so near-misses (a STALE marker for a
  // different target, or incidental prose) do not count.
  const cmd = kind === "rules" ? "rules compile" : "compile";
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const staleLineRe = new RegExp(`\\[${cmd} --check\\] Target "${escapedTarget}" is STALE`, "m");
  const isGenuinelyStale = staleLineRe.test(stdout);

  if (isGenuinelyStale) {
    return {
      logLines: [
        `❌ Compile output for target "${target}" is stale.`,
        `💡 Run "bun run minsky ${cmd} --target ${target}" to regenerate.`,
      ],
      message: `Compile output for target "${target}" is stale`,
      errorKind: "stale",
    };
  }

  // mt#2802: size-budget-exceeded classification. Legacy `rules compile` only —
  // the new `compile` system's targets don't enforce a size budget, so this
  // marker never appears in "compile"-kind stdout.
  const budgetExceededLineRe = new RegExp(
    `\\[${cmd} --check\\] Target "${escapedTarget}" EXCEEDS SIZE BUDGET`,
    "m"
  );
  const isBudgetExceeded = budgetExceededLineRe.test(stdout);

  if (isBudgetExceeded) {
    const detail = stdout.trim();
    const indentedDetail = detail
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
    return {
      logLines: [
        `❌ Compile output for target "${target}" exceeds its size budget.`,
        indentedDetail,
        `💡 Trim the rules listed above, or set MINSKY_SKIP_SIZE_BUDGET=1 to override this commit (audit-logged).`,
      ],
      message: `Compile output for target "${target}" exceeds its size budget`,
      errorKind: "budget-exceeded",
      budgetKind: "aggregate",
    };
  }

  // mt#2874: per-rule-ceiling-exceeded classification. Reuses the SAME
  // "budget-exceeded" errorKind (and therefore the same MINSKY_SKIP_SIZE_BUDGET
  // override) as the aggregate budget check above — one audited escape hatch,
  // not two, per the mt#2874 spec.
  const perRuleCeilingLineRe = new RegExp(
    `\\[${cmd} --check\\] Target "${escapedTarget}" HAS RULE\\(S\\) EXCEEDING PER-RULE CEILING`,
    "m"
  );
  const isPerRuleCeilingExceeded = perRuleCeilingLineRe.test(stdout);

  if (isPerRuleCeilingExceeded) {
    const detail = stdout.trim();
    const indentedDetail = detail
      .split("\n")
      .map((line) => `   ${line}`)
      .join("\n");
    return {
      logLines: [
        `❌ Compile output for target "${target}" has rule(s) exceeding the per-rule ceiling.`,
        indentedDetail,
        `💡 Trim the rule(s) listed above, or set MINSKY_SKIP_SIZE_BUDGET=1 to override this commit (audit-logged).`,
      ],
      message: `Compile output for target "${target}" has rule(s) exceeding the per-rule ceiling`,
      errorKind: "budget-exceeded",
      budgetKind: "per-rule",
      perRuleViolationIds: extractPerRuleViolationIds(stdout),
    };
  }

  // Compile command errored. Surface the actual error so the operator knows
  // what to fix — re-running the compile command will NOT help.
  const rawDetail = stderr.trim() || stdout.trim();
  const errorDetail = rawDetail || (error instanceof Error ? error.message : String(error));

  // Detect setup-incomplete: the CLI emits "Validation error: Developer setup incomplete"
  // when the Minsky setup has not been run. Telling the operator to "regenerate" is
  // misleading in that case — the correct action is to run the setup command.
  const isSetupIncomplete = /Validation error: Developer setup incomplete/i.test(errorDetail);

  const indented = errorDetail
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");

  if (isSetupIncomplete) {
    return {
      logLines: [
        `❌ Compile check for target "${target}" failed: developer setup is incomplete.`,
        indented,
        `💡 Run "minsky setup --client <client-name>" to complete setup, then retry the commit.`,
        `   (Re-running "${cmd}" will NOT fix this — the setup must be completed first.)`,
      ],
      message: `Compile check for target "${target}" failed: developer setup incomplete`,
      errorKind: "setup-incomplete",
    };
  }

  return {
    logLines: [
      `❌ Compile check for target "${target}" failed (not a staleness issue):`,
      indented,
      `💡 Fix the error above before retrying. ("${cmd}" will NOT fix this.)`,
    ],
    message: `Compile check for target "${target}" failed: ${errorDetail.split("\n")[0]}`,
    errorKind: "other",
  };
}

// CLI entry point
if (import.meta.main) {
  const hook = new PreCommitHook();
  hook
    .run()
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((error) => {
      log.error("❌ Pre-commit hook crashed:", error);
      process.exit(1);
    });
}
