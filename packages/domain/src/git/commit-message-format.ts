/**
 * Conventional-commit MESSAGE FORMAT validation — the shared check between:
 *
 *  1. The git `commit-msg` hook (`src/hooks/commit-msg.ts`) — the enforcement
 *     BACKSTOP for any commit not made through Minsky's own commit path (e.g.
 *     a bare `git commit` typed at a terminal).
 *  2. `commitImpl` (`./git-core-operations.ts`) — the FAST-FAIL check for the
 *     common case: commits Minsky itself issues via `session_commit` / the
 *     git domain service.
 *
 * ## mt#2821 finding: why this validation moved, and why hooks weren't reordered
 *
 * git's hook lifecycle for `git commit` is fixed, in this order, for every
 * commit regardless of how it is invoked (`-m`, `-F`, or an interactive
 * editor): `pre-commit` -> `prepare-commit-msg` -> (editor, if no message was
 * supplied) -> `commit-msg` -> commit object created -> `post-commit`. This
 * order is enforced by git itself; husky only wraps each named hook file, it
 * does not (and cannot) change git's invocation order between hooks.
 *
 * That means `commit-msg` can never run before `pre-commit` — including for
 * `git commit -m "..."`, where it might seem like the message is "already
 * known." Verified empirically (mt#2821): at `pre-commit` time, `git` has not
 * yet written `.git/COMMIT_EDITMSG`, and no environment variable exposes the
 * pending message either. So the message-format check genuinely cannot run
 * any earlier *within git's own hook chain* — before this fix, a trivial
 * format typo always paid for the full pre-commit suite
 * (tests/lint/typecheck/rules-compile) before the unavoidably-later
 * `commit-msg` hook could reject it.
 *
 * The fix is not a hook reorder (git doesn't allow one) — it is running the
 * SAME check earlier in a different place: in-process, inside `commitImpl`,
 * before it ever shells out to `git commit` at all. For any commit made
 * through Minsky's own tooling (session_commit, the git domain service —
 * the overwhelming majority of commits in this workflow), a malformed
 * message now fails in milliseconds without invoking git or its hooks.
 * `src/hooks/commit-msg.ts` remains the backstop for out-of-band commits.
 */

import {
  CONVENTIONAL_COMMIT_TYPE_ALTERNATION,
  CONVENTIONAL_COMMIT_TYPES_DISPLAY,
} from "./conventional-commit-types";

export interface CommitMessageFormatResult {
  valid: boolean;
  error?: string;
}

/**
 * Placeholder subjects that are always rejected regardless of conventional-
 * commit format compliance. Kept in lockstep with `src/hooks/commit-msg.ts`.
 */
export const FORBIDDEN_COMMIT_MESSAGES = [
  "minimal commit",
  "amended commit",
  "test commit",
  "placeholder commit",
  "temp commit",
  "temporary commit",
  "wip",
  "work in progress",
  "fix",
  "update",
  "change",
];

/**
 * Conventional-commit subject pattern: `type(scope): description`.
 *
 * The description must be non-empty and stay within a sane upper bound; we
 * use 100 characters (rounding up from Conventional Commits' 72-char body
 * wrap and GitHub's 72-char title soft limit) so descriptive `partial:`-
 * prefixed checkpoints from the operating envelope (mt#1524) aren't silently
 * rejected.
 */
export const CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN = 100;

// Not exported: the `custom/no-domain-singleton` ESLint rule (ADR-026) flags
// a top-level "export const" assignment whose initializer is a `new`
// expression, in domain code. (Written with the assignment split across two
// words here so this comment itself doesn't match that rule's grep-based
// architecture test, tests/architecture/di-enforcement.test.ts.) Callers
// that need the pattern go through `validateCommitMessageFormat` below,
// which is the actual shared contract between commitImpl and the hook.
const CONVENTIONAL_COMMIT_PATTERN = new RegExp(
  `^(${CONVENTIONAL_COMMIT_TYPE_ALTERNATION})(\\(.+\\))?: .{1,${CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN}}$`
);

/**
 * Validate a commit message's FIRST LINE (title) against the conventional-
 * commit format + forbidden-placeholder rules.
 *
 * Deliberately excludes the merge-commit branch-name special case that
 * `src/hooks/commit-msg.ts`'s `CommitMsgHook.validateCommitFormat` applies
 * (it requires shelling out to `git branch --show-current`, and merge
 * commits do not flow through `commitImpl` in practice — PR merges go
 * through the GitHub API / `session_pr_merge`, not a local `git commit`).
 * The hook remains the authority for that one case; this function returns
 * `{ valid: true }` for anything that looks like a merge commit so it never
 * produces a false rejection there.
 *
 * An empty (or whitespace-only) message is REJECTED, not skipped (mt#2821
 * PR #1976 R1). `git commit` normally refuses an empty message on its own,
 * but `git commit --allow-empty-message` is a real, if rare, escape hatch —
 * and the whole point of a commit-msg validator is to be the backstop for
 * exactly that kind of deliberate bypass. No Minsky-issued commit path
 * relies on an empty message (the webhook-wake `--allow-empty` flow in
 * `commitImpl` is about EMPTY FILE CHANGES, a different git flag, and always
 * supplies a real message), so rejecting here has no legitimate-flow cost.
 */
export function validateCommitMessageFormat(fullMessage: string): CommitMessageFormatResult {
  const trimmed = fullMessage.trim();
  if (!trimmed) {
    return { valid: false, error: "Commit message cannot be empty" };
  }

  const title = trimmed.split("\n")[0]?.trim() ?? "";
  if (!title) {
    return { valid: false, error: "Commit message cannot be empty" };
  }

  const normalizedMessage = title.toLowerCase();
  if (FORBIDDEN_COMMIT_MESSAGES.includes(normalizedMessage)) {
    return {
      valid: false,
      error: `Forbidden placeholder message: "${title}". Please use a descriptive conventional commit message.`,
    };
  }

  if (trimmed.startsWith("Merge ")) {
    // Branch-specific merge-commit rules live in the hook (requires a git
    // branch lookup this pure function does not perform).
    return { valid: true };
  }

  if (!CONVENTIONAL_COMMIT_PATTERN.test(title)) {
    return {
      valid: false,
      error: `Invalid commit message format. Please use conventional commits format: "type(scope): description"
The description must be 1-${CONVENTIONAL_COMMIT_SUBJECT_MAX_LEN} characters and the type must be one of: ${CONVENTIONAL_COMMIT_TYPES_DISPLAY}.
Examples:
  feat(auth): add user authentication
  fix(#123): resolve login validation issue
  merge(#276): integrate main branch changes
  docs: update README with new features`,
    };
  }

  return { valid: true };
}
