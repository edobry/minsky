/**
 * `minsky-ops` package-lifecycle loop tick (mt#5132; mt#5122 SC1/SC2/SC4).
 *
 * Thin ops-loop adapter over `runWorkPackageLifecycleSweep`
 * (`packages/domain/src/tasks/work-package-lifecycle-sweep.ts`): resolves the
 * container's persistence provider into a Postgres connection and runs the
 * sweep — closing packages whose every member is terminal, releasing claims
 * whose holder has gone stale (no presence inside the window).
 *
 * Registered via `registerLoop` in `start-command.ts` with envPrefix
 * `PACKAGE_LIFECYCLE` — the adoption-sweeper convention:
 *
 *   PACKAGE_LIFECYCLE_ENABLED     — "true" to activate (default: false;
 *     `infra/index.ts` declares it true on the ops service)
 *   PACKAGE_LIFECYCLE_INTERVAL_MS — cadence (default: 900_000 = 15 min)
 *   PACKAGE_LIFECYCLE_EXECUTE     — "true"/"1" to APPLY the plan. Default is
 *     SHADOW: the tick computes and logs the close / release / keep plan and
 *     writes nothing (operational-safety-dry-run-first). The first execute is
 *     the CLI's (`tasks packages sweep --execute`, mt#5132 AT4); flipping this
 *     flag is mt#5139's operator step after one shadow tick matches it.
 *   PACKAGE_LIFECYCLE_STALE_HOURS — claim staleness window (default 24; see
 *     `CLAIM_STALE_MS` for the grounding)
 */

import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { isSqlCapable } from "@minsky/domain/persistence/types";
import type { SqlCapablePersistenceProvider } from "@minsky/domain/persistence/types";
import { describePersistenceUnavailability } from "@minsky/domain/persistence/unconfigured-provider";
import { log } from "@minsky/shared/logger";

function envFlag(name: string): boolean {
  const raw = process.env[name];
  return raw === "true" || raw === "1";
}

/** Positive number of hours, or the fallback; a malformed value is a startup error, not a silent default. */
function envPositiveHours(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`minsky-ops: ${name} must be a positive number of hours (got "${raw}")`);
  }
  return n;
}

/** The tick's shape is injectable so the test can run it without a container. */
export interface PackageLifecycleTickDeps {
  executeOverride?: boolean;
  staleHoursOverride?: number;
}

export async function packageLifecycleOpsTick(
  container: AppContainerInterface,
  deps: PackageLifecycleTickDeps = {}
): Promise<void> {
  const persistence = container.get("persistence");
  if (!isSqlCapable(persistence)) {
    throw new Error(
      `package_lifecycle: not SQL-capable — ${describePersistenceUnavailability(persistence)}`
    );
  }
  const sqlPersistence: SqlCapablePersistenceProvider = persistence;
  const db = await sqlPersistence.getDatabaseConnection();
  if (!db) {
    throw new Error(
      `package_lifecycle: getDatabaseConnection() returned null — ${describePersistenceUnavailability(persistence)}`
    );
  }

  const execute = deps.executeOverride ?? envFlag("PACKAGE_LIFECYCLE_EXECUTE");
  const staleHours =
    deps.staleHoursOverride ?? envPositiveHours("PACKAGE_LIFECYCLE_STALE_HOURS", 24);

  const { runWorkPackageLifecycleSweep } = await import(
    "@minsky/domain/tasks/work-package-lifecycle-sweep"
  );

  log.info("package_lifecycle.tick_starting", {
    event: "package_lifecycle.tick_starting",
    mode: execute ? "execute" : "shadow",
    staleHours,
  });

  const result = await runWorkPackageLifecycleSweep(db, {
    execute,
    staleMs: staleHours * 3_600_000,
    via: "ops-loop",
  });

  log.info("package_lifecycle.tick_finished", {
    event: "package_lifecycle.tick_finished",
    mode: result.dryRun ? "shadow" : "execute",
    plannedClose: result.plan.close.map((c) => c.id),
    plannedRelease: result.plan.release.map((r) => ({ id: r.id, reason: r.reason })),
    kept: result.plan.keep.length,
    zeroMembers: result.plan.zeroMembers,
    closed: result.applied.closed,
    released: result.applied.released,
    refused: result.applied.refused,
  });
}
