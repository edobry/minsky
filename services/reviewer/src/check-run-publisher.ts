/**
 * Check-run publisher for the reviewer service.
 *
 * Wires the reviewer's per-review output (tool calls + convergence state +
 * failure/liveness) into a GitHub check run on the PR HEAD commit. The check
 * run carries BOTH:
 *
 *   (a) Convergence state in `output.summary` — "round N, K blocking remain"
 *       or a liveness-failure summary (mt#2435 payload).
 *   (b) Findings as annotations (path/start_line/end_line/annotation_level)
 *       derived from `submit_finding` tool calls (mt#1346 intended payload).
 *
 * Integration:
 *   - Reuses `submitCheckRun` from `@minsky/domain` (mt#1346 implementation).
 *   - Passes the reviewer service's own Octokit as `octokitOverride` so no
 *     `gh.getToken()` call is needed (the reviewer's octokit is already
 *     authenticated via the reviewer App's installation token).
 *   - A minimal `GitHubContext` (owner + repo) is constructed inline; the
 *     `getToken` stub is never called because `octokitOverride` is supplied.
 *   - Degrades gracefully on fork-PR check permission errors: wraps in
 *     try/catch and logs a warning rather than propagating. The review itself
 *     is never blocked by a check-run failure (SC#3).
 *
 * @see packages/domain/src/repository/github-checks-run.ts  — submitCheckRun
 * @see mt#1346 — check-run capability that shipped submitCheckRun
 * @see mt#2435 — this task (production wiring of the check run)
 */

import {
  submitCheckRun,
  mapSeverityToAnnotationLevel,
  deriveConclusion,
  type CheckRunAnnotation,
  type AnnotationLevel,
  type SubmitCheckRunResult,
} from "@minsky/domain/repository/github-checks-run";
import type { GitHubContext } from "@minsky/domain/repository/github-pr-operations";
import type { ReviewToolCall } from "./output-tools";
import { createOctokit } from "./github-client";
import { log } from "./logger";

// Use the reviewer service's own Octokit type (from ./github-client, which
// resolves through services/reviewer/node_modules/@octokit/rest). The domain's
// `submitCheckRun` octokitOverride parameter resolves through the ROOT
// node_modules/@octokit/core — two different type identities even though they
// are structurally identical at runtime. Using the reviewer's own type here
// avoids a cast at the call site in review-worker.ts.
type ReviewerOctokit = Awaited<ReturnType<typeof createOctokit>>;

// ── Constants ─────────────────────────────────────────────────────────────

/** Stable name for the reviewer findings check run (matches the domain default). */
export const CHECK_RUN_NAME = "minsky-reviewer/findings";

// ── Public types ──────────────────────────────────────────────────────────

/**
 * Convergence state for the check-run summary.
 *
 * Derived from the prior-review context already computed by the worker.
 * Passed explicitly (not re-derived) so the publisher is a pure transformer.
 */
export interface ConvergenceState {
  /**
   * 1-based current review round (iterationCount + 1), or `null` when the round
   * is genuinely unknown.
   *
   * `null` exists for mt#4881 SC7's thrown-failure path: a review that throws
   * (a provider error, the GitHub diff 406) never reaches `finalizeReviewError`,
   * so nothing has ingested the prior reviews and no round number has been
   * computed. Rendering a fabricated `round 1` in front of the operator would be
   * worse than omitting it, and paying an extra GitHub round-trip to derive one
   * on a failure path is not worth it — so the renderers below drop the round
   * parenthetical instead. Output for a numeric round is byte-identical to
   * before.
   */
  roundNumber: number | null;
  /** Number of BLOCKING findings in the current review. 0 when none. */
  blockingCount: number;
}

/**
 * Parameters for `buildCheckRunPayload` (pure function, exported for tests).
 */
export interface BuildCheckRunPayloadParams {
  /** Tool calls from the reviewer model output (may be empty for prose path). */
  toolCalls: ReadonlyArray<ReviewToolCall>;
  /** Convergence state: round number and current blocking count. */
  convergenceState: ConvergenceState;
  /**
   * When provided, this is a failure/liveness summary rather than a normal
   * review result. The check-run conclusion is forced to "failure" and the
   * summary shows this error message.
   */
  failureSummary?: string;
  /**
   * When provided, the reviewer DECLINED to run — it did not fail (mt#4271).
   * Today the only reason is `concurrent_inflight`: another caller held the
   * in-flight marker. The conclusion becomes `"skipped"`, which GitHub's
   * protected-branches documentation lists alongside `successful` and `neutral`
   * as satisfying a required status check, so the PR is not blocked:
   *
   * > Required status checks must have a `successful`, `skipped`, or `neutral`
   * > status before collaborators can make changes to a protected branch.
   *
   * `minsky-reviewer/findings` IS a required check, so publishing `failure`
   * here would turn a transient refusal into a merge blocker — worse than the
   * silence this exists to end.
   *
   * Mutually exclusive with `failureSummary` in practice: a skip returns from
   * `runReview` before any failure path. `failureSummary` wins if both are set,
   * because a real failure is the more serious signal to surface.
   */
  skipReason?: string;
}

