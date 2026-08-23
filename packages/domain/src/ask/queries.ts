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
import { ALL_ASK_STATES, isTerminal } from "./state-machine";
import type { OpenIncidentAskRef } from "./form-lint";

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
/**
 * Cap on how many open incident asks the duplicate check compares against
 * (mt#4312).
 *
 * Grounded rather than round: the corpus has produced at most a handful of
 * concurrently-open incident asks, and the pair this exists for were 40 seconds
 * apart — so the duplicate is always among the most recent. A cap bounds the
 * cost of a read that now sits on every incident create.
 */
export const OPEN_INCIDENT_ASK_SCAN_LIMIT = 20;

/**
 * Open, operator-routed asks carrying `severity: "incident"` (mt#4312).
 *
 * Feeds `computeFormLintMatches`'s `duplicate-open-incident` check — the read
 * lives here, in the imperative shell, so the lint itself stays a pure function
 * of its input.
 *
 * Operator-routed only, because that is what "paged the principal" means: since
 * mt#3851 the incident marker forces `routingTarget: operator` for every kind,
 * so an incident ask that did not reach the operator is not the thing this
 * check is protecting against.
 *
 * **Best-effort by construction.** A failure here must not fail ask creation —
 * the ask IS the decision record, and losing it to a degraded read on an
 * ADVISORY check would be a strictly worse outcome than the duplicate page the
 * check exists to prevent. Callers get `[]`, which the lint treats as "not
 * checking", not as "no duplicates exist".
 */
export async function getOpenIncidentAsks(
  repo: AskRepository,
  limit: number = OPEN_INCIDENT_ASK_SCAN_LIMIT
): Promise<OpenIncidentAskRef[]> {
  const openStates = ALL_ASK_STATES.filter((s) => !isTerminal(s));
  try {
    const { asks } = await repo.listByStatesForRoutingTarget({
      states: openStates,
      routingTarget: "operator",
      limit,
    });
    return asks
      .filter((a) => a.severity === "incident")
      .map((a) => ({ shortId: a.shortId ?? a.id, question: a.question }));
  } catch {
    // Intentional: see the best-effort note above. A degraded read yields no
    // comparison rather than a failed create.
    return [];
  }
}

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
