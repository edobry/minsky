/**
 * Structured-log builders, review-event parsing, review-body annotation, and
 * submit-error serialization for the reviewer worker.
 *
 * Extracted from `review-worker.ts` (mt#2720) as a behavior-preserving move so
 * the worker file has headroom under the `max-lines` ceiling. `review-worker.ts`
 * re-exports every symbol here, so external consumers keep importing from
 * `./review-worker` unchanged.
 */

import type { AuthorshipTier } from "./tier-routing";
import type { ReviewToolCall } from "./output-tools";
import { extractProvenance, serializeProvenance } from "./review-provenance";
import { safeTruncate } from "@minsky/shared/safe-truncate";

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

export function parseReviewEvent(
  text: string,
  isSelfReview: boolean
): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (isSelfReview) return "COMMENT";

  // Look for an explicit event marker in the last 400 chars — the prompt asks
  // the model to conclude with one.
  const tail = safeTruncate(text, 400, "tail").toUpperCase();
  if (/\bREQUEST_CHANGES\b/.test(tail)) return "REQUEST_CHANGES";
  if (/\bAPPROVE\b/.test(tail)) return "APPROVE";
  return "COMMENT";
}

export function annotateReviewBody(
  text: string,
  output: { provider: string; model: string },
  tier: AuthorshipTier,
  isSelfReview: boolean,
  toolCalls?: ReadonlyArray<ReviewToolCall>
): string {
  const header =
    `**Independent adversarial review (Chinese-wall)**\n` +
    `Reviewer: \`minsky-reviewer[bot]\` via \`${output.provider}:${output.model}\`\n` +
    `Tier: ${tier ?? "unknown"}${
      isSelfReview
        ? `\n\n⚠️ Reviewer identity matches PR author (same App). Event forced to COMMENT per GitHub self-approval restriction. This is a misconfiguration — Sprint A's architecture requires distinct implementer and reviewer Apps.`
        : ""
    }\n\n---\n\n`;

  const body = header + text;

  if (toolCalls && toolCalls.length > 0) {
    const provenance = extractProvenance(toolCalls);
    return `${body}\n${serializeProvenance(provenance)}`;
  }

  return body;
}

/**
 * Build the structured-log payload for a defensive submitReview failure
 * (mt#1370). One builder serves both event variants:
 *
 *   - `reviewer.submit_skip_notice_failed` (empty-output guard catch)
 *   - `reviewer.submit_error_notice_failed` (CoT-leakage error guard catch)
 *
 * The two events share the same field set except for `sanitizeReason`, which
 * is only meaningful in the CoT-error path (the empty-output path doesn't run
 * the sanitizer). Pass `sanitizeReason` only in that case.
 *
 * Both catch blocks call this builder and pass the returned payload to
 * `log.info` (matching reviewer.cot_leak_detected and reviewer.convergence_metric
 * in the same file).
 *
 * Exported so the payload shape is unit-testable independent of the catch
 * blocks themselves (round-4 review BLOCKING).
 */
export function buildSubmitFailureLog(
  eventName: "reviewer.submit_skip_notice_failed" | "reviewer.submit_error_notice_failed",
  args: {
    prCoords: { owner: string; repo: string; prNumber: number; sha: string };
    primaryReason: string;
    sanitizeReason?: string;
    submitErr: unknown;
    provider: string;
    model: string;
  }
): Record<string, unknown> {
  const { prCoords, primaryReason, sanitizeReason, submitErr, provider, model } = args;
  const payload: Record<string, unknown> = {
    event: eventName,
    prUrl: `https://github.com/${prCoords.owner}/${prCoords.repo}/pull/${prCoords.prNumber}`,
    sha: prCoords.sha, // canonical field name (aligned with reviewer.cot_leak_detected)
    commitSha: prCoords.sha, // deprecated: kept for Railway log-filter backward compatibility; remove after consumers migrate to `sha`
    primaryReason,
    submitError: serializeSubmitError(submitErr),
    provider,
    model,
  };
  if (sanitizeReason !== undefined) {
    payload.sanitizeReason = sanitizeReason;
  }
  return payload;
}

/**
 * Serialize a submitReview error into a structured-log-safe payload.
 *
 * Octokit errors carry diagnostically valuable fields beyond `.message`:
 *   - `status` — HTTP status (rate limit signals as 403 + specific body, 5xx
 *     transient, 401/403 auth scope, etc.)
 *   - `name` — usually "HttpError" or similar; helps distinguish thrown class
 *   - `code` — node error code if the throw originated below octokit
 *   - `stack` — truncated to STACK_MAX_LEN to bound log line size
 *
 * Reducing every catch to `.message` loses these. This helper picks them out
 * when present and falls back to `String(err)` otherwise. Output is bounded by
 * letting the caller's `JSON.stringify` cap natural object size; the fields
 * we extract are all small primitives + a truncated stack.
 *
 * Exported for unit testing (mt#1370 R3 BLOCKING).
 */
const STACK_MAX_LEN = 1024;

export function serializeSubmitError(err: unknown): {
  name?: string;
  message: string;
  status?: number | string;
  code?: string;
  stack?: string;
} {
  if (err instanceof Error) {
    const out: {
      name?: string;
      message: string;
      status?: number | string;
      code?: string;
      stack?: string;
    } = {
      name: err.name,
      message: err.message,
    };
    // Octokit attaches `status` (number) and sometimes `code` to the error
    // object; check via narrow object access without changing the static type.
    const errObj = err as Error & { status?: unknown; code?: unknown };
    if (typeof errObj.status === "number" || typeof errObj.status === "string") {
      out.status = errObj.status;
    }
    if (typeof errObj.code === "string") {
      out.code = errObj.code;
    }
    if (typeof err.stack === "string" && err.stack.length > 0) {
      out.stack =
        err.stack.length > STACK_MAX_LEN
          ? `${err.stack.slice(0, STACK_MAX_LEN)}...[truncated]`
          : err.stack;
    }
    return out;
  }
  return { message: String(err) };
}
