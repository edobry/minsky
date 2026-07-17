/**
 * Commit-message ingestion for author-response context (mt#2836).
 *
 * Fetches commit messages pushed to the PR since the most recent prior
 * review, sanitizes each (same CoT-leakage defense as prior-review-ingestion.ts
 * — a commit message is author-controlled free text and could, in principle,
 * carry a CoT-leakage-shaped payload), and renders both a prompt-injectable
 * markdown block and the raw message list the refutation-recovery pass
 * consumes.
 *
 * Non-blocking: any fetch error yields an empty ingestion with the error
 * recorded, and the review proceeds without commit-message context — mirrors
 * ingestPriorReviews' error posture (prior-review-ingestion.ts).
 *
 * Only meaningful when a prior review exists (R>=2); callers should skip
 * invoking this on R1 (there is nothing to respond to yet, and there is no
 * `sinceIso` bound to fetch against).
 */

import { fetchCommitMessagesSince, type PullRequestCommit } from "./github-client";
import { sanitizeReviewBody } from "./sanitize";
import { safeTruncate } from "@minsky/shared/safe-truncate";
import { log } from "./logger";
import type { Octokit } from "@octokit/rest";

/** Injectable fetcher type, for test seams. Defaults to fetchCommitMessagesSince. */
export type CommitMessageFetcherFn = typeof fetchCommitMessagesSince;

export interface IngestCommitMessagesInput {
  /** Test seam; defaults to fetchCommitMessagesSince from github-client. */
  fetcher?: CommitMessageFetcherFn;
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  /** Lower bound for the fetch — typically the most recent prior review's submittedAt. */
  sinceIso: string;
  timeoutMs?: number;
}

export interface IngestCommitMessagesResult {
  /** Sanitized commit messages, oldest-first ([] when none / on error). */
  messages: string[];
  /**
   * Rendered "## Commits Since Last Review" markdown for prompt injection
   * ("" when none / on error).
   */
  markdown: string;
  /** Set when the fetch threw an error; review still proceeds without this context. */
  error?: string;
}

/** Max commit messages rendered into the prompt block, to bound prompt growth on long-lived PRs. */
const MAX_COMMITS_IN_MARKDOWN = 30;

/** Max characters of a single commit message embedded in the prompt block. */
const MAX_MESSAGE_CHARS_IN_MARKDOWN = 500;

function renderMarkdown(commits: ReadonlyArray<PullRequestCommit & { message: string }>): string {
  if (commits.length === 0) return "";
  const shown = commits.slice(0, MAX_COMMITS_IN_MARKDOWN);
  const omitted = commits.length - shown.length;
  const lines = [
    `## Commits Since Last Review (${commits.length})`,
    "",
    "These commits were pushed after the most recent prior review. They may contain the " +
      "author's response to a prior finding — including refutation evidence. If a BLOCKING " +
      "finding you are about to re-assert is addressed by one of these commits, engage with " +
      "it explicitly (quote it, agree, or rebut with evidence) rather than re-emitting the " +
      "finding verbatim.",
    "",
  ];
  for (const c of shown) {
    lines.push(
      `- \`${c.sha.slice(0, 8)}\`: ${safeTruncate(c.message, MAX_MESSAGE_CHARS_IN_MARKDOWN, "head")}`
    );
  }
  if (omitted > 0) {
    lines.push("", `*(${omitted} older commit${omitted !== 1 ? "s" : ""} omitted)*`);
  }
  return lines.join("\n");
}

/**
 * Fetch + sanitize + render commit messages pushed since the last review.
 * Never throws — a fetch error is caught and reported as an empty ingestion
 * (with `error` set).
 */
export async function ingestCommitMessagesSinceLastReview(
  input: IngestCommitMessagesInput
): Promise<IngestCommitMessagesResult> {
  const { fetcher, octokit, owner, repo, prNumber, sinceIso, timeoutMs } = input;
  const commitFetcherFn = fetcher ?? fetchCommitMessagesSince;

  try {
    const rawCommits = await commitFetcherFn(octokit, owner, repo, prNumber, sinceIso, timeoutMs);
    // Same CoT-leakage defense as prior-review bodies (mt#1189 SC-2): a
    // commit message is author-controlled free text and, in principle,
    // could carry a leaked-scratch-shaped payload that must not contaminate
    // this iteration's prompt.
    const sanitized = rawCommits.map((c) => ({
      ...c,
      message: sanitizeReviewBody(c.message).body,
    }));
    return {
      messages: sanitized.map((c) => c.message),
      markdown: renderMarkdown(sanitized),
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(`[mt#2836] Commit-message fetch failed, continuing without context: ${errorMessage}`);
    return { messages: [], markdown: "", error: errorMessage };
  }
}
