/**
 * Review worker: fetches PR context, runs the adversarial review, posts result.
 *
 * Called by the webhook handler when a relevant PR event fires. Produces one
 * review per invocation. Stateless beyond the config injected at boot.
 */

import type { ReviewerConfig } from "./config";
import {
  createOctokit,
  fetchPriorReviews,
  fetchPullRequestContext,
  getAppIdentity,
  listDirectoryAtRef,
  readFileAtRef,
  submitReview,
  type PullRequestContext,
  type SubmittedReview,
} from "./github-client";
import type { ReviewerDb } from "./db/client";
import { type ConvergenceMetricInput, recordConvergenceMetric } from "./metrics";
import { classifyPRScope, scopeBucketFor, type PRScope } from "./pr-scope";
import { buildCriticConstitution, buildReviewPrompt } from "./prompt";
import { callReviewer, type ReviewOutput, type ReviewUsage } from "./providers";
import type { PriorReview } from "./prior-review-summary";
import {
  countAcknowledgedFindings,
  countBlockingFindings,
  summarizePriorReviews,
} from "./prior-review-summary";
import { resolveTaskSpec, type TaskSpecFetchResult } from "./task-spec-fetch";
import { decideRouting, resolveTier, type AuthorshipTier } from "./tier-routing";
import type { ReviewerToolContext } from "./tools";
import { sanitizeReviewBody, type SanitizeResult } from "./sanitize";

/**
 * Which attempt produced the final (or failing) output. Used for observability
 * — tells the caller whether the result came from the first model call, a
 * successful retry with reduced reasoning effort, or a failed retry.
 */
export type ReviewAttemptTrace = "first-attempt-success" | "retry-success" | "retry-failed";

/** Result of prior-review ingestion. Logged per review for convergence observability. */
export interface PriorReviewIngestionResult {
  /** Number of prior review iterations fetched (after filtering). */
  iterationCount: number;
  /** Number of those iterations that are stale (posted against an older commit). */
  staleCount: number;
  /**
   * Per-iteration [BLOCKING] count extracted from each prior review body.
   * Oldest-first ordering, matches summarizePriorReviews' iteration order.
   * Empty array when iterationCount is 0 or when the fetch errored — never
   * undefined, so downstream log consumers can always index it.
   *
   * Enables the SC-3 convergence metric: comparing Iter-1 blockers vs.
   * Iter-N blockers across rounds to detect severity inflation or drift.
   */
  priorBlockingCounts: number[];
  /** Set when the fetch threw an error; review still proceeds without prior context. */
  error?: string;
}

/**
 * Injectable prior-review fetcher type, for test seams.
 * Defaults to `fetchPriorReviews` from github-client.
 */
export type PriorReviewFetcherFn = (
  octokit: InstanceType<typeof import("@octokit/rest").Octokit>,
  owner: string,
  repo: string,
  prNumber: number
) => Promise<PriorReview[]>;

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
  /** Outcome of the task-spec fetch from the hosted Minsky MCP (absent on skipped reviews). */
  taskSpecFetch?: TaskSpecFetchResult;
  /** PR scope classification used to select the prompt variant (mt#1188). Absent on skipped reviews. */
  scope?: PRScope;
  /** Outcome of the prior-review ingestion (absent on skipped reviews). */
  priorReviewIngestion?: PriorReviewIngestionResult;
  /**
   * Best-effort count of [BLOCKING] findings in the submitted review body.
   * null when extraction failed or review was not posted (error/skipped paths).
   */
  blockingCount?: number | null;
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

/**
 * Map a SanitizeResult to the (event, status, reason) tuple the worker posts
 * and returns. Pure function — extracted from runReview (mt#1212) so the
 * stripped / errored / passthrough branches can be tested without mocking
 * octokit and the App-auth flow.
 *
 * Exported for tests.
 */
