#!/usr/bin/env bun
/**
 * Spawns scripts/run-related-tests.ts (the mt#2932 fast changed-file-scoped
 * test gate) and reports its pass/fail result. Extracted from
 * src/hooks/pre-commit.ts to keep that file under the `max-lines` lint
 * ceiling -- mirrors the existing pattern of small, focused detector modules
 * (nul-byte-detector.ts, migration-journal-check.ts, deploy-domain-detector.ts,
 * etc.) that pre-commit.ts imports and calls rather than inlining.
 */
import {
  spawnWithWatchdog,
  resolveWatchdogBudgetMs,
  WATCHDOG_BUDGETS_MS,
} from "../../scripts/spawn-with-watchdog";

export interface RelatedTestsCheckResult {
  success: boolean;
  message: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runRelatedTestsCheck(projectRoot: string): Promise<RelatedTestsCheckResult> {
  // mt#3765 / PR #2733 R1: this wrapper is a BACKSTOP, not the gate's bound.
  //
  // It previously used `Bun.spawnSync`'s `timeout: 75000` — which does not
  // enforce (mt#3156 measured a SIGTERM-ignoring child running to completion
  // and being reported as a PASS), and which treats its own kill as a hard
  // FAILURE. That combination is dangerous now that the gate itself reports a
  // timeout as a non-blocking deferral: a 75s outer kill could flip a
  // legitimately-bounded run into a blocked commit, reintroducing exactly the
  // unpassable state mt#3765 removed, on the one path where a timeout is NOT
  // reported as a deferral.
  //
  // The gate now self-bounds at RELATED_TESTS_TOTAL and always gets to report
  // its own disposition; this budget sits above that with margin, so if it
  // ever fires the gate itself hung and a hard failure IS the right answer.
  const budgetMs = resolveWatchdogBudgetMs(WATCHDOG_BUDGETS_MS.RELATED_TESTS_WRAPPER);
  const result = await spawnWithWatchdog(["bun", "scripts/run-related-tests.ts"], {
    cwd: projectRoot,
    env: { AGENT: "1" },
    budgetMs,
  });
  const exitCode = result.exitCode;
  return {
    success: exitCode === 0,
    message:
      exitCode === 0
        ? "Fast related-test gate passed"
        : result.timedOut
          ? `Fast related-test gate HUNG — exceeded its ${Math.round(budgetMs / 1000)}s backstop ` +
            `(ran ${Math.round(result.elapsedMs / 1000)}s) and was terminated. The gate bounds ` +
            `itself well below this, so hitting it means the gate did not report at all.`
          : "Fast related-test gate failed (see output above)",
    exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
