/**
 * Production task-status lookup for memory-staleness annotation (mt#1709).
 *
 * The imperative shell around `./staleness`'s pure core: this is the only piece that talks
 * to a database, which is what lets the detection logic itself be exercised with object
 * literals and a `Map`.
 *
 * ONE query per search, not one per result. `MemoryService.annotateStaleness` unions the
 * refs from every result before calling this, so the `inArray` below covers the whole page
 * (`efficient-database-queries` — no I/O in a loop).
 *
 * ## Every requested id appears in the returned map
 *
 * Ids are pre-seeded to `undefined` and then overwritten by whatever the query found. That
 * is not defensive padding — it is the contract `computeStaleness` reads: a task id that
 * does not resolve must come back as an explicit "unknown", so the verdict is `unresolved`
 * rather than `current`. If this returned only the found rows, a memory whose tracking task
 * was deleted (or misspelled in its own body) would silently read as "nothing is stale" —
 * a check that could not run, presenting as a check that passed.
 *
 * @see ./staleness — the pure core this feeds
 * @see mt#1709
 */

import { inArray } from "drizzle-orm";
import { tasksTable } from "../storage/schemas/task-embeddings";
import type { MemoryServiceDb } from "./memory-service";

/**
 * Build the batched lookup to hand to `MemoryServiceDeps.taskStatusLookup`.
 *
 * Errors are NOT swallowed here — `annotateStaleness` catches them and degrades to
 * unannotated results, so a caller that wants a different policy can have one.
 */
export function createTaskStatusLookup(
  db: MemoryServiceDb
): (taskIds: string[]) => Promise<ReadonlyMap<string, string | undefined>> {
  return async (taskIds: string[]) => {
    const statuses = new Map<string, string | undefined>();
    for (const id of taskIds) statuses.set(id, undefined);

    if (taskIds.length === 0) return statuses;

    const rows = (await db
      .select({ id: tasksTable.id, status: tasksTable.status })
      .from(tasksTable)
      .where(inArray(tasksTable.id, taskIds))) as { id: string; status: string | null }[];

    for (const row of rows) {
      if (row.id) statuses.set(row.id, row.status ?? undefined);
    }

    return statuses;
  };
}
