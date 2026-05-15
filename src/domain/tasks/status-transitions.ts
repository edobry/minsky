/**
 * Task status transition validation
 *
 * Validates status transitions by dispatching on the task's `kind` field to
 * select the appropriate workflow definition from the registry. This allows
 * each task kind to enforce its own state machine without changes to the gate.
 *
 * Backward compatibility: tasks with no `kind` field default to "implementation",
 * which encodes the existing state machine identically to the previous behaviour.
 *
 * Cross-references:
 *   - mt#1812 — multi-kind workflow system
 *   - src/domain/tasks/workflows.ts — the registry this gate dispatches into
 */

import { TaskStatus } from "./taskConstants";
import { ValidationError } from "../../errors/index";
import { getWorkflow, DEFAULT_KIND } from "./workflows";

/**
 * Valid status transitions for the "implementation" kind (backward-compat export).
 *
 * This constant is retained for callers that import VALID_TRANSITIONS directly
 * (e.g. existing tests). It encodes the same transitions as the "implementation"
 * workflow in the registry. New code should use `getWorkflow(kind).transitions`.
 *
 * Note: PLANNING → IN-PROGRESS and READY → IN-PROGRESS are intentionally excluded
 * here — those transitions can only occur via `session_start`, not via direct
 * `tasks_status_set`.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.TODO]: [TaskStatus.PLANNING, TaskStatus.CLOSED],
  [TaskStatus.PLANNING]: [TaskStatus.READY, TaskStatus.TODO, TaskStatus.BLOCKED, TaskStatus.CLOSED],
  [TaskStatus.READY]: [TaskStatus.PLANNING, TaskStatus.BLOCKED, TaskStatus.CLOSED],
  [TaskStatus.IN_PROGRESS]: [
    TaskStatus.IN_REVIEW,
    TaskStatus.BLOCKED,
    TaskStatus.PLANNING,
    TaskStatus.CLOSED,
  ],
  [TaskStatus.IN_REVIEW]: [
    TaskStatus.IN_PROGRESS,
    TaskStatus.DONE,
    TaskStatus.BLOCKED,
    TaskStatus.CLOSED,
  ],
  [TaskStatus.DONE]: [TaskStatus.CLOSED],
  [TaskStatus.BLOCKED]: [TaskStatus.TODO, TaskStatus.PLANNING, TaskStatus.READY, TaskStatus.CLOSED],
  [TaskStatus.CLOSED]: [TaskStatus.TODO],
};

/**
 * Validate that a status transition is allowed for the given task kind.
 *
 * Dispatches on `kind` to select the per-kind workflow from the registry,
 * then validates the `from → to` transition against that workflow's transition map.
 *
 * Special cases that apply ONLY to the "implementation" kind:
 *   - READY → IN-PROGRESS is reserved for session_start (not allowed via status_set).
 *   - PLANNING → IN-PROGRESS must go through READY first.
 *
 * @param from    Current task status.
 * @param to      Desired next status.
 * @param kind    Task kind (defaults to "implementation" when unset).
 *
 * @throws {ValidationError} if the transition is not allowed by the workflow.
 */
export function validateStatusTransition(from: string, to: string, kind?: string | null): void {
  const resolvedKind = kind || DEFAULT_KIND;

  // Special cases for the "implementation" kind only
  if (resolvedKind === "implementation") {
    // READY → IN-PROGRESS is reserved for session_start
    if (from === TaskStatus.READY && to === TaskStatus.IN_PROGRESS) {
      throw new ValidationError(
        "Use session_start to transition from READY to IN-PROGRESS",
        undefined,
        undefined
      );
    }

    // PLANNING → IN-PROGRESS must go through READY first
    if (from === TaskStatus.PLANNING && to === TaskStatus.IN_PROGRESS) {
      throw new ValidationError(
        "Cannot transition directly from PLANNING to IN-PROGRESS. Set status to READY first, then use session_start.",
        undefined,
        undefined
      );
    }
  }

  const workflow = getWorkflow(resolvedKind);
  const allowed = workflow.transitions[from] ?? [];

  if (!allowed.includes(to)) {
    const validList = allowed.join(", ");
    const kindLabel = resolvedKind !== DEFAULT_KIND ? ` (kind: ${resolvedKind})` : "";
    throw new ValidationError(
      `Cannot transition from ${from} to ${to}${kindLabel}. Valid transitions from ${from}: ${validList || "none"}`,
      undefined,
      undefined
    );
  }
}
