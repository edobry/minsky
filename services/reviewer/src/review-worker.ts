/**
 * Review worker: fetches PR context, runs the adversarial review, posts result.
 *
 * Called by the webhook handler when a relevant PR event fires. Produces one
 * review per invocation. Stateless beyond the config injected at boot.
 *
 * **Chinese-wall isolation boundary (per mt#1073 design constraints 2 + 3,
 * shipped via mt#1083, audit-traceability per mt#1511).** This worker is the
 * entry point of the deployed reviewer surface and is structurally isolated
 * from any implementer session by three mechanisms:
 *
 * 1. **Separate process** (operational guarantee — see Railway service
 *    config and `services/reviewer/src/config.ts` for the env-var contract).
 *    The worker runs inside the Railway-deployed `minsky-reviewer-webhook`
 *    service — a different process on a different host than any implementer
 *    Claude Code session. No shared filesystem, no shared memory, no
 *    inherited environment. (Verifiable in-repo via the env-var schema and
 *    ADR-006; not enforceable from this source file alone.)
 * 2. **Separate identity** (in-repo enforced). Submissions post under
 *    `minsky-reviewer[bot]` — a different GitHub App than `minsky-ai[bot]`
 *    (the implementer App). The App-identity split is enforced by
 *    `getAppIdentity` (`github-client.ts`) and rotates Octokit tokens per
 *    installation — see ADR-006. App IDs are config-driven; the canonical
 *    declarations live in the Railway service config (informational; see
 *    ADR-006).
 * 3. **Diff + spec + read-only access only** (in-repo enforced). Inputs
 *    to the model call (assembled below by `fetchPullRequestContext` +
 *    `resolveTaskSpec` + `buildReviewPrompt`) are exactly: the PR diff,
 *    the task spec, the Critic Constitution, and prior reviews. The model
 *    has read-only file access via the curated `tools.ts` allowlist
 *    (`readFile` + `listDirectory` only — no write surfaces). No
 *    implementer session transcript, chat history, or intermediate
 *    artifacts reach this entry point.
 *
 * The cousin surface — the local `.claude/agents/reviewer.md` subagent
 * dispatched in-conversation — enforces the same constraints via Claude
 * Code's Agent-tool fresh-system-prompt semantics and its own curated
 * `tools:` frontmatter. See that file's "Isolation boundary enforcement"
 * block for the local-surface analog, including the policy-level (not yet
 * structural) constraint on `Bash` use.
 */

import type { ReviewerConfig } from "./config";
import {
  createOctokit,
  fetchPriorReviews,
  fetchPullRequestContext,
  fetchReviewThreads,
  getAppIdentity,
  listDirectoryAtRef,
  readFileAtRef,
  submitReview,
  type ReviewThread,
  type SubmittedReview,
} from "./github-client";
import type { ReviewerDb } from "./db/client";
import type { ConvergenceMetricInput } from "./metrics";
import { type ReviewTimingInput, recordReviewTiming } from "./review-timing";
import { emitReviewPostedEvent, type ReviewPostedEvent } from "./review-events";
import { classifyPRScope, scopeBucketFor, type PRScope, type ScopeBucket } from "./pr-scope";
import { buildCriticConstitution, buildReviewPrompt } from "./prompt";
import { callReviewer, type ReviewOutput, type ReviewUsage } from "./providers";
import {
  shouldChunkReview,
  chunkFiles,
  buildChunkDiff,
  buildChunkedReviewPrompt,
} from "./chunked-review";
import type { PriorReview } from "./prior-review-summary";
import { countBlockingFindings, summarizePriorReviews } from "./prior-review-summary";
import { resolveTaskSpec, type TaskSpecFetchResult } from "./task-spec-fetch";
import type { TaskServiceInterface } from "@minsky/domain/tasks";
import type { BasePersistenceProvider } from "@minsky/domain/persistence/types";
import {
  decideRouting,
  resolveTier,
  type AuthorshipTier,
  type TierRoutingDecision,
} from "./tier-routing";
import type { ReviewerToolContext } from "./tools";
import { sanitizeReviewBody, redactForLog } from "./sanitize";
import { parsePriorReviewFindings, type FlatPriorFinding } from "./severity-recovery";
import { extractFixCommitDiff, type FixCommitLineRangeMap } from "./diff-scoper";
import { submitReviewWithGuards } from "./guarded-submit";
import { fetchAndVerifyDocImpact } from "./doc-impact-verifier";
import { acquireMarker, releaseMarker } from "./inflight-marker";
import { log } from "./logger";
import { extractPgErrorContext } from "./webhook-events";
import type { PublishCheckRunOptions } from "./check-run-publisher";

// ---------------------------------------------------------------------------
// mt#2720: pure helpers relocated to sibling modules for max-lines headroom.
// review-worker.ts imports what runReview/runReviewBody use internally and
// re-exports every moved symbol so external consumers (server.ts, sweeper.ts,
// status-comment.ts, review-worker.test.ts) keep importing from ./review-worker.
// ---------------------------------------------------------------------------
import {
  buildEmptyOutputSkipNotice,
  callReviewerWithRetry,
  validateReviewOutput,
  type ReviewAttemptTrace,
} from "./review-output-validation";
import { applyRecoveryAndCompose, fetchPriorBlockingCountsFromDb } from "./recovery-compose";
import {
  decidePostSanitizeOutcome,
  decideToolsActive,
  defaultForkAccessProbe,
} from "./review-decisions";
import {
  annotateReviewBody,
  buildRunReviewStartLog,
  buildSubmitFailureLog,
} from "./review-log-builders";
import {
  finalizeReviewError,
  finalizeReviewSuccess,
  type ReviewRunContext,
} from "./review-finalize";
import { logRecoveryOutcomes } from "./review-recovery-logging";

