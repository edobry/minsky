/**
 * Task status transition validation
 *
 * Defines the valid state machine transitions for task statuses and provides
 * a validation function that throws descriptive errors on invalid transitions.
 */

import { TaskStatus } from "./taskConstants";
import { ValidationError } from "../../errors/index";

/**
 * Valid status transitions for each status.
 *
 * Note: PLANNING → IN-PROGRESS and READY → IN-PROGRESS are intentionally excluded here —
 * those transitions can only occur via `session_start`, not via direct `tasks_status_set`.
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
 * Validate that a status transition is allowed.
 *
 * Special cases: PLANNING → IN-PROGRESS and READY → IN-PROGRESS are not valid
 * direct transitions via `tasks_status_set`. They can only happen via `session_start`.
 *
 * @throws {ValidationError} if the transition is not allowed
 */
export function validateStatusTransition(from: TaskStatus, to: TaskStatus): void {
  // Special case: READY → IN-PROGRESS is reserved for session_start
  if (from === TaskStatus.READY && to === TaskStatus.IN_PROGRESS) {
    throw new ValidationError(
      "Use session_start to transition from READY to IN-PROGRESS",
      undefined,
      undefined
    );
  }

  // Special case: PLANNING → IN-PROGRESS must go through READY first
  if (from === TaskStatus.PLANNING && to === TaskStatus.IN_PROGRESS) {
    throw new ValidationError(
      "Cannot transition directly from PLANNING to IN-PROGRESS. Set status to READY first, then use session_start.",
      undefined,
      undefined
    );
  }

  const allowed = VALID_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    const validList = allowed.map((s) => s).join(", ");
    throw new ValidationError(
      `Cannot transition from ${from} to ${to}. Valid transitions from ${from}: ${validList || "none"}`,
      undefined,
      undefined
    );
  }
}