export function decidePostSanitizeOutcome(
  sanitized: SanitizeResult,
  isSelfReview: boolean,
  ctx: {
    reviewerLogin: string;
    provider: string;
    model: string;
    attempt: ReviewAttemptTrace;
  }
): {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  status: "reviewed" | "error";
  reason: string;
} {
  if (sanitized.action === "errored") {
    return {
      event: "COMMENT",
      status: "error",
      reason:
        `Posted service-error notice as ${ctx.reviewerLogin} ` +
        `(provider=${ctx.provider}, model=${ctx.model}, attempt=${ctx.attempt}): ` +
        `CoT leakage with no recoverable review body (${sanitized.meta.reason})`,
    };
  }

  const event = parseReviewEvent(sanitized.body, isSelfReview);
  const leakSuffix = sanitized.action === "stripped" ? " [cot-leakage: stripped]" : "";
  return {
    event,
    status: "reviewed",
    reason: `Posted ${event} review as ${ctx.reviewerLogin} (provider=${ctx.provider}, model=${ctx.model}, attempt=${ctx.attempt})${leakSuffix}`,
  };
}

/**
 * Decide whether tool-use is active for a given PR + provider combination.
 *
 * Gates on two axes (mt#1126 MVP + mt#1216 fork-access probe):
 *
 *   1) Provider capability — only OpenAI has a tool-use loop wired up.
 *      Gemini and Anthropic fall back to the no-tools path with a warning
 *      log at the caller site.
 *
 *   2) Fork accessibility — the reviewer App is installed on the base repo;
 *      it may not have read access to forks. Public forks are typically
 *      readable via `contents: read` on the head repo, so we probe at
 *      review start (one `readFile` for a known file like README.md or
 *      package.json). If the probe succeeds, enable tools on the fork; if
 *      it 403s or 404s, disable and fall back to the no-tools prompt.
 *
 * The probe callback is injected for testability — callers wire it up
 * against the octokit + head coords; tests pass a fake.
 *
 * Exported for tests.
 */
export async function decideToolsActive(
  config: ReviewerConfig,
  pr: Pick<PullRequestContext, "number" | "isForkedPR">,
  probeForkAccess: () => Promise<boolean>
): Promise<{ toolsActive: boolean; reason?: string }> {
  if (config.provider !== "openai") {
    return {
      toolsActive: false,
      reason: `provider ${config.provider} does not yet support reviewer tools (mt#1126 MVP is OpenAI-only)`,
    };
  }
  if (!pr.isForkedPR) {
    return { toolsActive: true };
  }
  const accessible = await probeForkAccess();
  if (!accessible) {
    return {
      toolsActive: false,
      reason: `fork-access probe failed for PR ${pr.number} (App lacks read access to fork, OR both README.md and package.json are absent at HEAD)`,
    };
  }
  return { toolsActive: true };
}

/**
 * Default fork-access probe used by `runReview`: attempt to read a known
 * file (README.md, then package.json as fallback) from the PR head repo at
 * HEAD. Returns true iff at least one probe succeeds.
 *
 * Exported for tests so integration tests can verify probe fall-through
 * behavior without having to mock octokit at the usage site.
 */
export async function defaultForkAccessProbe(
  octokit: Awaited<ReturnType<typeof createOctokit>>,
  pr: Pick<PullRequestContext, "headOwner" | "headRepo" | "headSha">
): Promise<boolean> {
  for (const path of ["README.md", "package.json"]) {
    try {
      const result = await readFileAtRef(octokit, pr.headOwner, pr.headRepo, path, pr.headSha);
      if (result !== null) return true;
    } catch {
      // 403/permission or other error — continue to the next probe file.
    }
  }
  return false;
}

/**
 * Build the structured log object emitted at the start of each review.
 * Extracted as a pure function so tests can assert the log shape without
 * module-level mocking (mt#1256).
 *
 * Exported for tests.
 */
