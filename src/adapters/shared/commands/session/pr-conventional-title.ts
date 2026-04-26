/**
 * Helper to compose and validate conventional commit titles for PR commands
 */

import { ValidationError } from "../../../../errors/index";

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
  return title.replace(/^(?:mt#|#|mt-)\d+:\s*/i, "");
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

  // Strip any leading task-ID prefix (e.g. "mt#1265: ") before validation and concatenation
  const strippedTitle = stripTaskIdPrefix(title);

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
