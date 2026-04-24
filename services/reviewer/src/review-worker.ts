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
  listDirectoryAtRef,
  readFileAtRef,
  submitReview,
  type SubmittedReview,
} from "./github-client";
import { buildCriticConstitution, buildReviewPrompt } from "./prompt";
import { callReviewer, type ReviewOutput, type ReviewUsage } from "./providers";
import { decideRouting, resolveTier, type AuthorshipTier } from "./tier-routing";
import type { ReviewerToolContext } from "./tools";

/**
 * Which attempt produced the final (or failing) output. Used for observability
 * — tells the caller whether the result came from the first model call, a
 * successful retry with reduced reasoning effort, or a failed retry.
 */
export type ReviewAttemptTrace = "first-attempt-success" | "retry-success" | "retry-failed";

export interface ReviewResult {
  status: "reviewed" | "skipped" | "error";
  review?: SubmittedReview;
  reason: string;
  tier: AuthorshipTier;
  providerUsed?: string;
  providerModel?: string;
  usage?: ReviewUsage;
  /** Which attempt produced the result (absent on skipped reviews). */
  attempt?: ReviewAttemptTrace;
  /** Whether a retry was actually attempted (false for non-OpenAI empty outputs). */
  retryAttempted?: boolean;
}

/**
 * Check whether a model output is suitable for posting. Reviewer-posted reviews
 * must have non-empty content — otherwise GitHub shows what looks like an
 * "approved with no issues" review that is actually "model produced no content".
 *
 * Exported for tests; runReview calls this right after the model response.
 */
export function validateReviewOutput(
  output: ReviewOutput
): { ok: true } | { ok: false; reason: string } {
  if (output.text.trim().length > 0) return { ok: true };
  const u = output.usage;
  const tokenBreakdown = u
    ? `prompt=${u.promptTokens ?? "?"} completion=${u.completionTokens ?? "?"} reasoning=${u.reasoningTokens ?? "?"} total=${u.totalTokens ?? "?"}`
    : `tokensUsed=${output.tokensUsed ?? "?"}`;
  return {
    ok: false,
    reason:
      `Model ${output.provider}:${output.model} returned empty content (${tokenBreakdown}). ` +
      `Not posting. Likely cause: reasoning tokens consumed the output budget.`,
  };
}

/**
 * Build the user-facing skip-notice that the reviewer posts as a COMMENT when
 * the model returns empty content. Separate from `validateReviewOutput.reason`
 * so the log-facing and user-facing strings can drift independently.
 *
 * Exported for tests.
 */
export function buildEmptyOutputSkipNotice(output: ReviewOutput): string {
  const u = output.usage;
  const reasoningHint =
    u && u.reasoningTokens !== undefined && u.completionTokens === 0
      ? ` Likely cause: the model's reasoning phase exhausted the output budget (${u.reasoningTokens} reasoning tokens, 0 completion tokens).`
      : "";
  return (
    `⚠️ **Automated review skipped** — the reviewer (${output.provider}:${output.model}) ` +
    `returned no content for this PR.${reasoningHint}\n\n` +
    `This is **not** an approval or a rejection. Manual review is recommended. ` +
    `Diagnostic details are available in the reviewer service logs.`
  );
}

/**
 * Injectable callReviewer function signature, for test seams.
 */
export type CallReviewerFn = typeof callReviewer;

/**
 * Result of a single-retry review call.
 */
export interface CallWithRetryResult {
  output: ReviewOutput;
  validation: { ok: true } | { ok: false; reason: string };
  attempt: ReviewAttemptTrace;
  /** False when the first call was non-empty OR when provider has no retry knob. */
  retryAttempted: boolean;
}

/**
 * Call the reviewer with single-retry-on-empty semantics (mt#1131).
 *
 * When a reasoning model exhausts its output budget on hidden reasoning
 * tokens the first call returns empty content. A second attempt with
 * `reasoningEffort: "low"` shifts the budget toward visible output and
 * usually succeeds. Only applied to OpenAI — Google and Anthropic have no
 * equivalent knob, so no retry is attempted for those providers.
 *
 * Exactly one retry. No backoff, no provider-fallback, no cascading retries.
 *
 * Tool context (mt#1126) passes through to both attempts when provided, so
 * the retry gets the same file-access capabilities as the first call.
 *
 * @param callReviewerFn test seam; defaults to the real `callReviewer` from `./providers`
 */