export {
  buildEmptyOutputSkipNotice,
  callReviewerWithRetry,
  validateReviewOutput,
  type CallReviewerFn,
  type CallWithRetryResult,
  type ReviewAttemptTrace,
} from "./review-output-validation";
export {
  applyRecoveryAndCompose,
  fetchPriorBlockingCountsFromDb,
  type ApplyRecoveryAndComposeOptions,
  type ComposeWithRecoveryResult,
} from "./recovery-compose";
export {
  decidePostSanitizeOutcome,
  decideToolsActive,
  defaultForkAccessProbe,
} from "./review-decisions";
export {
  annotateReviewBody,
  buildConvergenceMetricLog,
  buildRunReviewStartLog,
  buildSubmitFailureLog,
  parseReviewEvent,
  serializeSubmitError,
} from "./review-log-builders";
// mt#2731: persistConvergenceMetric moved to review-finalize.ts (alongside the
// finalize stages that call it); re-exported here so consumers/tests importing
// it from "./review-worker" keep working.
export { persistConvergenceMetric } from "./review-finalize";

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
  prNumber: number,
  // mt#1086 PR #969 R1 BLOCKING #1: type alias must include the new
  // optional timeoutMs parameter to match `fetchPriorReviews`'s extended
  // signature. Otherwise the call site at the `?? fetchPriorReviews`
  // fallback in runReview produces a 5-vs-4 arity mismatch when typed
  // strictly. Optional + defaulted on the fetchPriorReviews side keeps
  // existing test mocks compatible: a mock providing only the 4-param
  // shape still assigns to PriorReviewFetcherFn, and runReview's call
  // with `config.githubTimeoutMs` is silently ignored by the mock.
  timeoutMs?: number
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

  timingRecorder?: (db: ReviewerDb, input: ReviewTimingInput) => Promise<void>;

  /**
   * Test seam for the `pr.review_posted` system-event emit (mt#2725).
   * When provided, replaces the real `emitReviewPostedEvent` call. Injected in
   * tests to assert the emitter is called (with the right event/payload) on the
   * success paths and NOT on the error/skip paths, and to verify emit errors do
   * not propagate. Defaults to the real MCP-backed emit (best-effort).
   */
  eventEmitter?: (ev: ReviewPostedEvent) => Promise<void>;

  /**
   * Domain TaskService for task-spec fetch (mt#2121 direct domain import).
   * When absent, resolveTaskSpec returns status: "disabled".
   */
  taskService?: TaskServiceInterface | null;

  /**
   * Domain persistence provider for authorship-tier lookup via ProvenanceService
   * (mt#2121 direct domain import). When absent, tier resolution falls back to
   * the PR-body marker or the hybrid default.
   */
  persistenceProvider?: BasePersistenceProvider | null;

  /**
   * Test seam for check-run publication (mt#2435).
   * When provided, replaces the real `publishCheckRun` call.
   * Injected in tests to assert the publisher is called with the right payload
   * without triggering real GitHub API calls.
   * When absent, defaults to the real `publishCheckRun` from check-run-publisher.ts.
   */
  checkRunPublisher?: (options: PublishCheckRunOptions) => Promise<unknown>;
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
  log.info(
    "runReview_start",
    buildRunReviewStartLog(deliveryId, owner, repo, prNumber, headSha ?? "unknown")
  );

  const runReviewStart = Date.now();

  const octokit = await createOctokit(config);

  const pr = await fetchPullRequestContext(octokit, owner, repo, prNumber, config.githubTimeoutMs);
  const tier = await resolveTier(prNumber, pr.body, deps.persistenceProvider ?? null);

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
    log.info("pr_scope_marker_override", {
      event: "pr_scope_marker_override",
      owner,
      repo,
      pr: prNumber,
      sha: pr.headSha,
    });
  }

  const scopeBucket = scopeBucketFor(prScope);

  const routing = decideRouting(tier, config.tier2Enabled);
  if (!routing.shouldReview) {
    // mt#2088: timing on routing-skip path.
    if (deps.db !== undefined) {
      await (deps.timingRecorder ?? recordReviewTiming)(deps.db, {
        prOwner: owner,
        prRepo: repo,
        prNumber,
        headSha: pr.headSha,
        iterationIndex: 0,
        totalWallClockMs: Date.now() - runReviewStart,
        perRoundLatenciesMs: [],
        timeoutCount: 0,
        retryCount: 0,
        retryOutcomes: [],
        scopeClassification: prScope ?? null,
        toolUseActive: false,
        provider: config.provider,
        model: config.providerModel,
      });
    }
    return { status: "skipped", reason: routing.reason, tier };
  }

  // ---------------------------------------------------------------------------
  // In-flight marker (mt#1907): acquire AFTER routing.shouldReview so skipped
  // PRs don't churn marker rows. Uses pr.headSha (authoritative from GitHub)
  // rather than the caller-supplied headSha which may be stale.
  //
  // Fail-open contract (SC #6): if the DB is unavailable, proceed without the
  // marker guarantee rather than blocking the review.
  // ---------------------------------------------------------------------------
  const acquiredBy = deliveryId.startsWith("sweeper-") ? "sweeper" : "webhook";
  let markerId: string | null = null;

  if (deps.db !== undefined) {
    try {
      const markerResult = await acquireMarker(deps.db, {
        owner,
        repo,
        prNumber,
        headSha: pr.headSha,
        acquiredBy,
        deliveryId,
      });

      if (!markerResult.acquired) {
        // Another caller holds the marker — skip to avoid duplicate review.
        log.info("runReview.skipped_concurrent_inflight", {
          event: "runReview.skipped_concurrent_inflight",
          pr_owner: owner,
          pr_repo: repo,
          pr_number: prNumber,
          head_sha: pr.headSha,
          acquired_by: markerResult.heldBy,
          delivery_id: deliveryId,
        });
        // mt#2088: timing on concurrent-inflight skip path.
        await (deps.timingRecorder ?? recordReviewTiming)(deps.db, {
          prOwner: owner,
          prRepo: repo,
          prNumber,
          headSha: pr.headSha,
          iterationIndex: 0,
          totalWallClockMs: Date.now() - runReviewStart,
          perRoundLatenciesMs: [],
          timeoutCount: 0,
          retryCount: 0,
          retryOutcomes: [],
          scopeClassification: prScope ?? null,
          toolUseActive: false,
          provider: config.provider,
          model: config.providerModel,
        });
        return {
          status: "skipped",
          reason: "concurrent_inflight",
          tier,
        };
      }

      markerId = markerResult.id;
    } catch (markerErr: unknown) {
      // DB error — fail open: proceed without marker guarantee.
      // extractPgErrorContext surfaces error_code / error_detail / error_severity
      // (or error_cause_keys + error_cause_json fallback) so postgres errors like
      // 42P01 (undefined_table) appear in logs instead of just the SQL body
      // (mt#1968 — closes the observability gap surfaced by mt#1963).
      log.info("runReview.marker_acquire_failed_fail_open", {
        event: "runReview.marker_acquire_failed_fail_open",
        pr_owner: owner,
        pr_repo: repo,
        pr_number: prNumber,
        head_sha: pr.headSha,
        delivery_id: deliveryId,
        ...extractPgErrorContext(markerErr),
      });
    }
  }

  // Wrap the rest of runReview in try/finally to release the marker on completion
  // (success or error). When markerId is null (DB absent or acquire failed),
  // release is a no-op.
  try {
    return await runReviewBody(
      config,
      owner,
      repo,
      prNumber,
      prAuthorLogin,
      deliveryId,
      deps,
      octokit,
      pr,
      tier,
      prScope,
      scopeBucket,
      routing
    );
  } finally {
    if (markerId !== null && deps.db !== undefined) {
      await releaseMarker(deps.db, markerId).catch((releaseErr: unknown) => {
        const message = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
        log.warn("runReview.marker_release_failed", {
          event: "runReview.marker_release_failed",
          pr_owner: owner,
          pr_repo: repo,
          pr_number: prNumber,
          head_sha: pr.headSha,
          marker_id: markerId,
          error: message,
        });
      });
    }
  }
}

