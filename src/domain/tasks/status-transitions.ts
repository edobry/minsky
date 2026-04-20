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
 * Note: PLANNING → IN-PROGRESS is intentionally excluded here — that transition
 * can only occur via `session_start`, not via direct `tasks_status_set`.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.TODO]: [TaskStatus.PLANNING, TaskStatus.CLOSED],
  [TaskStatus.PLANNING]: [TaskStatus.TODO, TaskStatus.BLOCKED, TaskStatus.CLOSED],
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
  [TaskStatus.BLOCKED]: [TaskStatus.TODO, TaskStatus.PLANNING, TaskStatus.CLOSED],
  [TaskStatus.CLOSED]: [TaskStatus.TODO],
};

/**
 * Validate that a status transition is allowed.
 *
 * Special case: PLANNING → IN-PROGRESS is not a valid direct transition via
 * `tasks_status_set`. It can only happen implicitly via `session_start`.
 *
 * @throws {ValidationError} if the transition is not allowed
 */
export function validateStatusTransition(from: TaskStatus, to: TaskStatus): void {
  // Special case: PLANNING → IN-PROGRESS is reserved for session_start
  if (from === TaskStatus.PLANNING && to === TaskStatus.IN_PROGRESS) {
    throw new ValidationError(
      "Use session_start to transition from PLANNING to IN-PROGRESS",
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
