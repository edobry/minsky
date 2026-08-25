#!/usr/bin/env bun
/**
 * Live verification for mt#4473 — the drizzle path is inside the pooler bound.
 *
 * The unit tests in `raw-sql-pooler-guard.test.ts` prove the mechanism against
 * a FAKE postgres-js client. They cannot prove the thing that actually failed
 * on 2026-08-23: that drizzle's REAL driver, over a REAL pool, is admitted
 * through the guard and counted by it. That is the §7a substrate direction —
 * evidence gathered against a substitute runtime validates the logic, not its
 * reachability in the real one.
 *
 * What this exercises, end to end:
 *
 *  1. The provider's real initialization path, which is where `drizzle()` is
 *     now constructed over the guarded client (`postgres-provider.ts`).
 *  2. A real drizzle SELECT WITH FIELDS — the path that calls
 *     `client.unsafe(query, params).values()`. This is the one that would
 *     break outright if the guard mishandled `.values()` chaining, and no
 *     amount of fake-client testing settles it.
 *  3. `getPoolerSaturation()` observing that traffic. Before mt#4473 these
 *     counters could not move for drizzle queries at all — the guard's own
 *     docblock said "a pool can be exhausted by drizzle traffic while this
 *     reads all zeros". A non-zero reading here IS the closed blind spot.
 *
 * Env-gated: on a machine with no SQL-capable persistence configured it SKIPs
 * (exit 0) rather than failing, per the verification-artifact convention.
 *
 * Read-only: it issues SELECTs against `tasks` and mutates nothing.
 *
 * Usage: bun scripts/verify-drizzle-pooler-bound.ts
 * Exit codes: 0 = pass or skip, 1 = fail.
 */
// Must precede any tsyringe-decorated import — the container resolves the
// persistence provider through DI.
import "reflect-metadata";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const { initializeConfiguration, CustomConfigFactory } = await import(
    "@minsky/domain/configuration"
  );
  const { createCliContainer } = await import("../src/composition/cli");
  const { PersistenceProvider } = await import("@minsky/domain/persistence/types");
  const { getPoolerSaturation } = await import("@minsky/domain/persistence/raw-sql-pooler-guard");
  const { tasksTable } = await import("@minsky/domain/storage/schemas/task-embeddings");

  await initializeConfiguration(new CustomConfigFactory(), { workingDirectory: process.cwd() });

  const container = await createCliContainer();
  await container.initialize();

  const persistence = container.has("persistence") ? container.get("persistence") : undefined;
  if (
    !persistence ||
    !(persistence instanceof PersistenceProvider) ||
    !persistence.capabilities.sql ||
    typeof persistence.getDatabaseConnection !== "function"
  ) {
    console.log("SKIP: no SQL-capable persistence provider configured.");
    return 0;
  }

  const db = await (
    persistence as { getDatabaseConnection: () => Promise<unknown> }
  ).getDatabaseConnection();
  if (!db) {
    console.log("SKIP: SQL-capable provider has no initialized connection.");
    return 0;
  }

  // Baseline AFTER initialization: the provider's own boot queries have already
  // run, so this is the floor the burst below has to move.
  const before = getPoolerSaturation();
  if (!before) {
    console.log(
      "FAIL: getPoolerSaturation() returned null after the provider initialized — " +
        "no guard was constructed, so the drizzle client cannot be going through one."
    );
    return 1;
  }

  // Deliberately more than the cap, so the FIFO is genuinely entered rather
  // than the burst fitting inside the pool.
  const burst = before.limit * 3;
  const selectOne = () =>
    (
      db as {
        select: (fields: unknown) => {
          from: (t: unknown) => { limit: (n: number) => Promise<unknown[]> };
        };
      }
    )
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .limit(1);

  const startedAt = performance.now();
  const outcomes = await Promise.allSettled(Array.from({ length: burst }, () => selectOne()));
  const elapsedMs = Math.round(performance.now() - startedAt);
  const after = getPoolerSaturation();
  if (!after) {
    console.log("FAIL: getPoolerSaturation() returned null after the burst.");
    return 1;
  }

  const failed = outcomes.filter((o) => o.status === "rejected");
  const checks: Check[] = [
    {
      // The one that would have been impossible before mt#4473.
      name: "drizzle traffic is COUNTED by the guard",
      ok: after.peakInFlight > 0,
      detail: `peakInFlight ${before.peakInFlight} -> ${after.peakInFlight} over ${burst} concurrent drizzle selects`,
    },
    {
      name: "the cap HOLDS on drizzle traffic",
      ok: after.peakInFlight <= after.limit,
      detail: `peakInFlight ${after.peakInFlight} <= limit ${after.limit}`,
    },
    {
      // Non-vacuity: a burst that never reached the cap would satisfy the two
      // checks above while proving nothing about the queue.
      name: "the burst actually reached the cap (test is not vacuous)",
      ok: after.everSaturated && after.peakQueued > 0,
      detail: `everSaturated ${after.everSaturated}, peakQueued ${after.peakQueued}`,
    },
    {
      // SC5, live: the bound must not degrade ordinary operation.
      name: "no caller was refused under an ordinary burst",
      ok: after.refused === before.refused,
      detail: `refused ${before.refused} -> ${after.refused}, burst cleared in ${elapsedMs}ms`,
    },
    {
      // The `.values()` path: a mishandled chain surfaces as a query error or
      // as mis-mapped columns, both of which land here.
      name: "every drizzle select WITH FIELDS succeeded through the guard",
      ok: failed.length === 0,
      detail:
        failed.length === 0
          ? `${burst}/${burst} settled`
          : `${failed.length} rejected: ${String((failed[0] as PromiseRejectedResult).reason)}`,
    },
    {
      name: "exactly one guard is wrapping the client (mt#4298)",
      ok: after.guardCount === 1,
      detail: `guardCount ${after.guardCount}`,
    },
  ];

  for (const check of checks) {
    console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name} — ${check.detail}`);
  }
  console.log(
    `\nsaturation after burst: ${JSON.stringify({
      limit: after.limit,
      peakInFlight: after.peakInFlight,
      peakQueued: after.peakQueued,
      refused: after.refused,
      everSaturated: after.everSaturated,
      guardCount: after.guardCount,
    })}`
  );

  return checks.every((c) => c.ok) ? 0 : 1;
}

process.exit(await main());
