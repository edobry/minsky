/**
 * Pure mapping from a canary-runner report to persistable rows (mt#4007).
 *
 * Split out from `scripts/run-guard-canaries.ts` specifically so it is
 * SAFELY importable from a test file: the CLI script has top-level side
 * effects (a temp-dir env-isolation mutation and an unconditional
 * `await main()` that calls `process.exit()`), so importing it directly
 * would run the whole canary suite and terminate the test process. This
 * module has no side effects and no I/O — importing it does nothing but
 * define two functions.
 *
 * @see scripts/run-guard-canaries.ts — the sole caller
 * @see scripts/lib/guard-canary-persistence-mapping.test.ts — tests
 */

import type { CanaryReport, CanaryResult } from "../../.minsky/hooks/canary-runner";
import type { GuardCanaryOutcomeInput } from "@minsky/domain/observability/guard-canary-history";

/**
 * The failure-detail string recorded for a failed canary (mt#4007 SC1's
 * "failure detail"): the guard module's thrown error message when it threw,
 * or a synthesized mismatch summary when the canary ran to completion but
 * its outcome didn't satisfy `expects`. `null` on a pass.
 */
export function buildFailureDetail(r: CanaryResult): string | null {
  if (r.passed) return null;
  if (r.error) return r.error;
  return `canary ran but its outcome did not satisfy expects=${r.expects ?? "(undeclared)"}`;
}

/**
 * Map a CanaryReport's results to the rows one canary pass should persist.
 *
 * A guard with `passed === undefined` (no declared canary) is DROPPED here —
 * never written to `guard_canary_runs` at all. Absence of history IS the
 * never-verified state (mt#4007 AT2); see guard-canary-runs-schema.ts's doc
 * comment for the full rationale.
 */
export function buildPersistableOutcomes(report: CanaryReport): GuardCanaryOutcomeInput[] {
  const outcomes: GuardCanaryOutcomeInput[] = [];
  for (const r of report.results) {
    if (r.passed === undefined) continue; // no declared canary — never persisted
    if (r.expects === undefined) continue; // defensive: pass/fail always carries `expects`
    outcomes.push({
      guardName: r.guardName,
      source: r.source,
      expects: r.expects,
      passed: r.passed,
      failureDetail: buildFailureDetail(r),
    });
  }
  return outcomes;
}