/**
 * Structured payload passed to `submitCheckRun`.
 * Exported for tests so the payload shape can be asserted without I/O.
 */
export interface CheckRunPayload {
  name: string;
  status: "completed";
  conclusion: "success" | "failure" | "neutral" | "skipped";
  output: {
    title: string;
    summary: string;
    annotations: CheckRunAnnotation[];
  };
}

// ── Pure payload builder ──────────────────────────────────────────────────

/**
 * Build the check-run payload from reviewer output.
 *
 * Pure function — no I/O, no async. Exported for unit testing.
 *
 * Annotation mapping:
 *   `submit_finding` with severity BLOCKING     → annotation_level "failure"
 *   `submit_finding` with severity NON-BLOCKING → annotation_level "warning"
 *   `submit_finding` with any other severity   → annotation_level "notice"
 *
 * Conclusion mapping (blockingCount is authoritative for the failure verdict —
 * NOT the annotations, because the prose review path has a blockingCount but
 * emits no `submit_finding` annotations; deriving failure from annotations alone
 * would post a green "success" check-run on a prose CHANGES_REQUESTED review):
 *   failureSummary set OR blockingCount > 0  → "failure"
 *   blockingCount == 0, any "warning"        → "neutral"
 *   blockingCount == 0, no annotations/notice → "success"
 *
 * When `failureSummary` is set, the conclusion is forced to "failure"
 * regardless of annotations or blockingCount (liveness failure path per SC#1).
 */
export function buildCheckRunPayload(params: BuildCheckRunPayloadParams): CheckRunPayload {
  const { toolCalls, convergenceState, failureSummary, skipReason } = params;
  const { roundNumber, blockingCount } = convergenceState;

  // Build annotations from submit_finding tool calls only.
  const annotations: CheckRunAnnotation[] = [];
  for (const tc of toolCalls) {
    if (tc.name !== "submit_finding") continue;
    const { file, line, lineEnd, severity, summary, details } = tc.args;
    annotations.push({
      path: file,
      startLine: line,
      endLine: lineEnd ?? line,
      annotationLevel: mapSeverityToAnnotationLevel(severity),
      title: summary,
      message: details,
    });
  }

  const levels: AnnotationLevel[] = annotations.map((a) => a.annotationLevel);

  // Conclusion: forced "failure" on liveness errors; otherwise blockingCount is
  // the authoritative failure signal (the prose path carries blockingCount but
  // no annotations, so deriving failure from annotations alone would emit a
  // green check-run on a prose CHANGES_REQUESTED review). With no blocking
  // findings, annotations distinguish neutral (NON-BLOCKING present) from
  // success (none / informational only).
  // Order matters. `failureSummary` first (a real failure outranks a refusal),
  // then `skipReason` — which must NOT fall through to the blockingCount branch,
  // because a declined review has no findings and would otherwise render as a
  // green "success" claiming the code was reviewed when nothing looked at it.
  const conclusion: "success" | "failure" | "neutral" | "skipped" = failureSummary
    ? "failure"
    : skipReason
      ? "skipped"
      : blockingCount > 0
        ? "failure"
        : deriveConclusion(levels);

  // Round rendering. Both forms below are byte-identical to the pre-mt#4881
  // output when roundNumber is a number; they only differ for the `null`
  // (round-unknown) case the thrown-failure path passes.
  const roundSuffix = roundNumber === null ? "" : ` (round ${roundNumber})`;
  const roundPrefix = roundNumber === null ? "Review" : `Round ${roundNumber}`;

  // Summary: liveness failure overrides convergence state.
  let summary: string;
  if (failureSummary) {
    summary = `Reviewer failure${roundSuffix}: ${failureSummary}`;
  } else if (skipReason) {
    // Say what did NOT happen, and what clears it. An agent reading this is
    // partway down a silence ladder whose next documented step is a bypass
    // merge, so the summary has to rule that out rather than merely describe
    // the state: no review ran, and this is not reviewer silence.
    // The remedy is reason-SPECIFIC, so it is only asserted for the reason it
    // is true of. `concurrent_inflight` clears on a new head; a future reason
    // (a permission, a rate limit) would need a different one, and stating this
    // one for it would send an operator confidently the wrong way — the same
    // shape of error as the `absent` this whole change exists to fix, one layer
    // up. Only the reason-independent half is unconditional. (PR #3563 R1.)
    const remedy =
      skipReason === "concurrent_inflight"
        ? " A concurrent_inflight refusal clears on a new head; a retrigger is refused while the marker is held."
        : "";
    summary =
      `Reviewer declined to run${roundSuffix}: ${skipReason}. ` +
      `No review was performed on this commit — this is NOT reviewer silence, ` +
      `and it is not a bypass condition.${remedy}`;
  } else if (blockingCount === 0) {
    summary = `${roundPrefix}: no blocking findings — approved.`;
  } else {
    summary = `${roundPrefix}: ${blockingCount} blocking finding${blockingCount === 1 ? "" : "s"} remain.`;
  }

  const findingCount = annotations.length;
  const title = failureSummary
    ? `minsky-reviewer: error${roundSuffix}`
    : skipReason
      ? `minsky-reviewer: skipped — ${skipReason}`
      : `minsky-reviewer: ${findingCount} finding${findingCount === 1 ? "" : "s"}`;

  return {
    name: CHECK_RUN_NAME,
    status: "completed",
    conclusion,
    output: {
      title,
      summary,
      annotations,
    },
  };
}

