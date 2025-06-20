/**
 * Centralized task status constants
 * This is the single source of truth for all task status-related constants
 */

/**
 * Valid task status values
 */
export const TASK_STATUS = {
  TODO: "TODO",
  IN_PROGRESS: "IN-PROGRESS", 
  IN_REVIEW: "IN-REVIEW",
  DONE: "DONE",
  BLOCKED: "BLOCKED",
} as const;

/**
 * Task status type derived from the constants
 */
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/**
 * Array of all valid task status values for use in schemas
 */
export const TASK_STATUS_VALUES = Object.values(TASK_STATUS);

/**
 * Enum version for TypeScript strict typing
 */
export enum TaskStatusType {
  TODO = "TODO",
  IN_PROGRESS = "IN-PROGRESS",
  IN_REVIEW = "IN-REVIEW", 
  DONE = "DONE",
  BLOCKED = "BLOCKED",
}

/**
 * Mapping from task status to markdown checkbox representation
 */
export const TASK_STATUS_CHECKBOX: Record<TaskStatus, string> = {
  [TASK_STATUS.TODO]: " ",
  [TASK_STATUS.IN_PROGRESS]: "+",
  [TASK_STATUS.IN_REVIEW]: "-", 
  [TASK_STATUS.DONE]: "x",
  [TASK_STATUS.BLOCKED]: "~",
};

/**
 * Reverse mapping from checkbox to task status
 */
export const CHECKBOX_TO_STATUS: Record<string, TaskStatus> = {
  " ": TASK_STATUS.TODO,
  "+": TASK_STATUS.IN_PROGRESS,
  "-": TASK_STATUS.IN_REVIEW,
  "x": TASK_STATUS.DONE,
  "X": TASK_STATUS.DONE, // Accept both cases for DONE
  "~": TASK_STATUS.BLOCKED,
};

/**
 * Forward mapping from task status to checkbox (for task functions compatibility)
 */
export const STATUS_TO_CHECKBOX: Record<string, string> = {
  TODO: " ",
  "IN-PROGRESS": "+",
  "IN-REVIEW": "-",
  DONE: "x",
  BLOCKED: "~",
};

/**
 * Status validation helper
 */
export function isValidTaskStatus(status: string): status is TaskStatus {
  return Object.values(TASK_STATUS).includes(status as TaskStatus);
} 
