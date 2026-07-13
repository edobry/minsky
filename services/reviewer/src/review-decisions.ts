/**
 * Pure decision helpers for the reviewer worker: post-sanitize outcome mapping,
 * tool-activation gating, and the default fork-access probe.
 *
 * Extracted from `review-worker.ts` (mt#2720) as a behavior-preserving move so
 * the worker file has headroom under the `max-lines` ceiling. `review-worker.ts`
 * re-exports every symbol here, so external consumers keep importing from
 * `./review-worker` unchanged.
 */

import type { ReviewerConfig } from "./config";
import { readFileAtRef, type PullRequestContext, type createOctokit } from "./github-client";
import type { SanitizeResult } from "./sanitize";
import type { ReviewAttemptTrace } from "./review-output-validation";
import { parseReviewEvent } from "./review-log-builders";

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
