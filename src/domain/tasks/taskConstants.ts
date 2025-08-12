const TEST_VALUE = 123;

import { isQualifiedTaskId } from "./task-id";

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
  CLOSED: "CLOSED",
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
 * Mapping from task status to markdown checkbox representation
 */
export const TASK_STATUS_CHECKBOX: Record<TaskStatus, string> = {
  [TASK_STATUS.TODO]: " ",
  [TASK_STATUS.IN_PROGRESS]: "+",
  [TASK_STATUS.IN_REVIEW]: "-",
  [TASK_STATUS.DONE]: "x",
  [TASK_STATUS.BLOCKED]: "~",
  [TASK_STATUS.CLOSED]: "!",
};

/**
 * Reverse mapping from checkbox to task status
 */
export const CHECKBOX_TO_STATUS: Record<string, TaskStatus> = {
  " ": TASK_STATUS.TODO,
  "+": TASK_STATUS.IN_PROGRESS,
  "-": TASK_STATUS.IN_REVIEW,
  x: TASK_STATUS.DONE,
  X: TASK_STATUS.DONE, // Accept both cases for DONE
  "~": TASK_STATUS.BLOCKED,
  "!": TASK_STATUS.CLOSED,
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
  CLOSED: "!",
};

/**
 * Status validation helper
 */
export function isValidTaskStatus(status: string): status is TaskStatus {
  return Object.values(TASK_STATUS).includes(status as TaskStatus);
}

// ============================================================================
// CENTRALIZED REGEX PATTERNS AND PARSING UTILITIES
// ============================================================================

/**
 * Generate checkbox character pattern dynamically from available statuses
 * This ensures we never have to manually update regex patterns when adding new statuses
 */
function generateCheckboxPattern(): string {
  const specialRegexChars = ["+", "-", "*", "?", "^", "$", "(", ")", "[", "]", "{", "}", "|", "\\"];
  const checkboxChars = Object.keys(CHECKBOX_TO_STATUS)
    .map((char) => {
      if (char === " ") return " ";
      return specialRegexChars.includes(char) ? `\\${char}` : char;
    })
    .join("|");
  return checkboxChars;
}

/**
 * Centralized regex patterns for task parsing
 * These are generated dynamically from the status constants
 */
export const TASK_REGEX_PATTERNS = {
  /**
   * Pattern for matching task lines: - [x] Title [#TEST_VALUE](path)
   * Dynamically includes all valid checkbox characters
   * Supports both numeric and alphanumeric task IDs
   */
  TASK_LINE: new RegExp(
    `^- \\[(${generateCheckboxPattern()})\\] (.+?) \\[([a-z-]*#?[A-Za-z0-9_]+)\\]\\(([^)]+)\\)`
  ),

  /**
   * Pattern for replacing checkbox status in task lines
   * Used for status updates: - [old] -> - [new]
   */
  CHECKBOX_REPLACE: new RegExp(`^(\\s*- \\[)(${generateCheckboxPattern()})(\\])`),

  /**
   * Pattern for detecting any task-like line (for validation)
   */
  TASK_LIKE: /^- \[.\]/,
} as const;

/**
 * Centralized task parsing utilities
 */
export const TASK_PARSING_UTILS = {
  /**
   * Parse a single task line into components
   * @param line The markdown line to parse
   * @returns Parsed components or null if not a valid task line
   */
  parseTaskLine(
    line: string
  ): { checkbox: string; title: string; id: string; specPath?: string } | null {
    const match = TASK_REGEX_PATTERNS.TASK_LINE.exec(line);
    if (!match) return null;

    const [, checkbox, title, fullId, specPath] = match;
    if (!checkbox || !title || !fullId) return null;

    // Use unified task ID system for consistent handling

    let id: string;
    if (isQualifiedTaskId(fullId)) {
      // Qualified ID (md#367) - return as-is
      id = fullId;
    } else if (fullId.startsWith("#")) {
      // Legacy format with # prefix (#123) - return as-is
      id = fullId;
    } else {
      // Legacy format without # prefix (123) - add # prefix
      id = `#${fullId}`;
    }

    return {
      checkbox: checkbox,
      title: title.trim(),
      id: id,
      specPath: specPath,
    };
  },

  /**
   * Replace checkbox status in a task line
   * @param line The original task line
   * @param newStatus The new status to set
   * @returns Updated line with new checkbox status
   */
  replaceCheckboxStatus(line: string, newStatus: TaskStatus): string {
    const newCheckbox = TASK_STATUS_CHECKBOX[newStatus];
    return line.replace(TASK_REGEX_PATTERNS.CHECKBOX_REPLACE, `$1${newCheckbox}$3`);
  },

  /**
   * Get task status from checkbox character
   * @param checkbox The checkbox character
   * @returns TaskStatus or default TODO if invalid
   */
  getStatusFromCheckbox(checkbox: string): TaskStatus {
    return CHECKBOX_TO_STATUS[checkbox] || TASK_STATUS?.TODO;
  },

  /**
   * Get checkbox character from task status
   * @param status The task status
   * @returns Checkbox character
   */
  getCheckboxFromStatus(status: TaskStatus): string {
    return TASK_STATUS_CHECKBOX[status];
  },

  /**
   * Validate if a line looks like a task
   * @param line The line to check
   * @returns True if line has task-like structure
   */
  isTaskLike(line: string): boolean {
    return TASK_REGEX_PATTERNS.TASK_LIKE.test(line);
  },
};
