/**
 * Shared GitHub-failure classification for session PR commands (mt#2890,
 * extended mt#2888).
 *
 * `classifyMergeError` originated in `workflow-commands.ts` scoped to
 * `session.pr.merge` (mt#2890 — distinguishing a real merge conflict from a
 * transient GitHub rate-limit/5xx degradation that had been mislabeled as a
 * conflict). mt#2888 extends its use to the OTHER GitHub-read command
 * surfaces that can hit the same rate-limit/degraded failure classes —
 * `session.pr.checks`, `session.pr.wait-for-review`, `forge.check_runs_list`
 * — so this module was extracted out of `workflow-commands.ts` to break the
 * circular import that would otherwise result (`workflow-commands.ts`
 * re-exports `createSessionPrChecksCommand` from `pr-checks-command.ts`,
 * which needs to import the classifier).
 *
 * `workflow-commands.ts` re-exports everything from here unchanged, so the
 * pre-existing `workflow-commands-merge-error-classification.test.ts`
 * (importing from `"./workflow-commands"`) keeps working without
 * modification.
 */
import { SessionConflictError } from "@minsky/domain/errors/index";
import { safeTruncate } from "@minsky/shared/safe-truncate";

/**
 * Cap (chars) on the flattened original-error excerpt folded into a
 * structured merge error's `summary` (mt#2890). `buildWireMessage` in
 * mcp-structured-errors.ts only reads `details.tail` / `subprocessOutput` —
 * an arbitrary `details.originalMessage` field is NEVER rendered on the
 * wire — so the excerpt has to live in `summary` itself for operators to
 * see the true failure.
 */
export const MERGE_ERROR_SUMMARY_EXCERPT_LIMIT = 200;

/**
 * Phrases that specifically indicate a REAL, resolved merge conflict —
 * either Minsky's own `mergeable === false` pre-check (github-pr-
 * operations.ts) or GitHub's 405/422 "cannot be merged" diagnosis.
 * Deliberately excludes the bare word "mergeable": mt#2890's
 * unknown-mergeability error ("merge readiness could not be determined...")
 * must NOT be classified as a conflict, and a bare "mergeable" substring
 * match previously caught it.
 */
const MERGE_CONFLICT_PHRASES = [
  "merge conflict",
  "cannot merge",
  "cannot be merged automatically",
  "pull request cannot be merged",
];

/** Discriminated classification of a GitHub-backed command failure (mt#2890, generalized mt#2888). */
export type MergeErrorClass =
  | { kind: "conflict" }
  | { kind: "rate-limit" }
  | { kind: "degraded"; status?: string }
  | { kind: "other" };

/** Flatten an unknown thrown value to a message string. Exported for reuse at call sites that need the original message alongside the classification (e.g. `session.pr.merge`'s catch block). */
export function mergeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
}

/**
 * Classify a GitHub-backed command failure into conflict / rate-limit /
 * degraded(5xx) / other. Narrowed replacement for the prior
 * `isMergeConflictError`, whose bare "mergeable" / "conflict" substring
 * checks mislabeled GitHub's *unknown* mergeability state (surfaced by
 * `pollForMergeableStatus`'s poll-exhausted error) as a false merge
 * conflict — sending operators down the wrong remediation path (rebase)
 * during a rate-limited/degraded GitHub window (mt#2890 root cause).
 *
 * The "conflict" branch is only reachable from `session.pr.merge` (the only
 * caller that can produce a `SessionConflictError` or a merge-conflict-
 * phrase message) — non-merge callers (`session.pr.checks`,
 * `session.pr.wait-for-review`, `forge.check_runs_list`) simply never hit
 * it, since their underlying failures are read errors, not merge-conflict
 * diagnoses.
 *
 * Exported for direct unit testing — see
 * workflow-commands-merge-error-classification.test.ts.
 */
export function classifyMergeError(err: unknown): MergeErrorClass {
  if (err instanceof SessionConflictError) return { kind: "conflict" };

  const rawMessage = mergeErrorMessage(err);
  const msgLower = rawMessage.toLowerCase();

  if (MERGE_CONFLICT_PHRASES.some((phrase) => msgLower.includes(phrase))) {
    return { kind: "conflict" };
  }
  if (msgLower.includes("rate limit")) {
    return { kind: "rate-limit" };
  }
  const degradedMatch = rawMessage.match(/\(HTTP (5\d\d)\)/);
  if (degradedMatch) {
    return { kind: "degraded", status: degradedMatch[1] };
  }
  return { kind: "other" };
}

