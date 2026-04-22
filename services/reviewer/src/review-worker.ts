/**
 * Review worker: fetches PR context, runs the adversarial review, posts result.
 *
 * Called by the webhook handler when a relevant PR event fires. Produces one
 * review per invocation. Stateless beyond the config injected at boot.
 */

import type { ReviewerConfig } from "./config";
import {
  createOctokit,
  fetchPullRequestContext,
  getAppIdentity,
  submitReview,
  type SubmittedReview,
} from "./github-client";
import { buildReviewPrompt, CRITIC_CONSTITUTION } from "./prompt";
import { callReviewer } from "./providers";
import { decideRouting, extractTierFromPRBody, type AuthorshipTier } from "./tier-routing";

export interface ReviewResult {
  status: "reviewed" | "skipped" | "error";
  review?: SubmittedReview;
  reason: string;
  tier: AuthorshipTier;
  providerUsed?: string;
  providerModel?: string;
}

export async function runReview(
  config: ReviewerConfig,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthorLogin: string
): Promise<ReviewResult> {
  const octokit = await createOctokit(config);

  const pr = await fetchPullRequestContext(octokit, owner, repo, prNumber);
  const tier = extractTierFromPRBody(pr.body);

  const routing = decideRouting(tier, config);
  if (!routing.shouldReview) {
    return { status: "skipped", reason: routing.reason, tier };
  }

  // Confirm the reviewer identity is distinct from the PR author. If they
  // happen to match (misconfiguration, same App used for both roles), we
  // cannot APPROVE and must fall back to COMMENT — GitHub blocks
  // self-approval at the platform level.
  const reviewerIdentity = await getAppIdentity(octokit);
  const isSelfReview = reviewerIdentity.login === prAuthorLogin;

  const userPrompt = buildReviewPrompt({
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body,
    taskSpec: null, // Sprint A: no spec fetch; Sprint B adds Minsky MCP integration.
    diff: pr.diff,
    authorshipTier: tier,
    branchName: pr.branchName,
    baseBranch: pr.baseBranch,
  });

  const output = await callReviewer(config, CRITIC_CONSTITUTION, userPrompt);

  const event = parseReviewEvent(output.text, isSelfReview);

  const review = await submitReview(
    octokit,
    owner,
    repo,
    prNumber,
    event,
    annotateReviewBody(output.text, output, tier, isSelfReview)
  );

  return {
    status: "reviewed",
    review,
    reason: `Posted ${event} review as ${reviewerIdentity.login} (provider=${output.provider}, model=${output.model})`,
    tier,
    providerUsed: output.provider,
    providerModel: output.model,
  };
}

export function parseReviewEvent(
  text: string,
  isSelfReview: boolean
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (isSelfReview) return "COMMENT";

  // Look for an explicit event marker in the last 400 chars — the prompt asks
  // the model to conclude with one.
  const tail = text.slice(-400).toUpperCase();
  if (/\bREQUEST_CHANGES\b/.test(tail)) return "REQUEST_CHANGES";
  if (/\bAPPROVE\b/.test(tail)) return "APPROVE";
  return "COMMENT";
}

function annotateReviewBody(
  text: string,
  output: { provider: string; model: string },
  tier: AuthorshipTier,
  isSelfReview: boolean
): string {
  const header =
    `**Independent adversarial review (Chinese-wall)**\n` +
    `Reviewer: \`minsky-reviewer[bot]\` via \`${output.provider}:${output.model}\`\n` +
    `Tier: ${tier ?? "unknown"}${
      isSelfReview
        ? `\n\n⚠️ Reviewer identity matches PR author (same App). Event forced to COMMENT per GitHub self-approval restriction. This is a misconfiguration — Sprint A's architecture requires distinct implementer and reviewer Apps.`
        : ""
    }\n\n---\n\n`;

  return header + text;
}
