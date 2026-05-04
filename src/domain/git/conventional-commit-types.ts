/**
 * Single source of truth for accepted conventional commit types.
 *
 * The commit-msg hook (`src/hooks/commit-msg.ts`) is the runtime enforcement
 * point — every other consumer (CLI parameter enums, error messages, skill
 * documentation, prompt-generation envelopes) must reflect the same set, or
 * commits that pass an upstream check fail at the hook (mt#1524).
 */

export const CONVENTIONAL_COMMIT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "chore",
  "ci",
  "build",
  "revert",
  "merge",
] as const;

export type ConventionalCommitType = (typeof CONVENTIONAL_COMMIT_TYPES)[number];

/**
 * Pipe-joined alternation suitable for embedding in a regex character class
 * (e.g. `^(feat|fix|...): description`). Order follows
 * `CONVENTIONAL_COMMIT_TYPES` declaration order; this is safe today because
 * all 12 types are disjoint as prefixes (no type is a prefix of another). If
 * a future type is ever a prefix of an existing one (e.g., `feature` added
 * alongside `feat`), this constant should sort longest-first to avoid the
 * regex engine short-circuiting on the shorter alternative.
 */
export const CONVENTIONAL_COMMIT_TYPE_ALTERNATION = CONVENTIONAL_COMMIT_TYPES.join("|");

/**
 * Comma-joined human-readable list for error messages.
 */
export const CONVENTIONAL_COMMIT_TYPES_DISPLAY = CONVENTIONAL_COMMIT_TYPES.join(", ");