export async function callReviewerWithRetry(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext,
  callReviewerFn: CallReviewerFn = callReviewer
): Promise<CallWithRetryResult> {
  const first = await callReviewerFn(config, systemPrompt, userPrompt, tools);
  const firstValidation = validateReviewOutput(first);
  if (firstValidation.ok) {
    return {
      output: first,
      validation: firstValidation,
      attempt: "first-attempt-success",
      retryAttempted: false,
    };
  }

  // Only OpenAI supports the reasoning_effort override. For other providers
  // the first empty output is the final answer.
  if (first.provider !== "openai") {
    return {
      output: first,
      validation: firstValidation,
      attempt: "retry-failed",
      retryAttempted: false,
    };
  }

  const retry = await callReviewerFn(config, systemPrompt, userPrompt, tools, {
    reasoningEffort: "low",
  });
  const retryValidation = validateReviewOutput(retry);
  return {
    output: retry,
    validation: retryValidation,
    attempt: retryValidation.ok ? "retry-success" : "retry-failed",
    retryAttempted: true,
  };
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
  const tier = await resolveTier(prNumber, pr.body, config);

  const routing = decideRouting(tier, config);
  if (!routing.shouldReview) {
    return { status: "skipped", reason: routing.reason, tier };
  }

  // Confirm the reviewer identity is distinct from the PR author. If they
  // happen to match (misconfiguration, same App used for both roles), we
  // cannot APPROVE and must fall back to COMMENT — GitHub blocks
  // self-approval at the platform level. Comparison is case-insensitive
  // because GitHub usernames are case-insensitive at the platform level and
  // API responses can return inconsistent casing.
  const reviewerIdentity = await getAppIdentity(config);
  const isSelfReview = reviewerIdentity.login.toLowerCase() === prAuthorLogin.toLowerCase();

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

  // Construct the tool context for this PR's HEAD ref. The model can use these
  // to verify cross-file claims before reporting them as findings.
  //
  // For forked PRs, `headSha` only exists in the head repository (fork), not
  // the base repo. Passing (owner=base, repo=base, ref=headSha) to getContent
  // 404s. Use the head coords so tool calls resolve correctly on forks too.
  const toolContext: ReviewerToolContext = {
    readFile: (path: string) => readFileAtRef(octokit, pr.headOwner, pr.headRepo, path, pr.headSha),
    listDirectory: (path: string) =>
      listDirectoryAtRef(octokit, pr.headOwner, pr.headRepo, path, pr.headSha),
  };

  // Gate tool wiring on TWO axes:
  //   1) Provider capability — mt#1126 MVP only supports OpenAI; Gemini and
  //      Anthropic fall back to the no-tools path.
  //   2) Fork accessibility — the reviewer App is installed on the base repo;
  //      it may not have read access to forks. Rather than promise tools that
  //      silently 404, disable tools for forked PRs and switch to the
  //      NO_TOOLS_SECTION prompt so the model knows to mark cross-file
  //      claims as NEEDS VERIFICATION.
  //
  // Both failure modes were surfaced by minsky-reviewer findings on mt#1126.
  const providerSupportsTools = config.provider === "openai";
  const toolsActive = providerSupportsTools && !pr.isForkedPR;
  const systemPrompt = buildCriticConstitution(toolsActive);

  // Log why tools are off when they're off, so operators can see it in the
  // service logs rather than silently losing tool support. Previously, the
  // warning lived inside callGoogle/callAnthropic and only fired when tools
  // were passed — but the gating here never passes tools for those providers,
  // so the warning never triggered. Surfaced as a mt#1126 reviewer finding.
  if (!toolsActive) {
    const reason = !providerSupportsTools
      ? `provider ${config.provider} does not yet support reviewer tools (mt#1126 MVP is OpenAI-only)`
      : `tools disabled for forked PR ${pr.number} (App may lack fork access)`;
    console.warn(`[mt#1126] Running review without tools: ${reason}`);
  }

  // Only pass toolContext when tools are actually active — otherwise the
  // provider's no-tools fallback path would fire a second warning log on
  // every review.
  //
  // callReviewerWithRetry (mt#1131) wraps callReviewer with single-retry-on-
  // empty semantics: if the first call returns empty on OpenAI, it retries
  // once with reasoningEffort="low" before giving up. Tools pass through to
  // both attempts.
  const { output, validation, attempt, retryAttempted } = await callReviewerWithRetry(
    config,
    systemPrompt,
    userPrompt,
    toolsActive ? toolContext : undefined
  );

  // Empty-output guard: GPT-5 reasoning models can exhaust max_completion_tokens
  // on reasoning before producing visible output, yielding empty content.
  // Posting that empty content as an adversarial review would look like
  // "approved, no issues" when it's actually "model silently failed." Instead,
  // post a NEUTRAL COMMENT so PR authors see that the reviewer ran but produced
  // nothing, then return status=error so server logs capture the failure.
  //
  // The retry path (mt#1131) tries once with reasoningEffort="low" before
  // giving up; if that also fails we land here with attempt="retry-failed".
  if (!validation.ok) {
    const skipNotice = buildEmptyOutputSkipNotice(output);
    // submitReview failure shouldn't mask the original empty-output error —
    // catch defensively and continue to the error return below.
    try {
      await submitReview(octokit, owner, repo, prNumber, "COMMENT", skipNotice);
    } catch {
      // Surfacing in logs is still captured via status=error + the reason below.
    }
    return {
      status: "error",
      reason: validation.reason,
      tier,
      providerUsed: output.provider,
      providerModel: output.model,
      usage: output.usage,
      attempt,
      retryAttempted,
    };
  }

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
    reason: `Posted ${event} review as ${reviewerIdentity.login} (provider=${output.provider}, model=${output.model}, attempt=${attempt})`,
    tier,
    providerUsed: output.provider,
    providerModel: output.model,
    usage: output.usage,
    attempt,
    retryAttempted,
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
