/**
 * `wake_pending` retention sweeper — the cockpit-daemon registration (mt#4537).
 *
 * The POLICY — which rows are deletable, why an undelivered row with a live addressee
 * never is, and where the retention window's value comes from — lives in
 * `@minsky/domain/ask/wake-pending-retention`. This file is only the timer, the
 * connection acquisition, and the unavailability reporting.
 *
 * Its own module rather than another block in `sweepers.ts`, following the precedent
 * `transcript-sweep-backstop.ts` set when that file hit the max-lines ceiling (mt#4480).
 *
 * Invocation path: `startWakePendingRetentionSweeper()` is called from
 * `src/commands/cockpit/start-command.ts` alongside the other daemon sweeps.
 *
 * @see mt#4537
 */

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { log } from "@minsky/shared/logger";
// STATIC, deliberately — mt#4489's fix in the sibling backstop applies verbatim here.
// An `await import(...)` inside a tick defers module resolution to the first sweep,
// potentially hours after boot; the daemon resolves `@minsky/*` against the tree its
// entry script came from, and if that tree is a session workspace that gets cleaned up
// meanwhile, every not-yet-loaded import fails with ENOENT on a process that had been
// running fine. Loading at import time makes this sweep as durable as the module that
// registers it.
import {
  describePersistenceUnavailability,
  PersistenceUnavailableError,
} from "@minsky/domain/persistence/unconfigured-provider";
import {
  runWakePendingRetentionSweep,
  type WakePendingRetentionResult,
} from "@minsky/domain/ask/wake-pending-retention";
import type {
  PersistenceProvider,
  SqlCapablePersistenceProvider,
} from "@minsky/domain/persistence/types";
import { getSharedPersistenceService } from "./shared-persistence";
import { createIntervalSweeper, type SweepTickResult } from "./sweepers";

/**
 * Cadence for the retention sweep.
 *
 * NOT derived from the arrival rate: at ~1 row/day (12 rows in the table's first 11
 * days) any cadence from minutes to weeks keeps up. The binding constraint is that the
 * INTERVAL fires at all. `createIntervalSweeper` runs a boot tick immediately, so a
 * daemon that restarts often sweeps on every start — but the cockpit daemon has been
 * observed alive for 12.7h at a stretch (mem#1170), and an interval longer than a
 * typical lifetime would leave the boot tick as the only pass that ever runs. Six hours
 * is about half that observed uptime, so a long-lived daemon still sweeps mid-life.
 * Against a 14-day retention window it adds at most 6h to a row's lifetime, which is
 * noise at that scale.
 */
export const WAKE_PENDING_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * The two collaborators one tick reaches for. Injected rather than imported inside the
 * tick so the availability decision below is testable against a REAL
 * `UnconfiguredPersistenceProvider` — which is the whole point, since the defect this
 * shape replaced (PR #3311 R1) was a guard that looked right and never fired for that
 * exact class.
 */
export interface WakePendingRetentionTickDeps {
  getProvider: () => Promise<PersistenceProvider>;
  sweep: (db: PostgresJsDatabase) => Promise<WakePendingRetentionResult>;
}

/**
 * One retention pass, including the fail-open policy. Exported for tests; production
 * calls it through {@link startWakePendingRetentionSweeper}.
 *
 * Never throws: every path returns a {@link SweepTickResult} so `/api/sweeps` carries a
 * real domain outcome rather than a green scheduling record over a dead sweep (mem#862,
 * mt#4412).
 */
export async function runWakePendingRetentionTick(
  deps: WakePendingRetentionTickDeps
): Promise<SweepTickResult> {
  // Hoisted so the catch below can still describe WHICH provider was unavailable.
  let provider: PersistenceProvider | undefined;
  try {
    provider = await deps.getProvider();

    // CAPABILITY, not method presence (PR #3311 R1). `UnconfiguredPersistenceProvider`
    // DEFINES `getDatabaseConnection()` — it throws — so an `in` check passes and the
    // guard is dead code for the exact provider it was written for. Its
    // `capabilities.sql` is false, which is the distinction that actually holds, and
    // `SqlCapablePersistenceProvider` is the narrowing the base class's own comment
    // points callers at.
    if (!provider.getCapabilities().sql) {
      // Not a quiet no-op (mt#4412): without SQL this sweep can never do its job, and
      // reporting ok would hide an unbounded table behind a green row on /api/sweeps.
      // The reason comes from the provider rather than a literal — "nothing was
      // configured" and "configured but initialization failed" are different
      // situations with different recoveries, and only the provider knows which.
      log.warn(
        `cockpit: wake-pending retention sweep skipped — ${describePersistenceUnavailability(provider)}`
      );
      return { ok: false };
    }

    const db = await (provider as SqlCapablePersistenceProvider).getDatabaseConnection();
    if (!db) {
      log.warn("cockpit: wake-pending retention sweep skipped — no database connection");
      return { ok: false };
    }

    const result = await deps.sweep(db);

    // Logged only when something was actually removed — a sweep that finds nothing is
    // the steady state and should not write a line every six hours. The undeliverable
    // count is the one worth watching: a rising number means wakes are outliving their
    // addressees, which is a delivery problem rather than hygiene.
    if (result.deletedDelivered > 0 || result.deletedUndeliverable > 0) {
      log.cli(
        `wake_pending retention: removed ${result.deletedDelivered} delivered, ` +
          `${result.deletedUndeliverable} undeliverable`
      );
    }
    return { ok: true };
  } catch (err) {
    // A provider that reports `sql: true` and still refuses is the configured-but-
    // unavailable case, and it deserves the same structured reason as the branch above
    // rather than a generic "sweep failed" (PR #3311 R1). Belt to that brace: the
    // capability check is the primary path, and this covers a provider whose declared
    // capabilities and actual behaviour disagree.
    if (err instanceof PersistenceUnavailableError) {
      log.warn(
        `cockpit: wake-pending retention sweep skipped — ${
          provider ? describePersistenceUnavailability(provider) : err.message
        }`
      );
      return { ok: false };
    }
    const message = err instanceof Error ? err.message : String(err);
    log.warn("cockpit: wake-pending retention sweep failed", { message });
    return { ok: false };
  }
}

/**
 * Start the periodic `wake_pending` retention sweep in this cockpit process.
 *
 * The provider is resolved PER TICK rather than held across ticks: the pool recycles,
 * and a handle captured once fails every tick after the first recycle — the defect
 * mt#4364 fixed in the service-window reaper.
 *
 * @returns stop function (clears the interval).
 */
export function startWakePendingRetentionSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "wake-pending retention",
    intervalMs: intervalMs ?? WAKE_PENDING_RETENTION_SWEEP_INTERVAL_MS,
    tick: async (): Promise<SweepTickResult> =>
      runWakePendingRetentionTick({
        getProvider: async () => (await getSharedPersistenceService()).getProvider(),
        sweep: (db) => runWakePendingRetentionSweep(db),
      }),
  });
}
