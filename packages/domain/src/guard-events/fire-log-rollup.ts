/**
 * Incremental maintenance of the per-guard fire-log lifetime rollup (mt#4294).
 *
 * The table's own doc comment (`storage/schemas/guard-events-schema.ts`,
 * `guardEventFireLogRollupTable`) carries the measurements and the rejected
 * alternatives. This module is the read/write path for it.
 *
 * Split deliberately into a pure core and a thin SQL shell:
 *
 * - `aggregateFireLogDeltas` folds a batch of just-inserted rows into per-guard
 *   deltas. Pure, total, and the whole of the interesting logic — which stream
 *   counts, how a null `occurred_at` is treated, how min/max combine.
 * - `applyFireLogDeltas` / `rebuildFireLogLifetimeRollup` do the SQL.
 *
 * The split exists so the folding rules can be tested against values rather
 * than against a patched database handle (`testing-standards.mdc §Testable
 * Design`).
 */

import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  guardEventFireLogRollupTable,
  guardEventsTable,
} from "../storage/schemas/guard-events-schema";
import { FIRE_LOG_STREAM } from "./aggregates";

/**
 * The stream whose rows this rollup summarizes.
 *
 * Re-exported from `aggregates.ts` rather than redeclared (PR #3191 R1): the
 * fold below and `fireLogWhere` there must select the same population, and two
 * literals that must stay equal are a divergence waiting to happen.
 *
 * No import cycle: `aggregates.ts` does not reference this module.
 */
export { FIRE_LOG_STREAM };

/**
 * The write surface the fold needs.
 *
 * Structural rather than `PostgresJsDatabase`, so a transaction handle
 * satisfies it directly. Drizzle's transaction type exposes the same builder
 * but is not assignable to the database type, and the fold MUST be callable
 * with a transaction — sharing the append's transaction is what keeps the
 * rollup from drifting (see `buildInsertBatch`).
 */
export type FireLogRollupWriter = Pick<PostgresJsDatabase, "insert">;

/**
 * The subset of an inserted row this rollup needs.
 *
 * Structurally satisfied by what `buildInsertBatch`'s `RETURNING` clause
 * yields, so the caller passes its returned rows straight through.
 */
export interface FireLogRollupSourceRow {
  stream: string;
  guardName: string | null;
  occurredAt: Date | null;
}

/** A per-guard delta to fold into the rollup. */
export interface FireLogRollupDelta {
  guardName: string;
  /** Rows appended for this guard in this batch. Always >= 1 (a zero delta is never emitted). */
  addedFires: number;
  /** Earliest non-null `occurredAt` in the batch, or null if the batch had none. */
  minOccurredAt: Date | null;
  /** Latest non-null `occurredAt` in the batch, or null if the batch had none. */
  maxOccurredAt: Date | null;
}

/**
 * Fold a batch of ACTUALLY-INSERTED rows into per-guard deltas.
 *
 * Two rules that are easy to get subtly wrong, so they are stated rather than
 * left to the reader of the SQL:
 *
 * 1. **A null `occurredAt` still counts.** `guard_events.occurred_at` is
 *    nullable, and the query this rollup replaces used `count(*)` — which
 *    counts such a row — alongside `min`/`max`, which skip it. Counting only
 *    timestamped rows here would make the rollup disagree with the figure it
 *    is replacing, for exactly the guards whose records are malformed.
 * 2. **Only the fire-log stream, only non-null guard names.** Mirrors
 *    `fireLogWhere` (`stream = 'fire-log' AND guard_name IS NOT NULL`) — and
 *    mirrors it EXACTLY, which is the whole requirement. A row failing either
 *    test contributes nothing; it is not an error, just another stream's row
 *    riding the same insert batch.
 *
 *    **An empty-string guard name is NOT skipped, deliberately** (PR #3191 R1).
 *    An earlier version treated `""` as absent, which felt like tidying up
 *    malformed data and was a drift bug: `IS NOT NULL` is TRUE for the empty
 *    string, so the backfill and `rebuildFireLogLifetimeRollup` both COUNT such
 *    a row while the incremental fold silently dropped it. The two paths must
 *    agree exactly or a rebuild changes the numbers, and a rollup whose value
 *    depends on whether it was rebuilt is worse than one that faithfully
 *    reproduces a malformed input. The predicate here is the SQL predicate, not
 *    a better-judgment version of it.
 *
 * @param rows Rows the insert actually appended (post-`ON CONFLICT DO NOTHING`).
 * @returns One delta per guard present in the batch; empty when the batch has none.
 */
