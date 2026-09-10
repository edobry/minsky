import { isQualifiedTaskId } from "./task-id";
import { TaskBackend } from "../configuration/backend-types";

/**
 * Centralized task status constants
 * This is the single source of truth for all task status-related constants
 */

/**
 * Task status types supported by Minsky
 * Following the same pattern as TaskBackend enum
 */
export enum TaskStatus {
  TODO = "TODO",
  PLANNING = "PLANNING",
  READY = "READY",
  IN_PROGRESS = "IN-PROGRESS",
  IN_REVIEW = "IN-REVIEW",
  DONE = "DONE",
  BLOCKED = "BLOCKED",
  CLOSED = "CLOSED",
  // COMPLETED (the mt#1812 umbrella terminal) was removed by mt#2311: one
  // success terminal (DONE) across all kinds. The Postgres task_status enum
  // still carries the COMPLETED value (PG enums can't drop values); rows were
  // migrated to DONE and the value is a harmless orphan.
}

/**
 * Backward compatibility: Export enum values as TASK_STATUS constants
 * This allows existing code using TASK_STATUS.TODO to continue working
 */
export const TASK_STATUS = TaskStatus;

/**
 * Array of all valid task status values for use in schemas
 */
export const TASK_STATUS_VALUES = Object.values(TaskStatus);

/**
 * Mapping from task status to markdown checkbox representation
 */
export const TASK_STATUS_CHECKBOX: Record<TaskStatus, string> = {
  [TASK_STATUS.TODO]: " ",
  [TASK_STATUS.PLANNING]: "?",
  [TASK_STATUS.READY]: "=",
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
  "?": TASK_STATUS.PLANNING,
  "=": TASK_STATUS.READY,
  "+": TASK_STATUS.IN_PROGRESS,
  "-": TASK_STATUS.IN_REVIEW,
  x: TASK_STATUS.DONE,
  X: TASK_STATUS.DONE, // Accept both cases for DONE
  "~": TASK_STATUS.BLOCKED,
  "!": TASK_STATUS.CLOSED,
  // Legacy COMPLETED checkboxes (pre-mt#2311) map to DONE — the single success
  // terminal that absorbed COMPLETED. Kept in the read-direction map so the
  // generated TASK_LINE regex still MATCHES legacy `- [c]` lines (the regex is
  // built from these keys; dropping them would silently skip such lines, not
  // default them). The write-direction map above has no COMPLETED entry, so
  // "c"/"C" are never emitted for new writes.
  c: TASK_STATUS.DONE,
  C: TASK_STATUS.DONE,
};

/**
 * Forward mapping from task status to checkbox (for task functions compatibility)
 */
export const STATUS_TO_CHECKBOX: Record<string, string> = {
  TODO: " ",
  PLANNING: "?",
  READY: "=",
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
   * Pattern for matching task lines: - [x] Title [mt#123](path)
   * Dynamically includes all valid checkbox characters
   * Supports both numeric and alphanumeric task IDs
   */
  TASK_LINE: new RegExp(
    `^- \\[(${generateCheckboxPattern()})\\] (.+?) \\[([a-z-]*#?[A-Za-z0-9_-]+)\\]\\(([^)]+)\\)`
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

// ============================================================================
// BACKEND UTILITIES FOR CLI UX
// ============================================================================

/**
 * The backend names `--backend` help text advertises.
 *
 * Written with {@link TaskBackend} members rather than bare strings (mt#4673).
 *
 * **It is a hand-picked SUBSET, not an enum derivation** (PR #3704 R2). Saying
 * "derived from TaskBackend" would overstate it: adding a member to that enum
 * does NOT add it here, and it must not — `TaskBackend` holds every backend
 * name the codebase knows, while this answers the narrower question of what
 * `--backend` accepts. Those sets genuinely differ today (`github`, `db`).
 *
 * Stating that precisely matters more than usual here, because a docstring
 * promising more than its code delivers is the exact defect this function is
 * being fixed FOR — see below. Using enum members buys one real thing: renaming
 * a backend breaks the build rather than silently rotting the help text. The
 * set's CORRECTNESS is held by `available-backends.test.ts`, which parses
 * `init.ts`'s own `case` labels and asserts they equal this list.
 * The previous implementation returned a hardcoded `["github", "minsky"]` under
 * a docstring claiming it "ensures backend lists in help text and errors are
 * always up-to-date" — a guarantee a literal cannot make, and the reason the
 * drift below went unnoticed for as long as it did. A call site reading that
 * sentence has no reason to check the value.
 *
 * What it had drifted to: `minsky init --help` advertised `github`, and
 * `minsky init --backend github` answered `Backend "github" is not supported.`
 * — the first flag a new user is required to pass, sending them to a value the
 * command rejects (mt#2929 dogfood, GAP-2). Meanwhile `init`'s own
 * non-interactive error already named the correct pair, so two of this
 * command's three surfaces disagreed with the third.
 *
 * `TaskBackend.GITHUB` ("github") is deliberately EXCLUDED. It exists in the
 * enum, but `init`'s switch accepts only `github-issues` and `minsky`
 * (`packages/domain/src/init.ts`), and mt#4673 settled the alias-or-remove
 * question as remove: adding `github` as an accepted alias would expand the
 * API surface to fix a documentation defect. `TaskBackend.DB` is excluded for
 * the same reason — not accepted by any `--backend` validator.
 *
 * The drift-prevention is the TEST, not this function's shape — stated plainly
 * because the previous version's mistake was expecting a shape to carry that
 * weight on its own.
 */
export function getAvailableBackends(): string[] {
  return [TaskBackend.MINSKY, TaskBackend.GITHUB_ISSUES];
}

/**
 * Get available backends as a formatted string for CLI descriptions
 */
export function getAvailableBackendsString(): string {
  return getAvailableBackends().join(", ");
}

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

    const [, checkbox, title, fullId] = match;
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
      // Local format without # prefix (update-test) - return as-is for consistency
      // This ensures round-trip consistency: store "update-test" → retrieve "update-test"
      id = fullId;
    }

    return {
      checkbox: checkbox,
      title: title.trim(),
      id: id,
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
