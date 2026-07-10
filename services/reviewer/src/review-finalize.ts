/**
 * Review finalization stages (mt#2731).
 *
 * `runReviewBody` (review-worker.ts) has four terminal paths that all end in the
 * same "finalize-and-return" shape. mt#2725 + mt#2435 + mt#2287 fattened those
 * tails until they were the file's densest extraction candidate; this module
 * collapses them into two stage functions over one shared context:
 *
 *   - `finalizeReviewSuccess` — the output-tools and prose SUCCESS tails. Both
 *     end: publishCheckRun -> (thread-resolve, output-tools only) -> convergence
 *     stdout log -> persistConvergenceMetric(verdict) -> timing write -> emit
 *     `pr.review_posted` -> return the `reviewed` ReviewResult. They differ only
 *     in a handful of inputs (the posted event, the body used for the
 *     acknowledged-findings count, the check-run tool calls, the thread-resolve
 *     directives, and the final status/reason), threaded through
 *     `FinalizeReviewSuccessInput`.
 *   - `finalizeReviewError` — the empty-output and CoT-leakage ERROR tails. Both
 *     end: timing write -> publishCheckRun(failureSummary) -> return the `error`
 *     ReviewResult. They differ only in the failure reason.
 *
 * Behavior-preserving: this is a move of live control flow out of `runReviewBody`,
 * not a rewrite. The per-path submit calls (which differ — skip notice, error
 * notice, guarded submit) stay in `runReviewBody`; only the identical tails after
 * the review is submitted (or the error is decided) live here.
 */

import { createOctokit, resolveThread, type ReviewThread } from "./github-client";
import type { SubmittedReview } from "./github-client";
import { publishCheckRun } from "./check-run-publisher";
import { recordReviewTiming } from "./review-timing";
import { timingTokenFields } from "./token-cost";
import { recordConvergenceMetric, type ConvergenceMetricInput } from "./metrics";
import { countAcknowledgedFindings } from "./prior-review-summary";
import { buildConvergenceMetricLog } from "./review-log-builders";
import { log } from "./logger";
import type { ReviewPostedEvent, ReviewSubmitEvent } from "./review-events";
import type { ReviewOutput } from "./providers";
import type { AuthorshipTier } from "./tier-routing";
import type { PRScope } from "./pr-scope";
import type { TaskSpecFetchResult } from "./task-spec-fetch";
import type { ReviewAttemptTrace } from "./review-output-validation";
import type { ReviewToolCall } from "./output-tools";
// Type-only imports from review-worker: RunReviewDeps / ReviewResult /
// PriorReviewIngestionResult stay defined there (public contract). Because these
// are erased at runtime, review-worker importing this module's functions at
// runtime does NOT create a runtime import cycle.
import type { RunReviewDeps, ReviewResult, PriorReviewIngestionResult } from "./review-worker";

/**
 * Persist one convergence-metric row via the injected recorder (test seam) or
 * the real `recordConvergenceMetric`. No-op when no db is configured; errors are
 * swallowed inside the recorder (reviews never fail on a metric write).
 *
 * Extracted (mt#2725) so BOTH review success paths — output-tools (production
 * default) and prose — persist the metric. Previously only the prose path
 * called the recorder, so on the production output-tools path the convergence
 * row was a dead write path (computed for the stdout log, never persisted).
 * Moved here (mt#2731) alongside the finalize stages that call it; re-exported
 * from review-worker.ts for consumers/tests that import it from there.
 */
export async function persistConvergenceMetric(
  deps: RunReviewDeps,
  input: ConvergenceMetricInput
): Promise<void> {
  if (deps.db === undefined) return;
  const recorder = deps.metricsRecorder ?? recordConvergenceMetric;
  await recorder(deps.db, input);
}

/**
 * Invariant per-review context shared by every finalize path. Built once in
 * `runReviewBody` after the model call completes (so `output`, `attempt`,
 * `retryAttempted`, and `totalWallClockMs` are known) and passed to whichever
 * terminal path fires.
 */
export interface ReviewRunContext {
  deps: RunReviewDeps;
  octokit: Awaited<ReturnType<typeof createOctokit>>;
  owner: string;
  repo: string;
  /** Only the fields the finalize stages read from the PR context. */
  pr: { number: number; headSha: string; branchName: string };
  tier: AuthorshipTier;
  prScope: PRScope;
  output: ReviewOutput;
  attempt: ReviewAttemptTrace;
  retryAttempted: boolean;
  taskSpecFetch: TaskSpecFetchResult;
  priorReviewIngestion: PriorReviewIngestionResult;
  totalWallClockMs: number;
  outputToolsActive: boolean;
  /** `reviewerIdentity.login` — used for the human-thread guard + emit payload. */
  reviewerLogin: string;
  /** Bound `pr.review_posted` emitter (injected seam in tests, MCP-backed in prod). */
  emitReviewPosted: (ev: ReviewPostedEvent) => Promise<void>;
}

