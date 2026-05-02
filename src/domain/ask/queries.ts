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
import { isTerminal } from "./state-machine";

/**
 * Returns true when the Ask is still open (not in a terminal state).
 *
 * Delegates to the canonical `isTerminal` predicate from state-machine.ts —
 * single source of truth for terminal-state classification.
 */
function isOpenAsk(ask: Ask): boolean {
  return !isTerminal(ask.state);
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
 * Issues a single `repo.findOpenByTaskIds` call (one SQL `IN (...)` query
 * for the Drizzle backend) and groups the rows by `parentTaskId`. The
 * repository returns rows ordered by `createdAt` descending, so the first
 * row encountered per task is the most recent.
 */
export async function getOpenAsksByTaskIds(
  repo: AskRepository,
  taskIds: string[]
): Promise<Map<string, Ask | null>> {
  const result = new Map<string, Ask | null>();
  for (const id of taskIds) {
    result.set(id, null);
  }
  if (taskIds.length === 0) return result;

  const rows = await repo.findOpenByTaskIds(taskIds);
  for (const row of rows) {
    const taskId = row.parentTaskId;
    if (taskId === undefined) continue;
    if (!result.has(taskId)) continue;
    if (result.get(taskId) === null) {
      result.set(taskId, row);
    }
  }
  return result;
}
