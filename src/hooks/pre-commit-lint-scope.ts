/**
 * Staged-file scoping for the pre-commit ESLint step (mt#3404).
 *
 * Step 5 of the pre-commit hook used to run `eslint .` — a ~3,000-file sweep —
 * on every commit. On a host running a fleet of concurrent agents (load average
 * 85 on 16 cores, measured 2026-07-30) that took 287s of wall clock against
 * only ~50s of CPU, blowing through the step's 120s timeout: six commits were
 * denied at the timeout boundary within a single hour. The helpers here narrow
 * the step to the staged set, which is the same commit-time-scoping trade
 * mt#2716 and mt#2932 already made for the test step, with the same backstop —
 * CI's `lint:strict` (`.github/workflows/ci.yml`) remains the authoritative
 * full-repo gate.
 *
 * These live in their own module rather than in `pre-commit.ts` because that
 * file is already at the `max-lines` ceiling (1,500 counted lines).
 *
 * @see src/hooks/pre-commit.ts — `runESLintValidation`, the sole consumer
 * @see packages/domain/src/project/config-reader.ts — `getLintJsonCommand`
 */

import { log } from "@minsky/shared/logger";
// Type-only import: erased at build time, so this does not create a runtime
// import cycle with `pre-commit.ts` (which imports the functions here).
import type { HookResult } from "./pre-commit";

/**
 * Zero tolerance — any warning blocks the commit. mt#1097 ratcheted this to 0
 * after fixing all pre-existing warnings and adding CI-level enforcement
 * (`bun run lint:strict`) so GitHub-UI merges can't bypass the gate. If a
 * warning category legitimately needs an exception, add a line- or file-level
 * waiver with a specific justification.
 */
const MAX_LINT_WARNINGS = 0;

/** Error/warning totals for a single ESLint run. */
export interface LintSummary {
  errorCount: number;
  warningCount: number;
}

/**
 * Report an ESLint run's totals and decide whether the commit proceeds.
 *
 * Extracted from `runESLintValidation` (mt#3404) so `pre-commit.ts` stays under
 * its `max-lines` ceiling; the thresholds and messages are unchanged.
 */
export function evaluateLintSummary(summary: LintSummary): HookResult {
  log.cli("📊 ESLint Results:");
  log.cli(`   Errors: ${summary.errorCount}`);
  log.cli(`   Warnings: ${summary.warningCount}`);

  if (summary.errorCount > 0) {
    log.cli("");
    log.cli("❌ ❌ ❌ LINTER ERRORS DETECTED! COMMIT BLOCKED! ❌ ❌ ❌");
    log.cli("");
    log.cli(
      `🚫 Found ${summary.errorCount} linter error(s). ALL errors must be fixed before committing.`
    );
    log.cli("💡 Run 'bun run lint --fix' to auto-fix many issues.");
    log.cli("🔧 Review and manually fix any remaining errors.");
    log.cli("");
    log.cli("Run 'bun run lint' to see detailed error information.");
    return {
      success: false,
      message: `ESLint found ${summary.errorCount} error(s)`,
      exitCode: 1,
    };
  }

  if (summary.warningCount > MAX_LINT_WARNINGS) {
    log.cli("");
    log.cli("⚠️ ⚠️ ⚠️ TOO MANY WARNINGS! COMMIT BLOCKED! ⚠️ ⚠️ ⚠️");
    log.cli("");
    log.cli(`🚫 Found ${summary.warningCount} warnings. Maximum allowed: ${MAX_LINT_WARNINGS}.`);
    log.cli("💡 Please address warnings to improve code quality.");
    log.cli(`🎯 Target: Reduce warnings below ${MAX_LINT_WARNINGS} threshold.`);
    log.cli("");
    log.cli("Run 'bun run lint' to see detailed warning information.");
    return {
      success: false,
      message: `ESLint found ${summary.warningCount} warnings (over ${MAX_LINT_WARNINGS} threshold)`,
      exitCode: 1,
    };
  }

  log.cli("✅ Perfect! Zero errors and zero warnings detected.");
  return { success: true, message: "ESLint validation passed", exitCode: 0 };
}

/**
 * File extensions ESLint is configured to lint in this repo (see the `files`
 * globs in `eslint.config.js`). Used to decide whether a staged change is worth
 * spawning ESLint for at all.
 */
const LINTABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"] as const;

/**
 * Narrow a staged-file list to the files ESLint actually lints. A commit
 * touching only docs or config yields an empty list, letting the caller skip
 * spawning ESLint entirely.
 */
export function selectLintableStagedFiles(stagedFiles: readonly string[]): string[] {
  return stagedFiles.filter((file) => LINTABLE_EXTENSIONS.some((ext) => file.endsWith(ext)));
}

/**
 * Rewrite a full-repo lint command so it targets an explicit file list.
 *
 * The configured command is `eslint . --format json` by default
 * (`ProjectConfigReader.getLintJsonCommand`). The bare `.` target is replaced in
 * place so surrounding flags are preserved; if no `.` target is present (a
 * project overrode the command), the file list is appended instead.
 *
 * `--no-warn-ignored` is REQUIRED, not cosmetic: when ESLint is handed an
 * explicit path that its ignore config excludes, it emits a warning for that
 * file — and this hook's warning threshold is zero, so an ignored-but-staged
 * file would otherwise block the commit with a warning about its own exclusion.
 */
export function buildScopedLintCommand(baseCommand: string, files: readonly string[]): string {
  const quoted = files.map((file) => `'${file.replace(/'/g, "'\\''")}'`).join(" ");
  const tokens = baseCommand.split(/\s+/).filter(Boolean);
  const targetIndex = tokens.indexOf(".");
  const scoped =
    targetIndex === -1
      ? `${baseCommand} ${quoted}`
      : [...tokens.slice(0, targetIndex), quoted, ...tokens.slice(targetIndex + 1)].join(" ");

  const extraFlags = ["--no-warn-ignored", "--no-error-on-unmatched-pattern"]
    .filter((flag) => !baseCommand.includes(flag))
    .join(" ");

  return extraFlags ? `${scoped} ${extraFlags}` : scoped;
}
