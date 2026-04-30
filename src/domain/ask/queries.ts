/**
 * Ask query helpers for render-time enrichment.
 *
 * These helpers are consumed by task rendering (tasks_list, tasks_get) to
 * derive BLOCKED subtypes from the open Ask associated with a task.
 * They are purely read-only — no state transitions, no mutations.
 *
 * Reference: mt#1072, ADR-008 §Task-lifecycle integration.
 */

import type { Ask } from "./types";
import type { AskRepository } from "./repository";

/**
 * Terminal Ask states — Asks in these states are not "open".
 */
const CLOSED_STATES = new Set(["closed", "cancelled", "expired"]);

/**
 * Returns true when the Ask is still open (not in a terminal state).
 */
function isOpenAsk(ask: Ask): boolean {
  return !CLOSED_STATES.has(ask.state);
}

/**
 * Return the most recent open Ask whose `parentTaskId` matches `taskId`,
 * or `null` when none exists.
 *
 * "Open" means state is not one of: closed / cancelled / expired.
 * When multiple open Asks exist, the one with the latest `createdAt` wins.
 */
export async function getOpenAskForTask(repo: AskRepository, taskId: string): Promise<Ask | null> {
  const all = await repo.listByParentTask(taskId);
  const open = all.filter(isOpenAsk);
  if (open.length === 0) return null;

  // Most recent by createdAt descending
  open.sort((a, b) => (b.createdAt > a.createdAt ? 1 : b.createdAt < a.createdAt ? -1 : 0));
  return open[0] ?? null;
}

/**
 * Batch-fetch the most recent open Ask for each task in `taskIds`.
 *
 * Returns a `Map<taskId, Ask | null>` so callers can look up enrichment
 * for every task in O(1) without an N+1 query.
 *
 * The implementation issues one `listByParentTask` per task.  A future
 * optimisation (single SQL query across all IDs) is left for when the
 * `AskRepository` interface gains a multi-task variant.
 */
export async function getOpenAsksByTaskIds(
  repo: AskRepository,
  taskIds: string[]
): Promise<Map<string, Ask | null>> {
  const result = new Map<string, Ask | null>();
  await Promise.all(
    taskIds.map(async (id) => {
      const ask = await getOpenAskForTask(repo, id);
      result.set(id, ask);
    })
  );
  return result;
}