/**
 * Path-specific inputs to `finalizeReviewSuccess`. Everything else the success
 * tail needs is on `ReviewRunContext`.
 */
export interface FinalizeReviewSuccessInput {
  /** The submitted review returned by submitReviewWithGuards. */
  review: SubmittedReview;
  /**
   * The review event actually posted (e.g. "APPROVE" / "COMMENT" /
   * "REQUEST_CHANGES"). Drives the persisted verdict + the emit payload.
   * Output-tools path passes `event`; prose path passes `outcome.event`.
   */
  event: ReviewSubmitEvent;
  /** Post-recovery (output-tools) or body-parsed (prose) BLOCKING count. */
  blockingCount: number;
  /** Body used to count acknowledged findings (composed.body | sanitized.body). */
  acknowledgedBody: string;
  /** Tool calls for the check-run annotations (recoveryResult.toolCalls | []). */
  checkRunToolCalls: ReadonlyArray<ReviewToolCall>;
  /** Thread-resolve directives (output-tools only; [] on the prose path). */
  threadResolves: ReadonlyArray<{ threadId: string; reason: string }>;
  /** Fetched review threads for the human-thread guard (output-tools only; [] on prose). */
  reviewThreads: ReadonlyArray<ReviewThread>;
  /** Final ReviewResult.status ("reviewed" on output-tools; outcome.status on prose). */
  status: ReviewResult["status"];
  /** Final ReviewResult.reason. */
  reason: string;
}

/**
 * Persist per-review timing on the main (post-model-call) path. Identical shape
 * across all four terminal paths (empty-output error, CoT error, output-tools
 * success, prose success) — iterationIndex N+1 plus the full token fields. The
 * skip-path timing writes in `runReview` (iterationIndex 0, no token fields) are
 * a different shape and stay there.
 */
async function writeMainPathTiming(ctx: ReviewRunContext): Promise<void> {
  const {
    deps,
    owner,
    repo,
    pr,
    output,
    prScope,
    outputToolsActive,
    priorReviewIngestion,
    totalWallClockMs,
    retryAttempted,
  } = ctx;
  if (deps.db === undefined) return;
  await (deps.timingRecorder ?? recordReviewTiming)(deps.db, {
    prOwner: owner,
    prRepo: repo,
    prNumber: pr.number,
    headSha: pr.headSha,
    iterationIndex: priorReviewIngestion.iterationCount + 1,
    totalWallClockMs,
    perRoundLatenciesMs: output.timing?.roundLatenciesMs ?? [],
    timeoutCount: output.timing?.timeoutCount ?? 0,
    retryCount: retryAttempted ? 1 : 0,
    retryOutcomes: output.timing?.retryOutcomes ?? [],
    scopeClassification: prScope ?? null,
    toolUseActive: outputToolsActive,
    provider: output.provider,
    model: output.model,
    ...timingTokenFields(output),
  });
}

/**
 * Finalize a successful review (output-tools or prose path):
 * publishCheckRun -> thread-resolve (output-tools only) -> convergence stdout log
 * -> persistConvergenceMetric(verdict) -> timing write -> emit `pr.review_posted`
 * -> return the `reviewed` ReviewResult.
 */
