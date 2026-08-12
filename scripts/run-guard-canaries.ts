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
 * This isolation is unrelated to (and does not interfere with) the Postgres
 * persistence added by mt#4007 below: neither `MINSKY_STATE_DIR` nor
 * `CLAUDE_PROJECT_DIR` is consulted anywhere in the DB-connection or
 * project-config resolution path (verified: `CLAUDE_PROJECT_DIR` is read
 * only for Claude-Code harness DETECTION in `runtime/harness-detection.ts`;
 * `MINSKY_STATE_DIR` is read only by `disconnect-tracker.ts`'s process-local
 * path override) — `process.cwd()`, which the config bootstrap actually
 * keys project-config resolution on, is never touched by this isolation.
 *
 * Persistence (mt#4007): after computing the report, every EVALUATED canary
 * outcome (pass/fail — never a "missing" one; see guard-canary-runs-schema.ts's
 * doc comment for why) is recorded to the `guard_canary_runs` table so
 * "broken since" is derivable. Best-effort and fail-open, mirroring
 * `scripts/rationalization-review.ts`'s `resolveFamilyRecurrences`: a
 * bootstrap/connect/write failure is reported to STDERR only and NEVER
 * changes this script's stdout shape or exit code (SC5 — the sole
 * programmatic caller, `scripts/rationalization-review.ts`'s
 * `runCanarySuite()`, `JSON.parse`s stdout and does not check the exit code
 * at all, so persistence failures must stay invisible to both).
 *
 * Usage:
 *   bun scripts/run-guard-canaries.ts            # human-readable report
 *   bun scripts/run-guard-canaries.ts --json      # structured JSON report
 *   bun scripts/run-guard-canaries.ts --no-persist  # skip the DB write (tests/dev)
 *
 * Exit code: 0 = every declared canary passed; 1 = at least one canary
 * failed (a broken guard was detected) or a moduleLoader/import errored.
 * Guards with NO declared canary are reported separately (MISSING) and do
 * NOT affect the exit code — this script itself is agnostic to whether
 * full coverage has been reached; the mt#2889 PR body cites full-coverage
 * status separately.
 *
 * @see mt#2889 — this task (the runner itself)
 * @see mt#4007 — persistence (this doc comment's "Persistence" section)
 * @see .minsky/hooks/canary-runner.ts — core evaluation logic this wraps
 * @see .minsky/hooks/registry.ts — GUARD_REGISTRY, GuardRegistration.canary
 * @see docs/architecture/evaluation-loop-fire-log.md
 * @see packages/domain/src/observability/guard-canary-history.ts — the writer/reader
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
// mt#4007: STATIC, and must precede any domain-module import (including the
// dynamic ones below) — importing this module installs the tsyringe reflect
// polyfill. See `.minsky/hooks/domain-bootstrap.ts`'s doc comment for the
// two-layer bootstrap hazard this avoids (mem#672 / mt#3019): a hook/script
// that reaches the persistence factory without this throws at MODULE LOAD,
// outside any try/catch, and the failure is easy to misattribute to "DB
// unavailable" instead of "polyfill missing".
import "reflect-metadata";
// Type-only imports erase at compile time, so they cannot load a domain
// module ahead of the bootstrap in persistCanaryRun below.
import type { CanaryReport } from "../.minsky/hooks/canary-runner";
import { buildPersistableOutcomes } from "./lib/guard-canary-persistence-mapping";

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

/**
 * Persist one canary pass's evaluated outcomes to `guard_canary_runs`
 * (mt#4007). Best-effort and fail-open — see this file's module doc comment
 * ("Persistence") for why a bootstrap/connect/write failure must never touch
 * stdout or the exit code. Reports failures to stderr only.
 */
async function persistCanaryRun(report: CanaryReport): Promise<void> {
  const outcomes = buildPersistableOutcomes(report);
  if (outcomes.length === 0) return;

  const runId = randomUUID();
  const ranAt = new Date();

  let persistenceToClose: { close(): Promise<void> } | undefined;
  try {
    const { initializeConfiguration, CustomConfigFactory } = await import(
      "@minsky/domain/configuration"
    );
    const { createCliContainer } = await import("../src/composition/cli");
    const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
    const { buildGuardCanaryHistoryRepository } = await import(
      "@minsky/domain/observability/guard-canary-history"
    );

    await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });
    const container = await createCliContainer();
    await container.initialize();

    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    if (!persistence || !(persistence instanceof PersistenceProvider)) {
      process.stderr.write(
        "[run-guard-canaries] warn: no persistence provider available — skipping canary-history write\n"
      );
      return;
    }
    persistenceToClose = persistence;
    if (!persistence.capabilities.sql || typeof persistence.getDatabaseConnection !== "function") {
      process.stderr.write(
        "[run-guard-canaries] warn: persistence provider is not SQL-capable — skipping canary-history write\n"
      );
      return;
    }

    const db = await persistence.getDatabaseConnection();
    const repository = buildGuardCanaryHistoryRepository(db);
    if (!repository) {
      process.stderr.write(
        "[run-guard-canaries] warn: could not build guard-canary-history repository — skipping write\n"
      );
      return;
    }

    await repository.recordRun(runId, ranAt, outcomes);
  } catch (err) {
    // A drizzle-orm/postgres-js query error's `.message` embeds the FULL SQL
    // statement plus every bound parameter (verified live: a 45-guard run
    // produced a multi-KB single line) — safeTruncate keeps the stderr line
    // readable without hiding that a failure occurred.
    const { safeTruncate } = await import("@minsky/shared/safe-truncate");
    const rawMessage = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[run-guard-canaries] warn: canary-history persistence failed (best-effort, swallowed): ${safeTruncate(
        rawMessage,
        500,
        "head"
      )}\n`
    );
  } finally {
    if (persistenceToClose) {
      try {
        await persistenceToClose.close();
      } catch (closeErr) {
        process.stderr.write(
          `[run-guard-canaries] warn: persistence.close() failed: ${
            closeErr instanceof Error ? closeErr.message : String(closeErr)
          }\n`
        );
      }
    }
  }
}

async function main(): Promise<void> {
  const jsonMode = process.argv.includes("--json");
  const persist = !process.argv.includes("--no-persist");

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

    // mt#4007: persist AFTER stdout is fully written, so a slow/failing DB
    // write can never delay or corrupt the report a caller is reading from
    // stdout. Exit code below is unconditional on this succeeding (SC5).
    if (persist) {
      await persistCanaryRun(report);
    }

    process.exit(report.allPassed ? 0 : 1);
  } finally {
    rmSync(CANARY_STATE_DIR, { recursive: true, force: true });
  }
}

await main();
