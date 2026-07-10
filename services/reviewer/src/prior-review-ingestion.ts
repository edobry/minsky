/**
 * Prior-review ingestion (mt#2731).
 *
 * Fetches prior bot reviews on the PR, sanitizes each body (SC-2 mt#1189 — a
 * CoT leak in a prior review must not contaminate this iteration's prompt),
 * summarizes them, and extracts the flat findings the monotonicity-recovery
 * layer (mt#1496) consumes. Non-blocking: any fetch error yields an empty
 * ingestion with the error recorded, and the review proceeds without prior
 * context.
 *
 * Extracted verbatim from runReviewBody; behavior-preserving.
 */

import { fetchPriorReviews } from "./github-client";
import { sanitizeReviewBody } from "./sanitize";
import { summarizePriorReviews, countBlockingFindings } from "./prior-review-summary";
import { parsePriorReviewFindings, type FlatPriorFinding } from "./severity-recovery";
import { log } from "./logger";
import type { PriorReviewFetcherFn, PriorReviewIngestionResult } from "./review-worker";

export interface IngestPriorReviewsInput {
  /** Test seam; defaults to fetchPriorReviews from github-client. */
  fetcher?: PriorReviewFetcherFn;
  octokit: Parameters<PriorReviewFetcherFn>[0];
  owner: string;
  repo: string;
  prNumber: number;
  timeoutMs?: number;
  /** PR HEAD sha — used to mark prior reviews stale (posted against an older commit). */
  headSha: string;
}

export interface IngestPriorReviewsResult {
  ingestion: PriorReviewIngestionResult;
  /** Rendered prior-reviews markdown for the prompt ("" when none / on error). */
  markdown: string;
  /** Flat prior findings for the monotonicity-recovery layer ([] when none / on error). */
  flatFindings: FlatPriorFinding[];
}

/**
 * Fetch + sanitize + summarize prior reviews. Never throws — a fetch error is
 * caught and reported as an empty ingestion (with `error` set).
 */
export async function ingestPriorReviews(
  input: IngestPriorReviewsInput
): Promise<IngestPriorReviewsResult> {
  const { fetcher, octokit, owner, repo, prNumber, timeoutMs, headSha } = input;
  const priorReviewFetcherFn = fetcher ?? fetchPriorReviews;

  try {
    const rawPriorReviews = await priorReviewFetcherFn(octokit, owner, repo, prNumber, timeoutMs);
    // SC-2 (mt#1189): sanitize each prior review body before ingestion so that
    // CoT scratch leaked into a prior review cannot contaminate this iteration's
    // prompt. sanitizeReviewBody is non-throwing — it always returns a result.
    const priorReviews = rawPriorReviews.map((r) => ({
      ...r,
      body: sanitizeReviewBody(r.body).body,
    }));
    const summary = summarizePriorReviews(priorReviews, headSha);
    return {
      ingestion: {
        iterationCount: summary.iterationCount,
        staleCount: summary.reviews.filter((r) => r.isStale).length,
        priorBlockingCounts: priorReviews.map((r) => countBlockingFindings(r.body)),
      },
      markdown: summary.markdown,
      // mt#1496: extract flat findings from prior bodies for the monotonicity-
      // recovery layer. Always computed (cheap) regardless of the feature flag,
      // so the wiring is symmetric across flag states.
      flatFindings: parsePriorReviewFindings(priorReviews.map((r) => r.body)),
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(`[mt#1189] Prior-review fetch failed, continuing without context: ${errorMessage}`);
    return {
      ingestion: {
        iterationCount: 0,
        staleCount: 0,
        priorBlockingCounts: [],
        error: errorMessage,
      },
      markdown: "",
      flatFindings: [],
    };
  }
}
