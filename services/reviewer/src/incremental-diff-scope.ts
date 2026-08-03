/**
 * Incremental diff-since-last-review scope resolution (mt#3471).
 *
 * Every review round re-sends the ENTIRE PR diff today, so a PR costs
 * O(rounds x full diff). Re-review rounds are ~68% of all reviewer LLM calls
 * and ~68% of spend, and their median input (412K tokens) is only ~7% below a
 * first review's (444K) — the rounds that should be cheapest are nearly as
 * expensive as the first look.
 *
 * This module decides what a round is shown: the commits pushed since the last
 * posted review when that range resolves, and the full PR diff whenever it does
 * not. The prior review's findings stay in the prompt regardless
 * (`priorReviewsMarkdown`), and the file-reading tools still resolve at HEAD,
 * so narrowing removes re-sent context rather than removing reach.
 *
 * Split out of review-worker.ts so the branch table is directly unit-testable —
 * the same convention as `decideToolsActive` / `decidePostSanitizeOutcome`.
 */

import type { PrFileEntry, IncrementalDiffResult } from "./github-client";
import { log } from "./logger";

/** How a round's diff scope was resolved. */
export type DiffScopeSource =
  /** Narrowed to the commits since the last posted review. */
  | "incremental"
  /** The full PR diff — the flag is off, or nothing narrower was resolvable. */
  | "full";

export interface ResolveDiffScopeInput {
  /** REVIEWER_INCREMENTAL_DIFF_ENABLED, already parsed. */
  enabled: boolean;
  /** The most recent prior review's `commit_id`; undefined on R1 or when absent. */
  priorReviewCommitId: string | undefined;
  /** Current PR HEAD sha. */
  headSha: string;
  /** The whole-PR diff, used whenever narrowing does not apply. */
  fullDiff: string;
  /** The whole-PR file entries, used whenever narrowing does not apply. */
  fullFileEntries: PrFileEntry[];
  /**
   * Fetches the diff between two SHAs. Returns undefined when the range is
   * unresolvable; may also throw (an injected fetcher, a future variant).
   */
  fetchIncremental: (
    baseSha: string,
    headSha: string
  ) => Promise<IncrementalDiffResult | undefined>;
  /** PR number, for log correlation only. */
  prNumber: number;
}

export interface ResolveDiffScopeResult {
  /** The diff this round should be shown. */
  diff: string;
  /** The file entries matching `diff` — chunked review packs from these. */
  fileEntries: PrFileEntry[];
  /** Which branch produced the above. */
  source: DiffScopeSource;
}

/**
 * Resolve the diff scope for one review round.
 *
 * Falls back to the full PR diff — never to a partial or empty scope — when the
 * flag is off, there is no prior review to scope against, the range is
 * unresolvable (force-push orphaned the base, the comparison was truncated or
 * 5xx'd), or the fetch throws. Reviewing the full diff again is a cost
 * regression; reviewing a wrongly-narrowed diff is a correctness regression, so
 * every ambiguous case takes the cost hit.
 *
 * Never throws.
 */
export async function resolveDiffScope(
  input: ResolveDiffScopeInput
): Promise<ResolveDiffScopeResult> {
  const {
    enabled,
    priorReviewCommitId,
    headSha,
    fullDiff,
    fullFileEntries,
    fetchIncremental,
    prNumber,
  } = input;

  const full: ResolveDiffScopeResult = {
    diff: fullDiff,
    fileEntries: fullFileEntries,
    source: "full",
  };

  if (!enabled || priorReviewCommitId === undefined) return full;

  let incremental: IncrementalDiffResult | undefined;
  try {
    incremental = await fetchIncremental(priorReviewCommitId, headSha);
  } catch (err: unknown) {
    // fetchIncrementalDiffSince swallows its own errors and returns undefined;
    // this covers an injected fetcher (or a future variant) that throws.
    const message = err instanceof Error ? err.message : String(err);
    log.warn("reviewer.incremental_diff_failed", {
      event: "reviewer.incremental_diff_failed",
      pr: prNumber,
      baseSha: priorReviewCommitId,
      headSha,
      error: message,
    });
    return full;
  }

  if (incremental === undefined) {
    // Distinct from the failure log above: this is the DESIGNED fallback (no
    // new commits, orphaned base, truncated or 5xx comparison), not an error.
    log.info("reviewer.incremental_diff_fallback_full", {
      event: "reviewer.incremental_diff_fallback_full",
      pr: prNumber,
      baseSha: priorReviewCommitId,
      headSha,
    });
    return full;
  }

  log.info("reviewer.incremental_diff_applied", {
    event: "reviewer.incremental_diff_applied",
    pr: prNumber,
    baseSha: priorReviewCommitId,
    headSha,
    fullDiffChars: fullDiff.length,
    incrementalDiffChars: incremental.diff.length,
    fullFileCount: fullFileEntries.length,
    incrementalFileCount: incremental.fileEntries.length,
  });

  return {
    diff: incremental.diff,
    fileEntries: incremental.fileEntries,
    source: "incremental",
  };
}
