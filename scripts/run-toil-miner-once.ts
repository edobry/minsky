#!/usr/bin/env bun
/**
 * One-shot invocation of the EngProd toil-miner tick (mt#3330).
 *
 * The "toil-miner" ops loop ships DISABLED by default (`TOIL_MINER_ENABLED`
 * unset) with a 5-day cadence — waiting for the first scheduled tick is not
 * a practical way to run it once. This script drives exactly ONE tick
 * through the SAME production code path the ops loop registers
 * (`toilMinerOpsTick` in `src/commands/ops/toil-miner-tick.ts`), against a
 * real Postgres connection and a real AI provider, with no loop/interval
 * involved.
 *
 * Two purposes:
 * 1. **§7a verification artifact** — this task's structural changes (a new
 *    persistence path, a new LLM-provider call, a new task-filing
 *    mechanism) need a live exercise beyond unit tests; this script is that
 *    exercise.
 * 2. **mt#2807-baseline gate run** (spec AT3) — the run plan for the
 *    parent agent's post-merge step: invoke this script against the real
 *    corpus, then compare the filed `engprod-proposal` tasks (and the
 *    `engprod_proposal_ledger`/`engprod_miner_runs` tables) against the
 *    July-2026 manual tool-surface analysis's identified gaps, recording
 *    hits/misses/false positives in this task's spec.
 *
 * Gate (CLAUDE.md §Operational Safety: Dry-Run First / this codebase's
 * skip-gracefully convention): exits 0 with a `SKIP:` message when the
 * configured persistence provider is not SQL-capable, or when the domain
 * container fails to initialize — no destructive default, no crash on a
 * laptop/CI checkout with no database configured.
 *
 * Usage:
 *   bun scripts/run-toil-miner-once.ts
 *
 * Tuning env vars (all optional; see toil-miner-tick.ts's adapter for
 * defaults): TOIL_MINER_WINDOW_DAYS, TOIL_MINER_MIN_FREQUENCY,
 * TOIL_MINER_MIN_SESSIONS, TOIL_MINER_MIN_CHAIN_LENGTH,
 * TOIL_MINER_MAX_CHAIN_LENGTH, TOIL_MINER_LLM_CAP, TOIL_MINER_BUDGET_CAP,
 * TOIL_MINER_SIMILARITY_THRESHOLD,
 * TOIL_MINER_FINGERPRINT_CONCENTRATION_THRESHOLD.
 *
 * Logging (mt#3429): this script forces `MINSKY_LOG_MODE=STRUCTURED`
 * before touching the logger, unless the operator already set it
 * explicitly. Without this, the default logger mode (auto -> HUMAN when
 * run interactively) suppresses the `engprod_toil_miner.*` info-level
 * structured events this script's own completion message points readers
 * at ("see logs above") — the prior version of this script printed that
 * message while those events were silently dropped. Set
 * `MINSKY_LOG_MODE=HUMAN` explicitly to opt back into human-readable logs.
 */
import "reflect-metadata";
import { reinitializeDefaultLoggerFromEnv } from "@minsky/shared/logger";

if (!process.env.MINSKY_LOG_MODE) {
  process.env.MINSKY_LOG_MODE = "STRUCTURED";
}
reinitializeDefaultLoggerFromEnv();

async function main(): Promise<void> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { toilMinerOpsTick } = await import("../src/commands/ops/toil-miner-tick");

  await initializeConfiguration(new CustomConfigFactory(), {
    workingDirectory: process.cwd(),
  });

  const container = await createCliContainer();
  await container.initialize();

  // mt#3330 review R1: `process.exit()` terminates synchronously — calling
  // it from inside the `try` block below would skip the `finally` clause
  // entirely, leaking the container's DB connection. Every exit path sets
  // `exitCode` instead; the single `process.exit(exitCode)` call happens
  // AFTER `container.close()` has run.
  let exitCode = 0;
  try {
    const persistence = container.has("persistence") ? container.get("persistence") : undefined;
    const isSqlCapable =
      !!persistence &&
      !!(persistence as { capabilities?: { sql?: boolean } }).capabilities?.sql &&
      typeof (persistence as { getDatabaseConnection?: unknown }).getDatabaseConnection ===
        "function";

    if (!isSqlCapable) {
      console.log(
        "SKIP: engprod toil-miner requires a SQL-capable persistence provider (Postgres) — none configured."
      );
    } else {
      console.log("engprod toil-miner: running one-shot tick...");
      await toilMinerOpsTick(container);
      console.log(
        "engprod toil-miner: tick completed successfully (see engprod_toil_miner.* logs above)."
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`engprod toil-miner: tick ended in an ERROR state — ${message}`);
    exitCode = 1;
  } finally {
    await container.close();
  }
  process.exit(exitCode);
}

main();
