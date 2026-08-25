/**
 * `wake_pending` retention sweeper — the cockpit-daemon registration (mt#4537).
 *
 * The POLICY — which rows are deletable, why an undelivered row with a live addressee
 * never is, and where the retention window's value comes from — lives in
 * `@minsky/domain/ask/wake-pending-retention`. This file is only the timer and the
 * connection acquisition.
 *
 * Its own module rather than another block in `sweepers.ts`, following the precedent
 * `transcript-sweep-backstop.ts` set when that file hit the max-lines ceiling (mt#4480).
 *
 * Invocation path: `startWakePendingRetentionSweeper()` is called from
 * `src/commands/cockpit/start-command.ts` alongside the other daemon sweeps.
 *
 * @see mt#4537
 */

import { log } from "@minsky/shared/logger";
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
 * Start the periodic `wake_pending` retention sweep in this cockpit process.
 *
 * Fail-open per tick: a provider that is not SQL-capable, an unavailable connection, or
 * a failed statement logs and returns `{ ok: false }`, so `/api/sweeps` shows the domain
 * failure rather than a green scheduling record over a dead sweep (mem#862, mt#4412).
 *
 * The connection is acquired PER TICK rather than held across ticks: the pool recycles,
 * and a handle captured once fails every tick after the first recycle — the defect
 * mt#4364 fixed in the service-window reaper.
 *
 * @returns stop function (clears the interval).
 */
export function startWakePendingRetentionSweeper(intervalMs?: number): () => void {
  return createIntervalSweeper({
    name: "wake-pending retention",
    intervalMs: intervalMs ?? WAKE_PENDING_RETENTION_SWEEP_INTERVAL_MS,
    tick: async (): Promise<SweepTickResult> => {
      try {
        const { getSharedPersistenceService } = await import("./shared-persistence");
        const provider = (await getSharedPersistenceService()).getProvider();
        if (
          !("getDatabaseConnection" in provider) ||
          typeof (provider as { getDatabaseConnection?: unknown }).getDatabaseConnection !==
            "function"
        ) {
          // Not a quiet no-op (mt#4412): a non-SQL provider means this sweep can never
          // do its job, and reporting ok would hide an unbounded table behind a green
          // row on /api/sweeps. The reason comes from the provider itself rather than
          // from a literal — "not SQL-capable" and "configured but unreachable" are
          // different situations with different recoveries, and only the provider
          // knows which one this is.
          const { describePersistenceUnavailability } = await import(
            "@minsky/domain/persistence/unconfigured-provider"
          );
          log.warn(
            `cockpit: wake-pending retention sweep skipped — ${describePersistenceUnavailability(provider)}`
          );
          return { ok: false };
        }
        const sqlProvider = provider as {
          getDatabaseConnection: () => Promise<
            import("drizzle-orm/postgres-js").PostgresJsDatabase | null
          >;
        };
        const db = await sqlProvider.getDatabaseConnection();
        if (!db) {
          log.warn("cockpit: wake-pending retention sweep skipped — no database connection");
          return { ok: false };
        }

        const { runWakePendingRetentionSweep } = await import(
          "@minsky/domain/ask/wake-pending-retention"
        );
        const result = await runWakePendingRetentionSweep(db);

        // Logged only when something was actually removed — a sweep that finds nothing
        // is the steady state and should not write a line every six hours. The
        // undeliverable count is the one worth watching: a rising number means wakes
        // are outliving their addressees, which is a delivery problem rather than
        // hygiene.
        if (result.deletedDelivered > 0 || result.deletedUndeliverable > 0) {
          log.cli(
            `wake_pending retention: removed ${result.deletedDelivered} delivered, ` +
              `${result.deletedUndeliverable} undeliverable`
          );
        }
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("cockpit: wake-pending retention sweep failed", { message });
        return { ok: false };
      }
    },
  });
}
