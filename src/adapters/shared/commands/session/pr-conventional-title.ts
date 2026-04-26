/**
 * Helper to compose and validate conventional commit titles for PR commands
 */

import { ValidationError } from "../../../../errors/index";

const TASK_ID_PREFIX_RE = /^(?:mt#|#|mt-)(\d+):\s*/i;

/**
 * Strip a leading task-ID prefix from a title string.
 * Handles forms: `mt#N:`, `#N:`, `mt-N:` (with optional whitespace after the colon).
 *
 * @example
 * stripTaskIdPrefix("mt#1265: foo")  // => "foo"
 * stripTaskIdPrefix("#1265: foo")    // => "foo"
 * stripTaskIdPrefix("mt-1265: foo")  // => "foo"
 * stripTaskIdPrefix("foo")           // => "foo"
 */
export function stripTaskIdPrefix(title: string): string {
  return title.replace(TASK_ID_PREFIX_RE, "");
}

/**
 * Return the numeric digits of a leading task-ID prefix in `title`, or null
 * if there is no such prefix. Used by `composeConventionalTitle` to detect
 * mismatch against the supplied `taskId`.
 */
export function extractTaskIdDigits(title: string): string | null {
  const match = title.match(TASK_ID_PREFIX_RE);
  return match?.[1] ?? null;
}

/**
 * Compose and validate a conventional commit title from type + description + optional task scope
 */
export function composeConventionalTitle(input: {
  type: string | undefined;
  title: string;
  taskId?: string;
}): string {
  const { type, title, taskId } = input;

  // Require type
  if (!type) {
    throw new ValidationError(
      "--type is required. Provide one of: feat, fix, docs, style, refactor, perf, test, chore"
    );
  }

  // Detect a leading task-ID prefix in the title and, if a `taskId` is supplied,
  // verify the digits match. Silently dropping a mismatched ID could associate
  // the change with the wrong task — surface it as a hard error instead.
  const titlePrefixDigits = extractTaskIdDigits(title);
  if (titlePrefixDigits && taskId) {
    const taskIdDigits = taskId.match(/\d+/)?.[0] ?? "";
    if (titlePrefixDigits !== taskIdDigits) {
      throw new ValidationError(
        `Title task-ID prefix (#${titlePrefixDigits}) does not match supplied taskId (${taskId}). ` +
          `Either remove the prefix from the title or correct the taskId.`
      );
    }
  }

  // Strip the (now-validated) leading task-ID prefix and trim whitespace.
  const strippedTitle = stripTaskIdPrefix(title).trim();

  // Reject titles that are empty after stripping — `mt#1265:` and
  // `mt#1265:    ` would otherwise produce dangling-colon output like
  // `feat(mt#1265):` with no description.
  if (strippedTitle.length === 0) {
    throw new ValidationError(
      "Title cannot be empty after removing the task-ID prefix. Provide a description."
    );
  }

  // Compute the prefix that will be auto-added so the error message can name it
  const scope = taskId ? `(${taskId})` : "";
  const autoPrefix = `${type}${scope}:`;

  // Reject titles that already have a conventional commit prefix
  const hasConventionalPrefix = /^(?:[a-z]+)(?:\([^)]*\))?:\s*/i.test(strippedTitle);
  if (hasConventionalPrefix) {
    throw new ValidationError(
      `Title should be description only — the prefix \`${autoPrefix}\` will be added automatically. Pass title without that prefix.`
    );
  }

  return `${type}${scope}: ${strippedTitle}`.trim();
}