export function aggregateFireLogDeltas(
  rows: readonly FireLogRollupSourceRow[]
): FireLogRollupDelta[] {
  const byGuard = new Map<string, FireLogRollupDelta>();

  for (const row of rows) {
    if (row.stream !== FIRE_LOG_STREAM) continue;
    const guardName = row.guardName;
    // NULL only — see rule 2 above. `guardName === ""` must NOT be excluded
    // here: SQL's `IS NOT NULL` admits it, so excluding it drifts the fold from
    // the backfill and the rebuild.
    if (guardName === null) continue;

    const existing = byGuard.get(guardName);
    const occurredAt = row.occurredAt ?? null;

    if (existing === undefined) {
      byGuard.set(guardName, {
        guardName,
        addedFires: 1,
        minOccurredAt: occurredAt,
        maxOccurredAt: occurredAt,
      });
      continue;
    }

    existing.addedFires += 1;
    if (occurredAt !== null) {
      // A null on either side loses to a real timestamp — the accumulator may
      // still be null from a run of untimestamped rows.
      if (existing.minOccurredAt === null || occurredAt < existing.minOccurredAt) {
        existing.minOccurredAt = occurredAt;
      }
      if (existing.maxOccurredAt === null || occurredAt > existing.maxOccurredAt) {
        existing.maxOccurredAt = occurredAt;
      }
    }
  }

  return [...byGuard.values()];
}

/**
 * Apply per-guard deltas to the rollup table.
 *
 * `LEAST`/`GREATEST` are null-tolerant in Postgres (they ignore null
 * arguments and return the other), which is exactly the combine rule wanted
 * here: a guard whose stored `first_fire_at` is null because its earlier rows
 * were untimestamped adopts the first real timestamp that arrives, rather than
 * staying null forever or being clobbered to null by a later untimestamped
 * batch.
 *
 * No-op on an empty delta list — an ingest tick that appended nothing must not
 * issue a write.
 */
export async function applyFireLogDeltas(
  db: FireLogRollupWriter,
  deltas: readonly FireLogRollupDelta[]
): Promise<void> {
  if (deltas.length === 0) return;

  await db
    .insert(guardEventFireLogRollupTable)
    .values(
      deltas.map((d) => ({
        guardName: d.guardName,
        totalFires: d.addedFires,
        firstFireAt: d.minOccurredAt,
        lastFireAt: d.maxOccurredAt,
      }))
    )
    .onConflictDoUpdate({
      target: guardEventFireLogRollupTable.guardName,
      set: {
        totalFires: sql`${guardEventFireLogRollupTable.totalFires} + excluded.total_fires`,
        firstFireAt: sql`least(${guardEventFireLogRollupTable.firstFireAt}, excluded.first_fire_at)`,
        lastFireAt: sql`greatest(${guardEventFireLogRollupTable.lastFireAt}, excluded.last_fire_at)`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * Fold a batch of just-inserted rows into the rollup. The composition callers
 * want: aggregate, then apply.
 */
export async function foldFireLogRowsIntoRollup(
  db: FireLogRollupWriter,
  rows: readonly FireLogRollupSourceRow[]
): Promise<void> {
  await applyFireLogDeltas(db, aggregateFireLogDeltas(rows));
}

/**
 * Recompute the entire rollup from `guard_events`.
 *
 * This is the ONE place the expensive full-table `GROUP BY` still runs, and it
 * is deliberate: bootstrap needs it once, and self-heal needs it available.
 * It must never be on a read path — that is the defect mt#4294 exists to fix.
 *
 * Runs as a single statement so the rollup is never observed half-rebuilt:
 * `DELETE` of rows that no longer appear plus an upsert of every current group,
 * inside one transaction.
 *
 * Note this is a REPLACE, not a merge: `total_fires` is SET from the recompute
 * rather than added to, so running it twice is idempotent and running it after
 * drift corrects rather than compounds.
 */
export async function rebuildFireLogLifetimeRollup(
  db: PostgresJsDatabase
): Promise<{ guardsRolledUp: number }> {
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into ${guardEventFireLogRollupTable} (guard_name, total_fires, first_fire_at, last_fire_at, updated_at)
      select
        ${guardEventsTable.guardName},
        count(*)::int,
        min(${guardEventsTable.occurredAt}),
        max(${guardEventsTable.occurredAt}),
        now()
      from ${guardEventsTable}
      where ${guardEventsTable.stream} = ${FIRE_LOG_STREAM}
        and ${guardEventsTable.guardName} is not null
      group by ${guardEventsTable.guardName}
      on conflict (guard_name) do update set
        total_fires = excluded.total_fires,
        first_fire_at = excluded.first_fire_at,
        last_fire_at = excluded.last_fire_at,
        updated_at = now()
    `);

    // A guard present in the rollup but absent from the corpus can only come
    // from drift or from rows being removed out-of-band; drop it so a rebuild
    // is a true recompute rather than a monotonic union.
    await tx.execute(sql`
      delete from ${guardEventFireLogRollupTable}
      where guard_name not in (
        select distinct ${guardEventsTable.guardName}
        from ${guardEventsTable}
        where ${guardEventsTable.stream} = ${FIRE_LOG_STREAM}
          and ${guardEventsTable.guardName} is not null
      )
    `);

    const counted = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(guardEventFireLogRollupTable);
    return { guardsRolledUp: counted[0]?.n ?? 0 };
  });

  return result;
}
