/**
 * Local reviewer-bot watcher — detection logic.
 *
 * Mirrors `services/reviewer/src/sweeper.ts` (mt#1260) detection but isolated
 * from that service's other concerns (retrigger, scheduler, draft policy). The
 * watcher only needs to identify "open PR with no non-dismissed review by the
 * bot at HEAD"; retrigger continues to live in the Railway sweeper.
 *
 * The `MissedReviewClient` interface is the narrow projection of GitHub the
 * detector needs; production wiring constructs an Octokit-backed adapter
 * (see `src/adapters/shared/commands/reviewer-watch-github-client.ts`).
 * Tests inject a fake.
 */

import { REASON_COMMIT_ID_MISMATCH, REASON_NO_REVIEW_BY_BOT, type MissingReviewPR } from "./types";

/** A minimal view of an open pull request. */
export interface OpenPR {
  number: number;
  headSha: string;
  authorLogin: string;
  htmlUrl: string;
  /** Whether the PR is a draft (drafts are skipped). */
  draft: boolean;
}

/** A minimal view of a review on a pull request. */
export interface PRReviewSummary {
  /** Reviewer login (e.g., `"minsky-reviewer[bot]"` or `null` for deleted accounts). */
  reviewerLogin: string | null;
  /** Commit SHA the review targeted. */
  commitId: string;
  /** Review state — only `"DISMISSED"` is special-cased. */
  state: string;
}

/**
 * Narrow GitHub interface the detector depends on. Production wiring goes
 * through Octokit + the project's TokenProvider; tests inject a fake.
 */
export interface MissedReviewClient {
  /** List all open PRs in the configured repo. */
  listOpenPRs(owner: string, repo: string): Promise<OpenPR[]>;

  /** List all reviews on a single PR. */
  listReviews(owner: string, repo: string, prNumber: number): Promise<PRReviewSummary[]>;
}

/**
 * Determine whether a single PR is missing a non-dismissed review by `botLogin`
 * at its current `headSha`. Returns a `MissingReviewPR` if so, otherwise null.
 *
 * Filter rules mirror `services/reviewer/src/sweeper.ts:detectMissingReview`:
 *   - case-insensitive login match
 *   - `null` reviewer logins (deleted accounts) cannot match
 *   - DISMISSED reviews don't count as "the bot reviewed this PR" — they
 *     signal a human override of the bot review
 */
export async function detectMissingReviewForPR(
  client: MissedReviewClient,
  owner: string,
  repo: string,
  pr: OpenPR,
  botLogin: string
): Promise<MissingReviewPR | null> {
  const reviews = await client.listReviews(owner, repo, pr.number);

  const botReviews = reviews.filter(
    (r) =>
      (r.reviewerLogin?.toLowerCase() ?? "") === botLogin.toLowerCase() && r.state !== "DISMISSED"
  );

  if (botReviews.length === 0) {
    return {
      number: pr.number,
      headSha: pr.headSha,
      authorLogin: pr.authorLogin,
      reason: REASON_NO_REVIEW_BY_BOT,
      htmlUrl: pr.htmlUrl,
    };
  }

  const hasReviewAtHead = botReviews.some((r) => r.commitId === pr.headSha);
  if (!hasReviewAtHead) {
    return {
      number: pr.number,
      headSha: pr.headSha,
      authorLogin: pr.authorLogin,
      reason: REASON_COMMIT_ID_MISMATCH,
      htmlUrl: pr.htmlUrl,
    };
  }

  return null;
}

/**
 * Scan all open PRs in the configured repo for missing-review conditions.
 *
 * Drafts are skipped (mirrors the Railway sweeper / webhook-handler skip
 * policy). The returned list is in PR-number order from `listOpenPRs`; the
 * caller is responsible for any subsequent sorting / formatting.
 */
export async function detectMissingReviews(
  client: MissedReviewClient,
  owner: string,
  repo: string,
  botLogin: string
): Promise<{ scanned: number; missing: MissingReviewPR[] }> {
  const openPRs = await client.listOpenPRs(owner, repo);
  const missing: MissingReviewPR[] = [];

  for (const pr of openPRs) {
    if (pr.draft) continue;

    const detected = await detectMissingReviewForPR(client, owner, repo, pr, botLogin);
    if (detected !== null) missing.push(detected);
  }

  return { scanned: openPRs.length, missing };
}