/**
 * Core runReview body — extracted so it can be wrapped in try/finally for
 * marker release without deep nesting. All heavy lifting is here; the outer
 * runReview does routing, marker acquisition, and release wrapping.
 *
 * Receives pre-computed values from runReview (pr, tier, prScope, etc.) to
 * avoid re-fetching.
 */
async function runReviewBody(
  config: ReviewerConfig,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthorLogin: string,
  deliveryId: string,
  deps: RunReviewDeps,
  octokit: Awaited<ReturnType<typeof createOctokit>>,
  pr: Awaited<ReturnType<typeof fetchPullRequestContext>>,
  tier: AuthorshipTier,
  prScope: PRScope,
  scopeBucket: ScopeBucket,
  _routing: TierRoutingDecision
): Promise<ReviewResult> {
  const reviewStartTime = Date.now();
  // Confirm the reviewer identity is distinct from the PR author. If they
  // happen to match (misconfiguration, same App used for both roles), we
  // cannot APPROVE and must fall back to COMMENT — GitHub blocks
  // self-approval at the platform level. Comparison is case-insensitive
  // because GitHub usernames are case-insensitive at the platform level and
  // API responses can return inconsistent casing.
  const reviewerIdentity = await getAppIdentity(config);
  const isSelfReview = reviewerIdentity.login.toLowerCase() === prAuthorLogin.toLowerCase();

  // pr.review_posted emitter (mt#2725): injected seam in tests, real MCP-backed
  // emit in production. Called from the two success paths below (output-tools +
  // prose), never from the empty-output / CoT-leakage error paths.
  const emitReviewPosted: (ev: ReviewPostedEvent) => Promise<void> =
    deps.eventEmitter ?? ((ev) => emitReviewPostedEvent(config, ev));

  // Fetch the task spec via the domain TaskService if configured. Never blocks —
  // missing service, missing task, or PR with no mt# reference all produce
  // taskSpec: null with a structured fetchResult the server logs.
  const { taskSpec, fetchResult: taskSpecFetch } = await resolveTaskSpec({
    branchName: pr.branchName,
    prTitle: pr.title,
    taskService: deps.taskService ?? null,
  });

  // Fetch prior bot reviews on this PR. Non-blocking — errors produce an empty
  // summary with error logged, review continues without prior context.
  const priorReviewFetcherFn = deps.priorReviewFetcher ?? fetchPriorReviews;
  let priorReviewIngestion: PriorReviewIngestionResult;
  let priorReviewsMarkdown = "";
  // Flat list of prior findings (file + severity + line range) used by the
  // mt#1496 monotonicity-recovery layer when REVIEWER_MONOTONICITY_RECOVERY_ENABLED
  // is set. Empty when the feature flag is off OR when no prior reviews were
  // fetched. Computed alongside priorReviewsMarkdown so we don't pay the parse
  // cost twice.
  let priorFlatFindings: FlatPriorFinding[] = [];
  try {
    const rawPriorReviews = await priorReviewFetcherFn(
      octokit,
      owner,
      repo,
      prNumber,
      config.githubTimeoutMs
    );
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
    // mt#1496: extract flat findings from prior bodies for the monotonicity-
    // recovery layer. Always computed (cheap) regardless of the feature flag,
    // so the wiring is symmetric across flag states.
    priorFlatFindings = parsePriorReviewFindings(priorReviews.map((r) => r.body));
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.warn(`[mt#1189] Prior-review fetch failed, continuing without context: ${errorMessage}`);
    priorReviewIngestion = {
      iterationCount: 0,
      staleCount: 0,
      priorBlockingCounts: [],
      error: errorMessage,
    };
    priorFlatFindings = [];
  }

  // Fetch review threads (mt#1345): provides existing inline thread state to
  // the model so it can reply to existing threads rather than opening duplicates.
  // Non-blocking — returns [] on any error (graceful degradation like prior reviews).
  // Only fetch when output tools are likely active; for non-OpenAI providers the
  // thread context is informational but not yet wired into the prompt.
  let reviewThreads: ReviewThread[] = [];
  try {
    reviewThreads = await fetchReviewThreads(octokit, owner, repo, prNumber);
  } catch (err: unknown) {
    // fetchReviewThreads already degrades gracefully internally; this outer
    // catch is a safety net for any unexpected throw from the wiring.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`[mt#1345] Review-thread fetch failed, continuing without thread context: ${message}`);
  }

  // mt#1875 SC2: when diff-scope-bounded is enabled AND prior reviews exist (R≥2),
  // narrow the prompt context to the fix-commit diff. This must happen before
  // buildReviewPrompt so the model only sees the narrowed diff in its context.
  //
  // We read the env var here (outside the outputToolsActive block) so the prompt
  // diff routing and the post-hoc downgrade both use the same flag and the same
  // extracted diff. On R1 (no prior reviews), promptDiff falls back to pr.diff.
  const diffScopeBoundedEnabledForPrompt = /^(true|1|yes|on)$/i.test(
    (process.env.REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED ?? "").trim()
  );
  const priorReviewsPresentForPrompt = priorReviewsMarkdown.trim().length > 0;

  // Extracted fix-commit diff for prompt routing and for the downgrade pass.
  // Initialized as a shared variable so the outputToolsActive block can reuse it.
  let promptDiff = pr.diff;
  let sharedFixCommitLineRange: FixCommitLineRangeMap = new Map();

  if (diffScopeBoundedEnabledForPrompt && priorReviewsPresentForPrompt) {
    // Use the full PR diff as the fix-commit scope approximation. A future
    // enhancement can filter to commits after the prior-review timestamp via
    // the GitHub commits API; for now, the full PR diff is a conservative
    // safe fallback that still enables downgrading findings on files/lines
    // not present in the PR diff at all.
    const priorTimestamp =
      priorReviewIngestion.iterationCount > 0
        ? new Date(0).toISOString() // placeholder — real per-commit filtering is future work
        : new Date(0).toISOString();
    try {
      const fixCommitResult = extractFixCommitDiff(pr.diff, priorTimestamp);
      promptDiff = fixCommitResult.diff;
      sharedFixCommitLineRange = fixCommitResult.lineRange;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(
        `[mt#1875] Fix-commit diff extraction failed for prompt routing, using full PR diff: ${message}`
      );
      // promptDiff remains pr.diff (full diff fallback)
    }
  }

  const basePromptInput = {
    prNumber: pr.number,
    prTitle: pr.title,
    prBody: pr.body,
    taskSpec,
    authorshipTier: tier,
    branchName: pr.branchName,
    baseBranch: pr.baseBranch,
    priorReviews: priorReviewsMarkdown || undefined,
    reviewThreads: reviewThreads.length > 0 ? reviewThreads : undefined,
  };

  const userPrompt = buildReviewPrompt({
    ...basePromptInput,
    diff: promptDiff,
  });

  // Construct the tool context for this PR's HEAD ref. The model can use these
  // to verify cross-file claims before reporting them as findings.
  //
  // For forked PRs, `headSha` only exists in the head repository (fork), not
  // the base repo. Passing (owner=base, repo=base, ref=headSha) to getContent
  // 404s. Use the head coords so tool calls resolve correctly on forks too.
  const toolContext: ReviewerToolContext = {
    // mt#1086 PR #969 R2 BLOCKING #2: forward the caller signal from the
    // OpenAI tool loop's withTimeout through to readFileAtRef /
    // listDirectoryAtRef so it propagates into Octokit and actually cancels
    // the underlying request when the budget elapses.
    readFile: (path: string, signal?: AbortSignal) =>
      readFileAtRef(
        octokit,
        pr.headOwner,
        pr.headRepo,
        path,
        pr.headSha,
        config.githubTimeoutMs,
        signal
      ),
    listDirectory: (path: string, signal?: AbortSignal) =>
      listDirectoryAtRef(
        octokit,
        pr.headOwner,
        pr.headRepo,
        path,
        pr.headSha,
        config.githubTimeoutMs,
        signal
      ),
  };

  // Gate tool wiring via the pure helper. For forked PRs on OpenAI the probe
  // runs a lightweight readFileAtRef for README.md (with package.json as
  // fallback); if it succeeds, tools are enabled on the fork. Otherwise we
  // switch to the NO_TOOLS_SECTION prompt so the model marks cross-file
  // claims as NEEDS VERIFICATION.
  const { toolsActive, reason } = await decideToolsActive(config, pr, () =>
    defaultForkAccessProbe(octokit, pr)
  );

  // Output tools (submit_finding, conclude_review, etc.) follow the same gate
  // as reviewer tools: OpenAI-only (mt#1399 wires them only for OpenAI). When
  // both toolsActive and provider=openai, the model sees and uses output tools.
  const outputToolsActive = toolsActive && config.provider === "openai";

  // mt#1656 / mt#1640 Fix 1: when prior reviews exist on this PR (R≥2), swap
  // the standard preamble for a verification-mode preamble that defaults to
  // APPROVE when prior BLOCKING findings have been addressed and no critical
  // defects remain. Cancels the asymmetric incentive that produces no-stopping-
  // rule iteration on subsequent rounds.
  const priorReviewsPresent = priorReviewsMarkdown.trim().length > 0;
  const systemPrompt = buildCriticConstitution(
    toolsActive,
    scopeBucket,
    outputToolsActive,
    priorReviewsPresent
  );

  // Log why tools are off when they're off, so operators can see it in the
  // service logs rather than silently losing tool support.
  if (!toolsActive && reason) {
    log.warn(`[mt#1126/mt#1216] Running review without tools: ${reason}`);
  }

  // Chunked review gate (mt#2120): when the diff is large, split into
  // per-file chunks and review each chunk separately to avoid 1M+ token
  // prompts that cause cascading timeouts.
  const totalDiffLines = promptDiff.split("\n").length;
  const useChunkedReview = outputToolsActive && shouldChunkReview(pr.fileEntries, totalDiffLines);

  let output: ReviewOutput;
  let validation: { ok: true } | { ok: false; reason: string };
  let attempt: ReviewAttemptTrace;
  let retryAttempted: boolean;

  if (useChunkedReview) {
    const chunks = chunkFiles(pr.fileEntries);

    // Fallback: if fileEntries was empty (listFiles error/cap) but diff
    // was large, chunks is []. Fall through to single-pass rather than
    // hard-failing with a skip notice.
    if (chunks.length === 0) {
      log.info("reviewer.chunked_review_fallback_single_pass", {
        event: "reviewer.chunked_review_fallback_single_pass",
        owner,
        repo,
        pr: prNumber,
        reason: "zero_chunks_from_empty_file_entries",
        totalDiffLines,
      });
      const result = await callReviewerWithRetry(
        config,
        systemPrompt,
        userPrompt,
        toolsActive ? toolContext : undefined,
        callReviewer,
        outputToolsActive
      );
      output = result.output;
      validation = result.validation;
      attempt = result.attempt;
      retryAttempted = result.retryAttempted;
    } else {
      log.info("reviewer.chunked_review_start", {
        event: "reviewer.chunked_review_start",
        owner,
        repo,
        pr: prNumber,
        totalFiles: pr.fileEntries.length,
        totalDiffLines,
        chunkCount: chunks.length,
        filesPerChunk: chunks.map((c) => c.files.length),
      });

      const allToolCalls: ReviewOutput["toolCalls"] = [];
      let totalPromptTokens = 0;
      let totalCompletionTokens = 0;
      let totalReasoningTokens = 0;
      let lastText = "";
      const allRoundLatencies: number[] = [];
      let totalTimeoutCount = 0;
      const allRetryOutcomes: string[] = [];

      for (const chunk of chunks) {
        const chunkDiff = buildChunkDiff(chunk, pr.diff);
        const chunkPrompt = buildChunkedReviewPrompt(basePromptInput, chunk, chunkDiff);

        const chunkResult = await callReviewerWithRetry(
          config,
          systemPrompt,
          chunkPrompt,
          toolsActive ? toolContext : undefined,
          callReviewer,
          outputToolsActive
        );

        allToolCalls.push(...chunkResult.output.toolCalls);
        totalPromptTokens += chunkResult.output.usage?.promptTokens ?? 0;
        totalCompletionTokens += chunkResult.output.usage?.completionTokens ?? 0;
        totalReasoningTokens += chunkResult.output.usage?.reasoningTokens ?? 0;
        lastText = chunkResult.output.text || lastText;

        if (chunkResult.output.timing) {
          allRoundLatencies.push(...chunkResult.output.timing.roundLatenciesMs);
          totalTimeoutCount += chunkResult.output.timing.timeoutCount;
          allRetryOutcomes.push(...chunkResult.output.timing.retryOutcomes);
        }

        log.info("reviewer.chunked_review_chunk_complete", {
          event: "reviewer.chunked_review_chunk_complete",
          owner,
          repo,
          pr: prNumber,
          chunkIndex: chunk.index,
          totalChunks: chunk.totalChunks,
          toolCalls: chunkResult.output.toolCalls.length,
          promptTokens: chunkResult.output.usage?.promptTokens ?? 0,
        });
      }

      const totalTokens = totalPromptTokens + totalCompletionTokens;
      output = {
        text: lastText,
        tokensUsed: totalTokens,
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          reasoningTokens: totalReasoningTokens,
          totalTokens,
        },
        provider: config.provider,
        model: config.providerModel,
        toolCalls: allToolCalls,
        timing: {
          roundLatenciesMs: allRoundLatencies,
          timeoutCount: totalTimeoutCount,
          retryOutcomes: allRetryOutcomes,
        },
      };
      validation = validateReviewOutput(output, outputToolsActive);
      attempt = "first-attempt-success";
      retryAttempted = false;
    } // close the chunks.length > 0 else block
  } else {
    // Single-pass mode (existing behavior for small PRs)
    const result = await callReviewerWithRetry(
      config,
      systemPrompt,
      userPrompt,
      toolsActive ? toolContext : undefined,
      callReviewer,
      outputToolsActive
    );
    output = result.output;
    validation = result.validation;
    attempt = result.attempt;
    retryAttempted = result.retryAttempted;
  }
  const totalWallClockMs = Date.now() - reviewStartTime;

  // mt#2731: invariant per-review context shared by every terminal path
  // (empty-output error, output-tools success, CoT-leakage error, prose
  // success). Built once here — all its fields are known after the model call —
  // and handed to finalizeReviewSuccess / finalizeReviewError below.
  const reviewRunContext: ReviewRunContext = {
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
    totalWallClockMs,
    outputToolsActive,
    reviewerLogin: reviewerIdentity.login,
    emitReviewPosted,
  };

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
    // catch defensively and continue to the error return below. Log the
    // secondary failure so operators can correlate "primary error in
    // status=error return + GitHub silent" against a submission-side cause
    // (rate limit, transient 5xx, identity issue) rather than guessing.
    try {
      await submitReview(
        octokit,
        owner,
        repo,
        prNumber,
        "COMMENT",
        skipNotice,
        config.githubTimeoutMs
      );
    } catch (submitErr) {
      log.info(
        "reviewer.submit_skip_notice_failed",
        buildSubmitFailureLog("reviewer.submit_skip_notice_failed", {
          prCoords: { owner, repo, prNumber, sha: pr.headSha },
          primaryReason: validation.reason,
          submitErr,
          provider: output.provider,
          model: output.model,
        })
      );
    }
    // mt#2088 timing + mt#2435 liveness-failure check run + error return
    // (mt#2731: shared with the CoT-leakage error path).
    return finalizeReviewError(reviewRunContext, validation.reason);
  }

  // -------------------------------------------------------------------------
  // Post-validation flow: branch on outputToolsActive
  //
  // OpenAI + output-tools-active path: compose review body from toolCalls,
  // then submit. Sanitizer runs on output.text (the scratch channel) for
  // defensive logging only — its result never gates what is posted.
  //
  // All other paths (Gemini/Anthropic, or feature flag off): preserve the
  // existing sanitize → decidePostSanitizeOutcome flow exactly as before.
  // -------------------------------------------------------------------------

  if (outputToolsActive) {
    // mt#1496 severity-monotonicity recovery: when enabled, downgrade BLOCKING
    // findings whose file matches a prior NON-BLOCKING / PRE-EXISTING finding
    // AND whose cited line range is not touched by new lines in the diff under
    // review. The flag is read per-invocation rather than at boot so operators
    // can toggle without redeploy. Default-off keeps deployed behavior
    // unchanged until a deliberate enablement. Accepts common truthy
    // values: "true", "1", "yes", "on" (case-insensitive) — PR #922 R20#5
    // expanding R18#3.
    const monotonicityRecoveryEnabled = /^(true|1|yes|on)$/i.test(
      (process.env.REVIEWER_MONOTONICITY_RECOVERY_ENABLED ?? "").trim()
    );

    // mt#1867 composition-side convergence detection (Fix 2 from mt#1640 paper):
    // when enabled, downgrade ALL BLOCKINGs when R(N+1) shows neither strictly-
    // decreasing BLOCKING count nor new evidence per finding. Default-off until
    // empirical verification (same pattern as monotonicityRecovery above).
    const compositionConvergenceEnabled = /^(true|1|yes|on)$/i.test(
      (process.env.REVIEWER_COMPOSITION_CONVERGENCE_ENABLED ?? "").trim()
    );

    // mt#1875 diff-scope-bounded downgrade (Fix 3 from mt#1640 paper):
    // when enabled AND priorReviewsMarkdown is non-empty (R≥2), restrict
    // BLOCKING findings to those within the fix-commit-diff line range.
    // Findings outside the range are auto-downgraded to NON-BLOCKING.
    // Default-off until empirical verification (same convention as above).
    //
    // NOTE: diffScopeBoundedEnabledForPrompt (computed before buildReviewPrompt
    // above) reads the same env var; using the same value here ensures the
    // prompt-context routing and the post-hoc downgrade are always in sync.
    const diffScopeBoundedEnabled = diffScopeBoundedEnabledForPrompt;

    // Compute iteration index (1-based) for the convergence threshold gate.
    // iterationCount is the count of prior reviews (0 for first review, 1 for second, etc.)
    // so iterationIndex = iterationCount + 1.
    const currentIterationIndex = priorReviewIngestion.iterationCount + 1;

    // mt#1867: read prior BLOCKING counts from the mt#1306 DB substrate when the
    // DB is available. This is the spec-required source for convergence detection
    // ("reads prior-round convergence metrics from the mt#1306 substrate").
    //
    // Fallback: if DB is unavailable or returns empty (e.g., for PRs predating
    // mt#1306), fall back to counts parsed from GitHub review bodies
    // (priorReviewIngestion.priorBlockingCounts). The fallback is only used when
    // the DB read returns an empty array, ensuring the detector still has prior
    // context when DB rows are not yet populated.
    let priorBlockingCountsForConvergence: ReadonlyArray<number> =
      priorReviewIngestion.priorBlockingCounts;
    if (compositionConvergenceEnabled && deps.db !== undefined) {
      const dbCounts = await fetchPriorBlockingCountsFromDb(
        deps.db,
        owner,
        repo,
        prNumber,
        currentIterationIndex
      );
      if (dbCounts.length > 0) {
        priorBlockingCountsForConvergence = dbCounts;
        log.info("reviewer.composition_convergence_counts_source", {
          event: "reviewer.composition_convergence_counts_source",
          prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
          sha: pr.headSha,
          source: "db_substrate",
          count: dbCounts.length,
          iterationIndex: currentIterationIndex,
        });
      } else {
        log.info("reviewer.composition_convergence_counts_source", {
          event: "reviewer.composition_convergence_counts_source",
          prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
          sha: pr.headSha,
          source: "review_body_fallback",
          reason:
            "DB returned no rows (PR may predate mt#1306 substrate or first review); using parsed review body counts",
          count: priorReviewIngestion.priorBlockingCounts.length,
          iterationIndex: currentIterationIndex,
        });
      }
    }

    // mt#1875: reuse the fix-commit line range extracted before buildReviewPrompt
    // (sharedFixCommitLineRange). Both the prompt-context routing and the post-hoc
    // downgrade use the same extracted scope so they are consistent.
    //
    // When priorReviewsMarkdown is empty (R1), sharedFixCommitLineRange is an empty
    // map (set by the guard above), so the downgrade pass is a no-op by construction
    // (conservative behavior: preserve all findings on R1 reviews).
    const fixCommitLineRange: FixCommitLineRangeMap = sharedFixCommitLineRange;
    if (diffScopeBoundedEnabled && priorReviewsPresent) {
      log.info("reviewer.diff_scope_bounded_extracted", {
        event: "reviewer.diff_scope_bounded_extracted",
        prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        sha: pr.headSha,
        iterationIndex: currentIterationIndex,
        diff_scope: "fix_commit",
        filesInScope: fixCommitLineRange.size,
      });
    }

    // mt#2154: doc-impact verification — check that docs listed in affectedDocs
    // actually reference the changed surfaces before flagging them as BLOCKING.
    const docVerification = await fetchAndVerifyDocImpact(
      output.toolCalls,
      pr.filesChanged,
      pr.diff,
      async (docPath) => {
        const result = await readFileAtRef(octokit, pr.headOwner, pr.headRepo, docPath, pr.headSha);
        return result !== null && result.kind === "text" ? result.content : null;
      }
    );
    const toolCallsForRecovery = docVerification.toolCalls;

    if (docVerification.verificationsApplied) {
      log.info("reviewer.doc_impact_verification", {
        event: "reviewer.doc_impact_verification",
        prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        sha: pr.headSha,
        removedDocs: docVerification.removedDocs,
        removedCount: docVerification.removedDocs.length,
      });
    }

    // Delegate the recovery + reconciliation + convergence + composition to the
    // pure helper applyRecoveryAndCompose (PR #922 R7-R13: addresses the bot's
    // persistent "no integration tests" complaint at the unit level — see
    // applyRecoveryAndCompose tests in review-worker.test.ts).
    // priorFlatFindings is already parsed (FlatPriorFinding[] from severity-recovery).
    // FlatPriorFinding is structurally compatible with FindingForDetection (same fields:
    // file, severity, line?, lineEnd?), so we can pass it directly as
    // priorFindingsForConvergence without re-parsing the prior review bodies.
    const recoveryResult = applyRecoveryAndCompose(
      toolCallsForRecovery,
      priorFlatFindings,
      pr.diff,
      monotonicityRecoveryEnabled,
      {
        recoveryEnabled: monotonicityRecoveryEnabled,
        convergenceEnabled: compositionConvergenceEnabled,
        priorFindingsForConvergence: priorFlatFindings,
        priorBlockingCounts: priorBlockingCountsForConvergence,
        iterationIndex: currentIterationIndex,
        diffScopeBoundedEnabled,
        fixCommitLineRange,
      }
    );
    const composed = recoveryResult.composed;
    const blockingCount = recoveryResult.postRecoveryBlockingCount;

    // mt#2731: recovery-outcome logging (empty-findings synthesis, severity
    // downgrades, composition-convergence downgrades, diff-scope-bounded
    // downgrades) extracted to review-recovery-logging.ts. Pure logging; the
    // per-block gating (feature flags + `applied` flags) is unchanged.
    logRecoveryOutcomes({
      recoveryResult,
      output,
      owner,
      repo,
      prNumber,
      headSha: pr.headSha,
      iterationIndex: currentIterationIndex,
      monotonicityRecoveryEnabled,
      compositionConvergenceEnabled,
      diffScopeBoundedEnabled,
      priorReviewsPresent,
      filesInScope: fixCommitLineRange.size,
    });

    // Self-review override: structural event from composeReviewBody (already
    // reconciled with recovery above), but force COMMENT when the reviewer
    // identity matches the PR author (GitHub blocks self-approval at the
    // platform level — same rule as the prose path).
    const event = isSelfReview ? "COMMENT" : composed.event;

    // Defensive sanitizer logging: run the sanitizer on output.text (the
    // free-text scratch channel). If it fires, emit a structured log event
    // so operators can see CoT leakage via the scratch channel — but do NOT
    // use the sanitizer's result to gate what is posted. The tool calls are
    // the authoritative output on this path.
    const scratchSanitized = sanitizeReviewBody(output.text);
    if (scratchSanitized.action !== "passthrough") {
      log.info("reviewer.cot_leak_detected_in_scratch", {
        event: "reviewer.cot_leak_detected_in_scratch",
        prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        sha: pr.headSha,
        originalLength: scratchSanitized.meta.originalLength,
        cleanedLength: scratchSanitized.meta.cleanedLength,
        reason: scratchSanitized.meta.reason,
        provider: output.provider,
        model: output.model,
      });
    }

    const annotatedBody = annotateReviewBody(
      composed.body,
      output,
      tier,
      isSelfReview,
      recoveryResult.toolCalls
    );

    // mt#2350: submit with anchor pre-validation + circuit-breaker recording.
    // A single unresolvable inline-comment anchor 422s the entire createReview
    // payload ("Line could not be resolved"); the guard demotes unanchorable
    // comments to the body and records non-retryable failures for the sweeper.
    const review = await submitReviewWithGuards({
      octokit,
      owner,
      repo,
      prNumber,
      event,
      body: annotatedBody,
      composedInlineComments: composed.inlineComments,
      diff: pr.diff,
      headSha: pr.headSha,
      timeoutMs: config.githubTimeoutMs,
      db: deps.db,
    });

    // mt#2731: shared success finalize — publishCheckRun (with the recovered
    // tool calls as annotations) -> thread-resolve loop (mt#1345) -> convergence
    // stdout log -> persistConvergenceMetric (mt#2725, verdict per mt#2287) ->
    // timing write (mt#2088) -> emit pr.review_posted (mt#2725) -> return.
    return finalizeReviewSuccess(reviewRunContext, {
      review,
      event,
      blockingCount,
      acknowledgedBody: composed.body,
      checkRunToolCalls: recoveryResult.toolCalls,
      threadResolves: composed.threadResolves,
      reviewThreads,
      status: "reviewed",
      reason: `Posted ${event} review as ${reviewerIdentity.login} (provider=${output.provider}, model=${output.model}, attempt=${attempt}) [output-tools]`,
    });
  }

  // -------------------------------------------------------------------------
  // Prose path (non-OpenAI or output-tools-off): CoT-leakage guard + sanitize
  // -------------------------------------------------------------------------

  // CoT-leakage guard (mt#1212): detect model scratch leaking into the visible
  // review body. Distinct from the empty-output guard above — here the model
  // produced content, but part of it is internal reasoning that should not
  // ship. Observed on PR #743 (2026-04-24). Either strip the leaked prefix
  // (when a structural Findings section follows) or replace the body with a
  // structured service-error notice (when the leak is the entire body).
  const sanitized = sanitizeReviewBody(output.text);
  if (sanitized.action !== "passthrough") {
    log.info("reviewer.cot_leak_detected", {
      event: "reviewer.cot_leak_detected",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: pr.headSha, // canonical field name (aligned with review_result log)
      commitSha: pr.headSha, // deprecated: kept for Railway log-filter backward compatibility; remove after consumers migrate to `sha`
      originalLength: sanitized.meta.originalLength,
      cleanedLength: sanitized.meta.cleanedLength,
      action: sanitized.action,
      reason: sanitized.meta.reason,
      prefixSnippet: redactForLog(output.text), // mt#1264: redacted first ~200 chars for FP/TP calibration
      provider: output.provider,
      model: output.model,
    });
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
        annotateReviewBody(sanitized.body, output, tier, isSelfReview),
        config.githubTimeoutMs
      );
    } catch (submitErr) {
      // Log the secondary failure (mt#1370). Without this, a CoT-leak followed
      // by a submitReview failure leaves zero trace on GitHub and only the
      // primary outcome.reason in Railway logs — operators cannot tell whether
      // the bot tried-and-failed or never tried at all. Symptom case: PR #830
      // 2026-04-27, second commit 7e7be76a9 silent for 11+ minutes.
      log.info(
        "reviewer.submit_error_notice_failed",
        buildSubmitFailureLog("reviewer.submit_error_notice_failed", {
          prCoords: { owner, repo, prNumber, sha: pr.headSha },
          primaryReason: outcome.reason,
          sanitizeReason: sanitized.meta.reason,
          submitErr,
          provider: output.provider,
          model: output.model,
        })
      );
    }
    // mt#2088 timing + mt#2435 liveness-failure check run + error return
    // (mt#2731: shared with the empty-output error path).
    return finalizeReviewError(reviewRunContext, outcome.reason);
  }

  // mt#2350 PR #1621 R2: route the prose-path final submission through the same
  // guard as the output-tools path so the circuit-breaker record/clear chokepoint
  // covers BOTH paths (a non-retryable 4xx here — closed PR, permission edge —
  // must also stop the sweeper loop). No inline comments on the prose path, so
  // anchor pre-validation is a no-op; the breaker recording is the point.
  const review = await submitReviewWithGuards({
    octokit,
    owner,
    repo,
    prNumber,
    event: outcome.event,
    body: annotateReviewBody(sanitized.body, output, tier, isSelfReview),
    composedInlineComments: [],
    diff: pr.diff,
    headSha: pr.headSha,
    timeoutMs: config.githubTimeoutMs,
    db: deps.db,
  });

  // Best-effort count of BLOCKING findings in the submitted review body.
  // Enables "prior-blocker count / new-blocker count" convergence metric in logs.
  // Shares countBlockingFindings with the prior-review counts above.
  const blockingCount: number = countBlockingFindings(sanitized.body);

  // mt#2731: shared success finalize — no structured tool calls on the prose
  // path (empty check-run annotations) and no thread-resolve directives, so the
  // check-run annotations and the thread-resolve loop are both no-ops here.
  return finalizeReviewSuccess(reviewRunContext, {
    review,
    event: outcome.event,
    blockingCount,
    acknowledgedBody: sanitized.body,
    checkRunToolCalls: [],
    threadResolves: [],
    reviewThreads: [],
    status: outcome.status,
    reason: outcome.reason,
  });
}
