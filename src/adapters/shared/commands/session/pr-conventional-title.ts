/**
 * Helper to compose and validate conventional commit titles for PR commands
 */

import { ValidationError } from "../../../../errors/index";

// Allow leading whitespace so titles like `"  mt#1265: foo"` are detected and
// stripped — without `\s*` the strip + mismatch checks silently fail.
//
// Capture groups:
//   1. The original prefix substring (e.g. "mt#1265:", "md#409:", "#1265:") —
//      used by mismatch errors to echo the form the user actually supplied.
//   2. The numeric digits — used to compare against the supplied taskId.
//
// The letter-prefix branch accepts ANY 2+-letter project code followed by `#`
// or `-` (e.g. mt#, md#, gh#, mt-) so the helper isn't hardcoded to a single
// project namespace. Bare `#N:` is also accepted (project-less task ID form).
const TASK_ID_PREFIX_RE = /^\s*((?:[a-z]{2,}[#-]|#)(\d+):)\s*/i;

/**
 * Strip a leading task-ID prefix from a title string.
 * Handles any 2+-letter project prefix followed by `#` or `-` (mt#, md#, gh#,
 * mt-, etc.) plus the bare `#N:` form, with optional whitespace before the
 * prefix and after the colon.
 *
 * Note: this helper always strips. Callers that should preserve user-intended
 * prefix context (e.g. when no taskId is supplied) must guard the call site —
 * see `composeConventionalTitle`.
 *
 * @example
 * stripTaskIdPrefix("mt#1265: foo")     // => "foo"
 * stripTaskIdPrefix("md#409: foo")      // => "foo"
 * stripTaskIdPrefix("  #1265: foo")     // => "foo"
 * stripTaskIdPrefix("mt-1265: foo")     // => "foo"
 * stripTaskIdPrefix("foo")              // => "foo"
 */
export function stripTaskIdPrefix(title: string): string {
  return title.replace(TASK_ID_PREFIX_RE, "");
}

/**
 * Result of inspecting a leading task-ID prefix in a title.
 * - `digits`: the numeric portion (used for taskId-digit-comparison)
 * - `original`: the matched prefix substring including the colon (e.g.
 *   `"md#409:"`) — used by error messages so users see the form they typed.
 */
export interface TaskIdPrefixMatch {
  digits: string;
  original: string;
}

/**
 * Return the digits + original-form of a leading task-ID prefix in `title`,
 * or null if there is no such prefix.
 */
export function extractTaskIdPrefix(title: string): TaskIdPrefixMatch | null {
  const match = title.match(TASK_ID_PREFIX_RE);
  if (!match) return null;
  const original = match[1];
  const digits = match[2];
  if (!original || !digits) return null;
  return { digits, original };
}

/**
 * Backwards-compatible wrapper that returns just the digits portion.
 * Prefer `extractTaskIdPrefix` for new callers that need the original form.
 */
export function extractTaskIdDigits(title: string): string | null {
  return extractTaskIdPrefix(title)?.digits ?? null;
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

  // When a taskId is supplied: detect leading task-ID prefix and (a) reject on
  // digit mismatch (could mask a user mistake and associate the change with
  // the wrong task), (b) strip on match.
  //
  // When no taskId is supplied: preserve the user-supplied title verbatim. We
  // can't check for mismatches with no reference, and silently dropping a
  // leading `#1266:` prefix erases potentially intentional context. The
  // conventional-prefix rejection below still fires for `feat: ...`-style
  // titles, just not for `#N: ...` ones.
  const titlePrefix = extractTaskIdPrefix(title);
  let strippedTitle: string;
  if (taskId) {
    if (titlePrefix) {
      const taskIdDigits = taskId.match(/\d+/)?.[0] ?? "";
      // Compare project code (letter portion) too — without this, "md#409"
      // in title with "mt#409" as taskId would silently strip and produce
      // "feat(mt#409): foo", a cross-project reassignment that almost
      // certainly hides a user error. Bare "#N:" (no project code) is
      // permissive: it matches any taskId since the user supplied no project
      // hint of their own.
      const titleProject = titlePrefix.original.match(/^([a-z]{2,})/i)?.[1]?.toLowerCase() ?? "";
      const taskIdProject = taskId.match(/^([a-z]+)/i)?.[1]?.toLowerCase() ?? "";
      const projectMismatch =
        titleProject !== "" && taskIdProject !== "" && titleProject !== taskIdProject;
      const digitsMismatch = titlePrefix.digits !== taskIdDigits;
      if (projectMismatch || digitsMismatch) {
        // Echo the original prefix form (e.g. "mt-1265:" or "md#409:") so the
        // error matches what the user actually typed, not a normalized rendering.
        throw new ValidationError(
          `Title task-ID prefix \`${titlePrefix.original}\` does not match supplied taskId (${taskId}). ` +
            `Either remove the prefix from the title or correct the taskId.`
        );
      }
    }
    strippedTitle = stripTaskIdPrefix(title).trim();
  } else {
    strippedTitle = title.trim();
  }

  // Reject titles that are empty after stripping/trimming. Tailor the error so
  // it doesn't claim a prefix was removed when none was (e.g. user supplied
  // only whitespace and no taskId).
  if (strippedTitle.length === 0) {
    const detail =
      taskId && titlePrefix ? "after removing the task-ID prefix" : "after trimming whitespace";
    throw new ValidationError(`Title cannot be empty ${detail}. Provide a description.`);
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