// ── Publisher ─────────────────────────────────────────────────────────────

/**
 * Options for `publishCheckRun`.
 */
export interface PublishCheckRunOptions {
  /** Already-authenticated Octokit for the reviewer App installation. */
  octokit: ReviewerOctokit;
  /** Base repository owner (where the PR targets). */
  owner: string;
  /** Base repository name. */
  repo: string;
  /** PR HEAD commit SHA — the check run is attached to this commit. */
  headSha: string;
  /** PR number (for log context only). */
  prNumber: number;
  /** Tool calls from the current review output. */
  toolCalls: ReadonlyArray<ReviewToolCall>;
  /** Convergence state: round number and current blocking count. */
  convergenceState: ConvergenceState;
  /**
   * When set, this represents a failure/liveness summary. The check run will
   * have conclusion "failure" and the summary will show this error message.
   */
  failureSummary?: string;
  /**
   * When set, the reviewer DECLINED to run and the check run gets conclusion
   * `"skipped"` (mt#4271). See `BuildCheckRunPayloadParams.skipReason`.
   */
  skipReason?: string;
}

/**
 * Publish a GitHub check run for the current reviewer pass.
 *
 * Wraps `submitCheckRun` from `@minsky/domain` with the reviewer's own
 * Octokit (already authenticated via the reviewer App's installation token).
 *
 * Degrades gracefully: any error (including fork-PR `checks:write` permission
 * failures) is caught, logged as a warning, and the function returns `null`
 * rather than re-throwing. The review must never be blocked by a check-run
 * publication failure.
 *
 * @returns The check-run creation result, or null on failure.
 */
export async function publishCheckRun(
  options: PublishCheckRunOptions
): Promise<SubmitCheckRunResult | null> {
  const {
    octokit,
    owner,
    repo,
    headSha,
    prNumber,
    toolCalls,
    convergenceState,
    failureSummary,
    skipReason,
  } = options;

  const payload = buildCheckRunPayload({
    toolCalls,
    convergenceState,
    failureSummary,
    skipReason,
  });

  // Construct a minimal GitHubContext. getToken is stubbed because the
  // `octokitOverride` path in `submitCheckRun` bypasses getToken entirely
  // (line 142 of github-checks-run.ts: `const octokit = octokitOverride ?? createOctokit(...)`).
  const gh: GitHubContext = {
    owner,
    repo,
    getToken: () =>
      Promise.reject(new Error("getToken should not be called when octokitOverride is provided")),
  };

  try {
    const result = await submitCheckRun(
      gh,
      headSha,
      {
        name: payload.name,
        status: payload.status,
        conclusion: payload.conclusion,
        output: payload.output,
      },
      // The reviewer's Octokit (services/reviewer/node_modules/@octokit/rest) and
      // the domain's octokitOverride type (root node_modules/@octokit/core) are
      // structurally identical at runtime but resolve to different TypeScript type
      // identities because of the monorepo's dual node_modules layout. The cast
      // through unknown is the minimal bridge for this cross-package type seam.
      // eslint-disable-next-line custom/no-excessive-as-unknown -- dual node_modules Octokit type seam; structurally identical at runtime
      octokit as unknown as Parameters<typeof submitCheckRun>[3]
    );

    log.info("reviewer.check_run_published", {
      event: "reviewer.check_run_published",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      checkRunId: result.checkRunId,
      checkRunUrl: result.htmlUrl,
      conclusion: payload.conclusion,
      annotationCount: payload.output.annotations.length,
      roundNumber: convergenceState.roundNumber,
    });

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const isPermissionError =
      err instanceof Error &&
      "status" in err &&
      (err as Error & { status?: number }).status === 403;

    log.warn("reviewer.check_run_publish_failed", {
      event: "reviewer.check_run_publish_failed",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      error: message,
      // Fork PRs may trigger a 403 because the App lacks checks:write on the fork.
      likelyForkPermissionError: isPermissionError,
      roundNumber: convergenceState.roundNumber,
    });

    return null;
  }
}
