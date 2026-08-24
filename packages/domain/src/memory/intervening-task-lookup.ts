/**
 * Production intervening-task lookup for measurement-decay annotation (mt#4452).
 *
 * The imperative shell around `./measurement-decay`'s pure core, and the sibling of
 * `./task-status-lookup.ts`. Answers one question: since date T, which tasks reached a
 * completed status AND cite one of these subsystems in their spec?
 *
 * ## Why tasks rather than commits
 *
 * mt#4452's `## Mechanism` step 4 reads *"tasks reaching DONE, **or commits** landing on those
 * paths"*. This ships the task half only — a deliberate narrowing, recorded here because it is
 * a deviation from the spec's own wording.
 *
 * The reason is availability, not preference: the hosted `minsky-mcp` service has no git
 * checkout of this repository, so a `git log --since --path` has nothing to run against on the
 * surface where `memory_search` is actually served. A commit-based signal would work locally
 * and silently return nothing in production — the fail-open shape that reads as "nothing
 * intervened" (mem#704).
 *
 * The narrowing was checked against the canonical case before being accepted rather than
 * assumed to be adequate: mt#4345's spec cites `turn-writer.ts` five times and
 * `agent_transcript_turns` twice, both of which mem#773 cites, so the DB-only join reaches the
 * originating incident. Commits remain a follow-on for the local/CLI surface, where git IS
 * available and would add recall for subsystem changes nobody filed a task for — which is
 * precisely the case mt#3170's `## Scope` carves out.
 *
 * @see ./measurement-decay — the pure core this feeds
 * @see ./task-status-lookup — trigger 1's sibling shell
 */

import { and, gte, inArray, or, sql } from "drizzle-orm";
import { taskSpecsTable, tasksTable } from "../storage/schemas/task-embeddings";
import type { MemoryServiceDb } from "./memory-service";
import { COMPLETED_TASK_STATUSES } from "./staleness";

/**
 * Escape a subsystem token for use as a SQL `LIKE` pattern.
 *
 * `_` is a SINGLE-CHARACTER WILDCARD in `LIKE`, and every snake_case identifier this receives
 * is full of them — unescaped, `agent_transcript_turns` matches `agent<any>transcript<any>turns`
 * and silently overmatches. `%` and the escape character itself need the same treatment.
 *
 * Caught in review of PR #3271, and worth naming as the shape rather than the typo: the tokens
 * fed to this function are precisely the ones densest in `LIKE` metacharacters, so the defect
 * is systematic rather than occasional. Paired with an explicit `ESCAPE '\'` below, because
 * Postgres's default escape character inside `LIKE` is the backslash only by convention.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Statuses that mean the work landed. Imported so there is ONE source of truth. */
const COMPLETED_STATUSES = [...COMPLETED_TASK_STATUSES];

/**
 * Cap on how many intervening tasks a single record's annotation reports.
 *
 * The note renders at most three by name, so this bounds the query rather than the prose. A
 * memory citing a busy subsystem can legitimately have dozens; the count is what matters to
 * the reader past the first few.
 */
const MAX_INTERVENING = 25;

export function createInterveningTaskLookup(
  db: MemoryServiceDb
): (
  subsystems: string[],
  since: Date
) => Promise<{ taskId: string; title: string; rowUpdatedAt?: string }[]> {
  return async (subsystems: string[], since: Date) => {
    if (subsystems.length === 0) return [];

    // One LIKE per subsystem, OR'd. `subsystems` comes from the memory's own backticked paths
    // and table names, and is passed as a bound parameter rather than interpolated — the `%`
    // wrapping is the only thing built here.
    const citesAnySubsystem = or(
      ...subsystems.map(
        (s) => sql`${taskSpecsTable.content} LIKE ${`%${escapeLikePattern(s)}%`} ESCAPE '\\'`
      )
    );

    const rows = (await db
      .select({
        id: tasksTable.id,
        title: tasksTable.title,
        updatedAt: tasksTable.updatedAt,
      })
      .from(tasksTable)
      .innerJoin(taskSpecsTable, sql`${taskSpecsTable.taskId} = ${tasksTable.id}`)
      .where(
        and(
          inArray(tasksTable.status, COMPLETED_STATUSES),
          // `updatedAt` stands in for a completion timestamp the `tasks` table does not
          // carry — and it is a WEAK proxy in the direction that hurts, which an earlier
          // draft of this comment got backwards.
          //
          // Any later mutation bumps it: a status correction, a spec patch, a reparent. So a
          // task that completed in June but had its row touched last week satisfies
          // `updatedAt >= since` for a measurement taken two days ago, and reads as having
          // "intervened" when it did nothing of the sort. Measured: the first live run fired
          // on 38 of 39 candidates, including mem#1207 — a baseline recorded ONE DAY earlier
          // — and the same handful of task ids (mt#1880, mt#3918, mt#3919) recurred as
          // "intervening" across unrelated memories, which is the tell that the timestamp,
          // not the subsystem, was doing the matching.
          //
          // This is exactly mt#4420's finding about `task_specs.updated_at` one table over.
          // The floor in `./measurement-decay.ts` bounds the damage; a real fix needs a
          // completion timestamp, which is out of this task's scope and noted in the spec.
          gte(tasksTable.updatedAt, since),
          citesAnySubsystem
        )
      )
      .limit(MAX_INTERVENING)) as { id: string; title: string | null; updatedAt: Date | null }[];

    return rows.map((row) => ({
      taskId: row.id,
      title: row.title ?? "",
      ...(row.updatedAt ? { rowUpdatedAt: row.updatedAt.toISOString() } : {}),
    }));
  };
}
