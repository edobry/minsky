/**
 * Model-output validation + single-retry call semantics for the reviewer.
 *
 * Extracted from `review-worker.ts` (mt#2720) as a behavior-preserving move so
 * the worker file has headroom under the `max-lines` ceiling. `review-worker.ts`
 * re-exports every symbol here, so external consumers keep importing from
 * `./review-worker` unchanged.
 */

import type { ReviewerConfig } from "./config";
import { callReviewer, type ReviewOutput } from "./providers";
import type { ReviewerToolContext } from "./tools";
import { log } from "./logger";
import { TimeoutError } from "./with-timeout";

/**
 * Which attempt produced the final (or failing) output. Used for observability
 * — tells the caller whether the result came from the first model call, a
 * successful retry with reduced reasoning effort, or a failed retry.
 */
export type ReviewAttemptTrace = "first-attempt-success" | "retry-success" | "retry-failed";

/**
 * Check whether a model output is suitable for posting. Reviewer-posted reviews
 * must have non-empty content — otherwise GitHub shows what looks like an
 * "approved with no issues" review that is actually "model produced no content".
 *
 * When `outputToolsActive` is true (OpenAI + output-tools path), a review with
 * empty text but non-empty toolCalls is treated as successful — the model
 * emitted structured output via tool calls, which is the expected behavior on
 * that path (gpt-5 emits tool calls with output.text === "").
 *
 * Exported for tests; runReview calls this right after the model response.
 */
export function validateReviewOutput(
  output: ReviewOutput,
  outputToolsActive: boolean = false
): { ok: true } | { ok: false; reason: string } {
  if (output.text.trim().length > 0) return { ok: true };
  // On the output-tools-active path, non-empty toolCalls is also a success signal.
  if (outputToolsActive && output.toolCalls.length > 0) return { ok: true };
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
 * Call the reviewer with single-retry semantics for both empty output
 * (mt#1131) and timeout (mt#2083).
 *
 * Two retry triggers, same shape — exactly one retry, no backoff:
 *
 *   1) Empty output: reasoning model exhausts its output budget on hidden
 *      reasoning tokens. Retry with `reasoningEffort: "low"` to shift
 *      the budget toward visible output. OpenAI only.
 *
 *   2) TimeoutError: transient provider-side latency caused the tool-loop
 *      per-round timeout to fire. Retry with the same config — transient
 *      slowness usually clears on the second attempt. All providers.
 *      mt#2083 originating incident: PR #1252 (1-line bunfig.toml change)
 *      timed out twice on the webhook path; sweeper succeeded ~100s later.
 *
 * Tool context (mt#1126) passes through to both attempts when provided, so
 * the retry gets the same file-access capabilities as the first call.
 *
 * When `outputToolsActive` is true, passes that flag through to
 * `validateReviewOutput` so non-empty toolCalls count as a success signal.
 *
 * @param callReviewerFn test seam; defaults to the real `callReviewer` from `./providers`
 */
export async function callReviewerWithRetry(
  config: ReviewerConfig,
  systemPrompt: string,
  userPrompt: string,
  tools?: ReviewerToolContext,
  callReviewerFn: CallReviewerFn = callReviewer,
  outputToolsActive: boolean = false
): Promise<CallWithRetryResult> {
  let first: ReviewOutput;
  try {
    first = await callReviewerFn(config, systemPrompt, userPrompt, tools);
  } catch (err) {
    if (!(err instanceof TimeoutError)) throw err;
    log.warn("callReviewerWithRetry.timeout_retry", {
      event: "callReviewerWithRetry.timeout_retry",
      op: err.op,
      timeoutMs: err.timeoutMs,
      provider: config.provider,
    });
    const retryOptions =
      config.provider === "openai" ? { reasoningEffort: "low" as const } : undefined;
    const retry = await callReviewerFn(config, systemPrompt, userPrompt, tools, retryOptions);
    const retryValidation = validateReviewOutput(retry, outputToolsActive);
    return {
      output: retry,
      validation: retryValidation,
      attempt: retryValidation.ok ? "retry-success" : "retry-failed",
      retryAttempted: true,
    };
  }

  const firstValidation = validateReviewOutput(first, outputToolsActive);
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
  const retryValidation = validateReviewOutput(retry, outputToolsActive);
  return {
    output: retry,
    validation: retryValidation,
    attempt: retryValidation.ok ? "retry-success" : "retry-failed",
    retryAttempted: true,
  };
}