export async function finalizeReviewSuccess(
  ctx: ReviewRunContext,
  input: FinalizeReviewSuccessInput
): Promise<ReviewResult> {
  const {
    deps,
    octokit,
    owner,
    repo,
    pr,
    tier,
    prScope,
    output,
    attempt,
    retryAttempted,
    taskSpecFetch,
    priorReviewIngestion,
    reviewerLogin,
    emitReviewPosted,
  } = ctx;
  const {
    review,
    event,
    blockingCount,
    acknowledgedBody,
    checkRunToolCalls,
    threadResolves,
    reviewThreads,
    status,
    reason,
  } = input;

  const iterationIndex = priorReviewIngestion.iterationCount + 1;

  // mt#2435: post a GitHub check run on the PR HEAD with convergence state +
  // findings as annotations. Wrapped in try/catch via publishCheckRun — any
  // error (including fork-PR checks:write permission failures) logs a warning
  // and falls back without blocking the review result. On the prose path there
  // are no structured tool calls, so annotations are empty ([]).
  const checkRunPublisherFn = deps.checkRunPublisher ?? publishCheckRun;
  await checkRunPublisherFn({
    octokit,
    owner,
    repo,
    headSha: pr.headSha,
    prNumber: pr.number,
    toolCalls: checkRunToolCalls,
    convergenceState: {
      roundNumber: iterationIndex,
      blockingCount,
    },
  });

  // Thread-resolve loop (mt#1345): after posting the review, resolve threads
  // that the model marked as fixed. Guard: only resolve threads whose first
  // comment was authored by the reviewer bot itself — never auto-resolve
  // threads opened by humans. The guard is applied here (not in the model
  // prompt alone) as a structural safety net. Output-tools path only; the prose
  // path passes an empty `threadResolves`, making this a no-op.
  if (threadResolves.length > 0) {
    // Build a lookup from threadId → first-comment author from the fetched threads.
    const threadAuthorMap = new Map<string, string | null>();
    for (const t of reviewThreads) {
      threadAuthorMap.set(t.id, t.comments[0]?.author ?? null);
    }

    for (const entry of threadResolves) {
      const firstAuthor = threadAuthorMap.get(entry.threadId);
      // Allow resolve only when the first comment is ours.
      if (firstAuthor !== reviewerLogin) {
        log.info("reviewer.thread_resolve_skipped", {
          event: "reviewer.thread_resolve_skipped",
          prUrl: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
          sha: pr.headSha,
          threadId: entry.threadId,
          firstAuthor,
          reason: "human-thread guard: first comment not from reviewer bot",
        });
        continue;
      }

      try {
        await resolveThread(octokit, entry.threadId);
        log.info("reviewer.thread_resolved", {
          event: "reviewer.thread_resolved",
          prUrl: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
          sha: pr.headSha,
          threadId: entry.threadId,
          modelReason: entry.reason,
        });
      } catch (resolveErr: unknown) {
        const message = resolveErr instanceof Error ? resolveErr.message : String(resolveErr);
        log.info("reviewer.thread_resolve_failed", {
          event: "reviewer.thread_resolve_failed",
          prUrl: `https://github.com/${owner}/${repo}/pull/${pr.number}`,
          sha: pr.headSha,
          threadId: entry.threadId,
          error: message,
        });
        // Non-fatal: resolve failure should not abort the review result.
      }
    }
  }

  // SC-5 (mt#1189): emit structured convergence metric per review.
  // Fields: PR number, head SHA, iteration index (N+1 where N is the count of
  // prior reviews), prior-blocker count (sum of all prior BLOCKING counts),
  // new-blocker count (BLOCKING count in current review body),
  // acknowledged-as-addressed count (best-effort from review body text).
  const priorBlockerTotal = priorReviewIngestion.priorBlockingCounts.reduce((acc, n) => acc + n, 0);
  const acknowledgedCount = countAcknowledgedFindings(acknowledgedBody);
  log.info(
    "reviewer.convergence_metric",
    buildConvergenceMetricLog(
      pr.number,
      pr.headSha,
      iterationIndex,
      priorBlockerTotal,
      blockingCount,
      acknowledgedCount
    )
  );

  // mt#1306 / mt#2725: persist the convergence metric to Postgres alongside the
  // stdout log, on BOTH success paths. No-op when no db; errors swallowed inside
  // the recorder. Convergence metrics are intentionally only emitted on the
  // successful-review path — the earlier early-returns (routing skip, empty
  // output, sanitize-errored) don't have meaningful prior/new/acknowledged
  // blocker counts to record. See PR #849 iter-2 review (mt#1306) for context.
  await persistConvergenceMetric(deps, {
    prOwner: owner,
    prRepo: repo,
    prNumber: pr.number,
    headSha: pr.headSha,
    iterationIndex,
    priorBlockerCount: priorBlockerTotal,
    newBlockerCount: blockingCount,
    acknowledgedAddressedCount: acknowledgedCount,
    headRef: pr.branchName,
    // mt#2287: per-review verdict distribution for the reviewer-bot cockpit widget.
    verdict: event.toLowerCase(),
  });

  // mt#2088: persist per-review timing data.
  await writeMainPathTiming(ctx);

  // mt#2725: emit pr.review_posted on the success path.
  await emitReviewPosted({
    owner,
    repo,
    prNumber: pr.number,
    reviewerLogin,
    event,
    taskId: taskSpecFetch.taskId,
  });

  return {
    status,
    review,
    reason,
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

/**
 * Finalize a failed review (empty-output or CoT-leakage path):
 * timing write -> publishCheckRun(failureSummary) -> return the `error`
 * ReviewResult. The per-path submit (skip notice vs. error notice) already ran
 * in `runReviewBody`; only the identical tail lives here.
 */
export async function finalizeReviewError(
  ctx: ReviewRunContext,
  reason: string
): Promise<ReviewResult> {
  const {
    deps,
    octokit,
    owner,
    repo,
    pr,
    tier,
    prScope,
    output,
    attempt,
    retryAttempted,
    taskSpecFetch,
    priorReviewIngestion,
  } = ctx;

  // mt#2088: timing on the error path.
  await writeMainPathTiming(ctx);

  // mt#2435: post a liveness-failure check run so the PR surface shows the
  // failure rather than staying silent (mt#1596 complement).
  const checkRunPublisherFn = deps.checkRunPublisher ?? publishCheckRun;
  await checkRunPublisherFn({
    octokit,
    owner,
    repo,
    headSha: pr.headSha,
    prNumber: pr.number,
    toolCalls: [],
    convergenceState: {
      roundNumber: priorReviewIngestion.iterationCount + 1,
      blockingCount: 0,
    },
    failureSummary: reason,
  });

  return {
    status: "error",
    reason,
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