export function buildRunReviewStartLog(
  deliveryId: string,
  owner: string,
  repo: string,
  prNumber: number,
  sha: string
): Record<string, unknown> {
  return {
    event: "runReview_start",
    delivery_id: deliveryId,
    owner,
    repo,
    pr: prNumber,
    sha,
  };
}

/**
 * Build the structured convergence-metric log object emitted after each
 * successful review (SC-5, mt#1189).
 *
 * Extracted as a pure function so tests can assert the 6-field shape without
 * mocking the full runReview stack.
 *
 * Fields per spec:
 *   - pr: PR number
 *   - sha: HEAD commit SHA
 *   - iterationIndex: current iteration number (priorCount + 1)
 *   - priorBlockerCount: sum of BLOCKING findings across all prior reviews
 *   - newBlockerCount: BLOCKING findings in the current review body
 *   - acknowledgedAsAddressedCount: best-effort count from review body text
 *
 * Exported for tests.
 */
export function buildConvergenceMetricLog(
  prNumber: number,
  headSha: string,
  iterationIndex: number,
  priorBlockerCount: number,
  newBlockerCount: number,
  acknowledgedAsAddressedCount: number
): Record<string, unknown> {
  return {
    event: "reviewer.convergence_metric",
    pr: prNumber,
    sha: headSha,
    iterationIndex,
    priorBlockerCount,
    newBlockerCount,
    acknowledgedAsAddressedCount,
  };
}

/**
 * Optional injectable dependencies for runReview. All fields are optional;
 * defaults to real production implementations when absent.
 */
export interface RunReviewDeps {
  /**
   * Test seam for prior-review fetch. When provided, replaces the real
   * fetchPriorReviews call. Receives the same (octokit, owner, repo, prNumber)
   * arguments. Throw to simulate a fetch error.
   */
  priorReviewFetcher?: PriorReviewFetcherFn;

  /**
   * Drizzle DB instance for writing convergence metrics.
   * When absent, metric persistence is skipped (stdout log still emits).
   * Accepts a db directly for production; for tests inject a mock or undefined.
   */
  db?: ReviewerDb;

  /**
   * Test seam for convergence metric recording.
   * When provided, replaces the real recordConvergenceMetric call.
   * Injected in tests to assert the recorder is called with the right payload
   * and to verify recorder errors do not propagate.
   */
  metricsRecorder?: (db: ReviewerDb, input: ConvergenceMetricInput) => Promise<void>;
}

