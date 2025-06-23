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
  x: TASK_STATUS.DONE,
  X: TASK_STATUS.DONE, // Accept both cases for DONE
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
export function isValidTaskStatus(_status: string): status is TaskStatus {
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
  const checkboxChars = Object.keys(CHECKBOX_TO_STATUS)
    .map((char) => (char === " " ? " " : `\\${char}`)) // Escape special regex chars except space
    .join("|");
  return checkboxChars;
}

/**
 * Centralized regex patterns for task parsing
 * These are generated dynamically from the status constants
 */
export const TASK_REGEX_PATTERNS = {
  /**
   * Pattern for matching task lines: - [x] Title [#123](path)
   * Dynamically includes all valid checkbox characters
   */
  TASK_LINE: new RegExp(`^- \\[(${generateCheckboxPattern()})\\] (.+?) \\[#(\\d+)\\]\\([^)]+\\)`),

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
  parseTaskLine(line: string): { checkbox: string; title: string; id: string } | null {
    const match = TASK_REGEX_PATTERNS.TASK_LINE.exec(line);
    if (!match) return null;

    const [, checkbox, _title, idNum] = match;
    if (!checkbox || !title || !idNum) return null;

    return {
      checkbox: checkbox,
      _title: title.trim(),
      id: `#${idNum}`,
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
    return CHECKBOX_TO_STATUS[checkbox] || TASK_STATUS.TODO;
  },

  /**
   * Get checkbox character from task status
   * @param status The task status
   * @returns Checkbox character
   */
  getCheckboxFromStatus(_status: TaskStatus): string {
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
} as const;
