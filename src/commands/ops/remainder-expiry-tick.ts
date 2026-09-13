/**
 * `minsky-ops` remainder-expiry loop tick (mt#5131, Prioritization Phase 1d).
 *
 * Thin ops-loop adapter over `runRemainderSweep`
 * (`packages/domain/src/tasks/remainder-expiry-store.ts`): resolves the
 * container's persistence provider into a Postgres connection and runs the
 * sweep — parking open tasks untouched 90+ days that no live standing
 * pointing matches, and reopening parked tasks a pointing now matches.
 *
 * Registered via `registerLoop` in `start-command.ts` with envPrefix
 * `REMAINDER_EXPIRY` — disabled by default; production enablement is an
 * explicit operator step after deploy (mt#5138), the same convention as
 * `TOIL_MINER` and `ADOPTION_SWEEPER`:
 *
 *   REMAINDER_EXPIRY_ENABLED     — "true" to activate (default: false)
 *   REMAINDER_EXPIRY_INTERVAL_MS — cadence (default: 86_400_000 = 24h)
 *   REMAINDER_EXPIRY_EXECUTE     — "true"/"1" to APPLY the plan. Default is
 *     SHADOW: the tick computes and logs the would-park / resurrect sets and
 *     writes nothing (operational-safety-dry-run-first). The first execute is
 *     the CLI's, under mt#5138, after the dry-run counts are recorded.
 *   REMAINDER_EXPIRY_TICK_CAP    — parks per tick (default: 50 — ~14× the
 *     measured ~3.6 tasks/day that age past 90 days, so a runaway evaluator
 *     is bounded to one day's cap; resurrection is uncapped)
 */

import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { isSqlCapable } from "@minsky/domain/persistence/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import { ALL_PROJECTS } from "@minsky/domain/project/scope";
import { log } from "@minsky/shared/logger";

/** Default parks per tick; see the module comment for the grounding. */
export const REMAINDER_EXPIRY_DEFAULT_TICK_CAP = 50;

/**
 * Parse a non-negative integer from an env var. Mirrors `parsePositiveIntEnv`
 * in `start-command.ts` — duplicated to avoid a circular import (that file
 * imports this tick), and accepting 0 because a zero cap is a legal "shadow
 * parks, still resurrect" setting.
 */
function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\+?\d+$/.test(raw)) {
    throw new Error(`minsky-ops: ${name} must be a non-negative integer (got "${raw}")`);
  }
  return Number.parseInt(raw, 10);
}

function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === "true" || raw === "1";
}

/** The tick's shape is injectable so the test can run it without a container. */
export interface RemainderExpiryTickDeps {
  executeOverride?: boolean;
  capOverride?: number;
}

export async function remainderExpiryOpsTick(
  container: AppContainerInterface,
  deps: RemainderExpiryTickDeps = {}
): Promise<void> {
  const persistence = container.get("persistence");
  if (!isSqlCapable(persistence)) {
    throw new Error(
      `remainder_expiry: not SQL-capable — ${describePersistenceUnavailability(persistence)}`
    );
  }
  const sqlPersistence: SqlCapablePersistenceProvider = persistence;
  const db = await sqlPersistence.getDatabaseConnection();
  if (!db) {
    throw new Error(
      `remainder_expiry: getDatabaseConnection() returned null — ${describePersistenceUnavailability(persistence)}`
    );
  }

  const execute = deps.executeOverride ?? envFlag("REMAINDER_EXPIRY_EXECUTE");
  const cap =
    deps.capOverride ??
    envNonNegativeInt("REMAINDER_EXPIRY_TICK_CAP", REMAINDER_EXPIRY_DEFAULT_TICK_CAP);

  const { runRemainderSweep } = await import("@minsky/domain/tasks/remainder-expiry-store");

  log.info("remainder_expiry.tick_starting", {
    event: "remainder_expiry.tick_starting",
    mode: execute ? "execute" : "shadow",
    cap,
  });

  // Process-wide by design, like the toil miner: every project's remainder
  // is this tick's to evaluate, so the scope is ALL_PROJECTS.
  const result = await runRemainderSweep(db, {
    projectScope: ALL_PROJECTS,
    execute,
    cap,
    via: "ops-loop",
  });

  log.info("remainder_expiry.tick_finished", {
    event: "remainder_expiry.tick_finished",
    mode: result.dryRun ? "shadow" : "execute",
    parkingSuspended: result.plan.parkingSuspended,
    pointingIds: result.plan.pointingIds,
    wouldPark: result.plan.wouldPark.length,
    plannedPark: result.plan.park.length,
    capped: result.plan.capped,
    plannedResurrect: result.plan.resurrect.length,
    parked: result.applied.parked,
    resurrected: result.applied.resurrected,
    // The ids are the audit record a shadow tick leaves behind; bounded by
    // the cap on the park side, and resurrection sets are small by nature.
    wouldParkIds: result.plan.wouldPark.slice(0, cap === 0 ? 50 : cap),
  });
}
