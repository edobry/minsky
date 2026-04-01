/**
 * Helper to compose and validate conventional commit titles for PR commands
 */

import { ValidationError } from "../../../../errors/index";

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

  // Reject titles that already have conventional prefix
  const hasPrefix = /^(?:[a-z]+)(?:\([^)]*\))?:\s*/i.test(title);
  if (hasPrefix) {
    throw new ValidationError(
      "Title should be description only. Do not include conventional prefix like 'feat:' or 'feat(scope):'"
    );
  }

  const scope = taskId ? `(${taskId})` : "";
  return `${type}${scope}: ${title}`.trim();
}