export async function runReview(
  config: ReviewerConfig,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthorLogin: string,
  deliveryId: string = "unknown",
  headSha?: string,
  deps: RunReviewDeps = {}
): Promise<ReviewResult> {
  console.log(
    JSON.stringify(buildRunReviewStartLog(deliveryId, owner, repo, prNumber, headSha ?? "unknown"))
  );

  const octokit = await createOctokit(config);

  const pr = await fetchPullRequestContext(octokit, owner, repo, prNumber);
  const tier = await resolveTier(prNumber, pr.body, config);

  // Classify the PR scope (mt#1188): drives prompt-variant selection to
  // reduce false REQUEST_CHANGES on trivial / docs-only PRs (PR #703 trigger).
  const prScope = classifyPRScope({
    diff: pr.diff,
    filesChanged: pr.filesChanged,
    prBody: pr.body,
    changedFilesCount: pr.changedFilesCount,
  });

  // Emit a structured log when the minsky:trivial marker overrides the scope.
  // Makes marker usage visible in metrics so we can track opt-out frequency.
  if (prScope === "trivial" && pr.body.includes("<!-- minsky:trivial -->")) {
    console.log(
      JSON.stringify({
        event: "pr_scope_marker_override",
        owner,
        repo,
        pr: prNumber,
        sha: pr.headSha,
      })
    );
  }

  const scopeBucket = scopeBucketFor(prScope);

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

  // Fetch the task spec via the hosted Minsky MCP if configured. Never blocks —
  // unreachable MCP, missing task, or PR with no mt# reference all produce
  // taskSpec: null with a structured fetchResult the server logs.
  const { taskSpec, fetchResult: taskSpecFetch } = await resolveTaskSpec({
    branchName: pr.branchName,
    prTitle: pr.title,
    config,
  });

  // Fetch prior bot reviews on this PR. Non-blocking — errors produce an empty
  // summary with error logged, review continues without prior context.
  const priorReviewFetcherFn = deps.priorReviewFetcher ?? fetchPriorReviews;
  let priorReviewIngestion: PriorReviewIngestionResult;
  let priorReviewsMarkdown = "";
  try {
    const rawPriorReviews = await priorReviewFetcherFn(octokit, owner, repo, prNumber);
    // SC-2 (mt#1189): sanitize each prior review body before ingestion so that
    // CoT scratch leaked into a prior review cannot contaminate this iteration's
    // prompt. sanitizeReviewBody is non-throwing — it always returns a result.
    const priorReviews = rawPriorReviews.map((r) => ({
      ...r,
      body: sanitizeReviewBody(r.body).body,
    }));
    const summary = summarizePriorReviews(priorReviews, pr.headSha);
    priorReviewIngestion = {
      iterationCount: summary.iterationCount,
      staleCount: summary.reviews.filter((r) => r.isStale).length,
      priorBlockingCounts: priorReviews.map((r) => countBlockingFindings(r.body)),
    };
    priorReviewsMarkdown = summary.markdown;
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn(
      `[mt#1189] Prior-review fetch failed, continuing without context: ${errorMessage}`
    );
    priorReviewIngestion = {
      iterationCount: 0,
      staleCount: 0,
      priorBlockingCounts: [],
      error: errorMessage,
    };
  }

  const userPrompt = buildReviewPrompt({
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body,
    taskSpec,
    diff: pr.diff,
    authorshipTier: tier,
    branchName: pr.branchName,
    baseBranch: pr.baseBranch,
    priorReviews: priorReviewsMarkdown || undefined,
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

  // Gate tool wiring via the pure helper. For forked PRs on OpenAI the probe
  // runs a lightweight readFileAtRef for README.md (with package.json as
  // fallback); if it succeeds, tools are enabled on the fork. Otherwise we
  // switch to the NO_TOOLS_SECTION prompt so the model marks cross-file
  // claims as NEEDS VERIFICATION.
  const { toolsActive, reason } = await decideToolsActive(config, pr, () =>
    defaultForkAccessProbe(octokit, pr)
  );
  const systemPrompt = buildCriticConstitution(toolsActive, scopeBucket);

  // Log why tools are off when they're off, so operators can see it in the
  // service logs rather than silently losing tool support.
  if (!toolsActive && reason) {
    console.warn(`[mt#1126/mt#1216] Running review without tools: ${reason}`);
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
      taskSpecFetch,
      scope: prScope,
      priorReviewIngestion,
    };
  }

  // CoT-leakage guard (mt#1212): detect model scratch leaking into the visible
  // review body. Distinct from the empty-output guard above — here the model
  // produced content, but part of it is internal reasoning that should not
  // ship. Observed on PR #743 (2026-04-24). Either strip the leaked prefix
  // (when a structural Findings section follows) or replace the body with a
  // structured service-error notice (when the leak is the entire body).
  const sanitized = sanitizeReviewBody(output.text);
  if (sanitized.action !== "passthrough") {
    console.log(
      JSON.stringify({
        event: "reviewer.cot_leak_detected",
        prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        sha: pr.headSha, // canonical field name (aligned with review_result log)
        commitSha: pr.headSha, // deprecated: kept for Railway log-filter backward compatibility; remove after consumers migrate to `sha`
        originalLength: sanitized.meta.originalLength,
        cleanedLength: sanitized.meta.cleanedLength,
        action: sanitized.action,
        reason: sanitized.meta.reason,
        provider: output.provider,
        model: output.model,
      })
    );
  }

  const outcome = decidePostSanitizeOutcome(sanitized, isSelfReview, {
    reviewerLogin: reviewerIdentity.login,
    provider: output.provider,
    model: output.model,
    attempt,
  });

  // On the sanitize=errored path, mirror the mt#1125 empty-output pattern:
  // defensively post the service-error notice in try/catch so a secondary
  // posting failure doesn't mask the primary error, and do NOT populate the
  // `review` field — downstream consumers treat status="error" as "no review
  // confirmed posted" per the empty-output precedent.
  //
  // On the reviewed path, let submitReview failures bubble up so the webhook
  // retries the delivery (same behavior as the pre-mt#1212 normal path).
  if (outcome.status === "error") {
    try {
      await submitReview(
        octokit,
        owner,
        repo,
        prNumber,
        outcome.event,
        annotateReviewBody(sanitized.body, output, tier, isSelfReview)
      );
    } catch {
      // Primary error is still captured in outcome.reason + status below.
    }
    return {
      status: "error",
      reason: outcome.reason,
      tier,
      providerUsed: output.provider,
      providerModel: output.model,
      usage: output.usage,
      attempt,
      retryAttempted,
      taskSpecFetch,
      scope: prScope,
      priorReviewIngestion,
    };
  }

  const review = await submitReview(
    octokit,
    owner,
    repo,
    prNumber,
    outcome.event,
    annotateReviewBody(sanitized.body, output, tier, isSelfReview)
  );

  // Best-effort count of BLOCKING findings in the submitted review body.
  // Enables "prior-blocker count / new-blocker count" convergence metric in logs.
  // Shares countBlockingFindings with the prior-review counts above.
  const blockingCount: number = countBlockingFindings(sanitized.body);

  // SC-5 (mt#1189): emit structured convergence metric per review.
  // Fields: PR number, head SHA, iteration index (this is iteration N+1 where N
  // is the count of prior reviews), prior-blocker count (sum of all prior BLOCKING
  // counts), new-blocker count (BLOCKING count in current review body),
  // acknowledged-as-addressed count (best-effort from review body text).
  const priorBlockerTotal = priorReviewIngestion.priorBlockingCounts.reduce((acc, n) => acc + n, 0);
  const acknowledgedCount = countAcknowledgedFindings(sanitized.body);
  const iterationIndex = priorReviewIngestion.iterationCount + 1;
  console.log(
    JSON.stringify(
      buildConvergenceMetricLog(
        pr.number,
        pr.headSha,
        iterationIndex,
        priorBlockerTotal,
        blockingCount,
        acknowledgedCount
      )
    )
  );

  // mt#1306: persist convergence metric to Postgres alongside stdout log.
  // Uses injected metricsRecorder if provided (test seam), falls back to
  // real recordConvergenceMetric. Skipped entirely when no db is injected
  // in production the db handle is passed from server.ts via RunReviewDeps.
  const recorder = deps.metricsRecorder ?? recordConvergenceMetric;
  if (deps.db !== undefined) {
    const metricInput: ConvergenceMetricInput = {
      prOwner: owner,
      prRepo: repo,
      prNumber: pr.number,
      headSha: pr.headSha,
      iterationIndex,
      priorBlockerCount: priorBlockerTotal,
      newBlockerCount: blockingCount,
      acknowledgedAddressedCount: acknowledgedCount,
    };
    // Fire-and-forget: await but errors are swallowed inside recordConvergenceMetric.
    await recorder(deps.db, metricInput);
  }

  return {
    status: outcome.status,
    review,
    reason: outcome.reason,
    tier,
    providerUsed: output.provider,
    providerModel: output.model,
    usage: output.usage,
    attempt,
    retryAttempted,
    taskSpecFetch,
    scope: prScope,
    priorReviewIngestion,
    blockingCount,
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