/**
 * Fold the original error message (flattened to one line, truncated) onto a
 * headline so operators see the true failure instead of just a generic
 * label (mt#2890 — see MERGE_ERROR_SUMMARY_EXCERPT_LIMIT doc above for why
 * this can't just live in `details`).
 *
 * Exported for direct unit testing — see
 * workflow-commands-merge-error-classification.test.ts.
 */
export function withOriginalMessage(headline: string, originalMessage: string): string {
  const flattened = originalMessage.replace(/\s+/g, " ").trim();
  if (!flattened || headline.includes(flattened)) return headline;
  const excerpt = safeTruncate(flattened, MERGE_ERROR_SUMMARY_EXCERPT_LIMIT);
  return `${headline}: ${excerpt}`;
}

// ── Read-path classification (mt#2888, tightened per PR #2018 R1) ────────
//
// `classifyMergeError`'s "rate limit" / "(HTTP 5xx)" matching is a broad
// substring/regex test, tuned for `session.pr.merge`'s narrow job:
// discriminating a REAL merge conflict from a GitHub degradation that had
// been mislabeled as one (mt#2890). Reusing it as-is at the three read-path
// sites (`session.pr.checks`, `session.pr.wait-for-review`,
// `forge.check_runs_list`) creates a DIFFERENT risk those sites didn't have
// before: an already domain-typed error (e.g. `ResourceNotFoundError`,
// `ValidationError`, or a generic wrap from the subcommand's own catch-all)
// whose message merely happens to CONTAIN the substring "rate limit" would
// get silently reclassified into a transport-error shape, discarding its
// original type/message (PR #2018 R1 finding).
//
// `classifyOctokitOriginReadError` closes that gap by matching ONLY the
// EXACT headline text `handleOctokitError` (github-error-handler.ts)
// itself produces for its rate-limit and 5xx-degraded branches — not a
// loose substring. Every read-path failure that is GENUINELY Octokit-
// origin (routed through `handleOctokitError` in the domain repository
// layer) carries one of these two headlines verbatim at the start of its
// message; nothing else plausibly does. This is strictly narrower than
// `classifyMergeError` and is used ONLY at the three read-path sites —
// `classifyMergeError`/`session.pr.merge` are UNCHANGED (mt#2890 behavior
// stays byte-identical).
const OCTOKIT_RATE_LIMIT_HEADLINE = "GitHub Rate Limit Exceeded";
const OCTOKIT_DEGRADED_HEADLINE_PREFIX = "GitHub API degraded/unavailable";

/** Discriminated classification for the read-path sites — narrower than {@link MergeErrorClass} (no "conflict" kind; these sites never produce merge-conflict diagnoses). */
export type ReadErrorClass =
  | { kind: "rate-limit" }
  | { kind: "degraded"; status?: string }
  | { kind: "other" };

/**
 * Classify a read-path (`session.pr.checks` / `session.pr.wait-for-review` /
 * `forge.check_runs_list`) failure into rate-limit / degraded(5xx) / other,
 * matching ONLY `handleOctokitError`'s exact headline text — see the module
 * doc above for why this is deliberately tighter than `classifyMergeError`.
 * `kind: "other"` covers every already domain-typed error (ResourceNotFoundError,
 * ValidationError, a generic subcommand-level wrap, etc.) — callers must
 * preserve/rethrow those unchanged, not reclassify them.
 *
 * Exported for direct unit testing.
 */
export function classifyOctokitOriginReadError(err: unknown): ReadErrorClass {
  const message = mergeErrorMessage(err);
  if (message.startsWith(OCTOKIT_RATE_LIMIT_HEADLINE)) {
    return { kind: "rate-limit" };
  }
  if (message.startsWith(OCTOKIT_DEGRADED_HEADLINE_PREFIX)) {
    const match = message.match(/\(HTTP (5\d\d)\)/);
    return { kind: "degraded", status: match?.[1] };
  }
  return { kind: "other" };
}
