#!/usr/bin/env bun
/**
 * Canary runner CLI — mt#2889 (evaluation-loop Phase 1 completion).
 *
 * Runs every declared guard canary (`.minsky/hooks/registry.ts`'s
 * `GuardRegistration.canary` field, plus the standalone-guard canaries
 * declared below for guards not registered in `GUARD_REGISTRY`) through the
 * REAL guard decision logic and reports pass/fail. This is the RFC's
 * load-bearing broken-vs-dormant disambiguator (docs/architecture/
 * evaluation-loop-fire-log.md): a guard that stops firing on its own canary
 * is BROKEN, not merely dormant.
 *
 * Isolation (mt#2876 class — never write fixture records to real state):
 * `MINSKY_STATE_DIR` and `CLAUDE_PROJECT_DIR` are pointed at a fresh temp
 * directory for the WHOLE process, set before any guard module is imported.
 * Several canaries (auto-session-title, inject-dispatch-watchdog,
 * skill-staleness-detector, guard-health-escalation-detector,
 * calibration-review-cadence-detector) write their OWN priming fixtures via
 * their `canary.setup` hook — those writes land under this same isolated
 * root (or a further-nested per-canary temp dir), never under the
 * developer's real `~/.local/state/minsky/` or this repo's real `.minsky/`.
 *
 * Usage:
 *   bun scripts/run-guard-canaries.ts            # human-readable report
 *   bun scripts/run-guard-canaries.ts --json      # structured JSON report
 *
 * Exit code: 0 = every declared canary passed; 1 = at least one canary
 * failed (a broken guard was detected) or a moduleLoader/import errored.
 * Guards with NO declared canary are reported separately (MISSING) and do
 * NOT affect the exit code — this script itself is agnostic to whether
 * full coverage has been reached; the mt#2889 PR body cites full-coverage
 * status separately.
 *
 * @see mt#2889 — this task
 * @see .minsky/hooks/canary-runner.ts — core evaluation logic this wraps
 * @see .minsky/hooks/registry.ts — GUARD_REGISTRY, GuardRegistration.canary
 * @see docs/architecture/evaluation-loop-fire-log.md
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate state BEFORE importing anything that might read these env vars at
// module load or first invocation (mt#2876 class).
const CANARY_STATE_DIR = mkdtempSync(join(tmpdir(), "mt2889-guard-canaries-"));
process.env["MINSKY_STATE_DIR"] = CANARY_STATE_DIR;
process.env["CLAUDE_PROJECT_DIR"] = CANARY_STATE_DIR;
// Canary-mode gate (mt#3004, PR #2145 R1): the test-only guard seams
// (memory-search fixture stub, daemon-staleness tracker-home redirect) are
// honored ONLY while this is set — production processes never enter those
// branches.
process.env["MINSKY_CANARY_MODE"] = "1";

const {
  runAllRegistryCanaries,
  runAllStandaloneCanaries,
  summarizeCanaryResults,
  formatCanaryResult,
} = await import("../.minsky/hooks/canary-runner");
const { STANDALONE_GUARD_CANARIES } = await import("./lib/standalone-guard-canaries");

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");

  try {
    const registryResults = await runAllRegistryCanaries();
    const standaloneResults = await runAllStandaloneCanaries(STANDALONE_GUARD_CANARIES);
    const combined = [...registryResults, ...standaloneResults];
    const report = summarizeCanaryResults(combined);

    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const r of report.results) {
        console.log(formatCanaryResult(r));
      }
      console.log("");
      console.log(
        `Total: ${report.total}  Passed: ${report.passed}  Failed: ${report.failed}  Missing: ${report.missing}`
      );
      console.log(
        report.allPassed
          ? "PASS — every declared canary fired as expected."
          : "FAIL — at least one canary did not fire as expected (see FAIL lines above)."
      );
    }

    process.exit(report.allPassed ? 0 : 1);
  } finally {
    rmSync(CANARY_STATE_DIR, { recursive: true, force: true });
  }
}

await main();
