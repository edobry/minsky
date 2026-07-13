/**
 * Recovery + reconciliation + convergence + composition pipeline for the
 * reviewer, plus the prior-round BLOCKING-count DB read that feeds convergence.
 *
 * Extracted from `review-worker.ts` (mt#2720) as a behavior-preserving move so
 * the worker file has headroom under the `max-lines` ceiling. `review-worker.ts`
 * re-exports every symbol here, so external consumers keep importing from
 * `./review-worker` unchanged.
 */

import { eq, and, lt, asc } from "drizzle-orm";
import type { ReviewerDb } from "./db/client";
import { convergenceMetricsTable } from "./db/schemas/convergence-metrics-schema";
import { composeReviewBody, type ComposeReviewResult } from "./compose-review";
import type { ReviewToolCall } from "./output-tools";
import {
  applyMonotonicityRecovery,
  type DowngradeAuditEntry,
  type FlatPriorFinding,
} from "./severity-recovery";
import {
  applyEmptyFindingsRecovery,
  type EmptyFindingsRecoveryResult,
} from "./empty-findings-recovery";
import {
  applyCompositionConvergenceDowngrade,
  type ConvergenceDowngradeAuditEntry,
  type ConvergenceDetectionResult,
} from "./convergence-detector";
import {
  applyDiffScopeBoundedDowngrade,
  type DiffScopeDowngradeAuditEntry,
  type FixCommitLineRangeMap,
} from "./diff-scoper";

/**
 * Pure helper: apply monotonicity recovery and conclude_review reconciliation
 * to a list of tool calls, then compose the review body. Extracted from
 * runReview's outputToolsActive branch so the recovery+reconciliation+
 * composition flow can be unit-tested without mocking GitHub/OpenAI/MCP.
 *
 * PR #922 R7-R13 catch: the bot persistently flagged the lack of unit tests
 * for the runReview integration path. Full integration tests (mocking
 * octokit, callReviewer, getAppIdentity, fetchPriorReviews, MCP) are
 * substantial work deferred to mt#1497. This pure helper covers the
 * core recovery+reconciliation+composition logic that runReview now
 * delegates to it, addressing the test gap at the unit level.
 *
 * Behavior:
 *   1. If recoveryEnabled AND priorFindings.length > 0, apply
 *      applyMonotonicityRecovery to downgrade BLOCKING findings whose file
 *      matched a prior NON-BLOCKING/PRE-EXISTING finding (per the spec in
 *      severity-recovery.ts).
 *   2. Count post-recovery BLOCKING findings.
 *   3. If recovery crossed zero (BLOCKING > 0 → BLOCKING == 0) AND a
 *      conclude_review with event=REQUEST_CHANGES was emitted, rewrite that
 *      conclude_review tool call to event=COMMENT before composition. This
 *      keeps the body's executive summary and the GitHub event consistent.
 *   4. Compose the review body from the (possibly reconciled) tool calls.
 *
 * Pure function — no I/O, no async, no logging. The caller is responsible
 * for emitting per-downgrade and summary log events using the returned
 * `downgrades` array and counts.
 */
export interface ComposeWithRecoveryResult {
  /** The (possibly recovered + reconciled) tool calls used for composition. */
  toolCalls: ReadonlyArray<ReviewToolCall>;
  /** The composed review body and event. */
  composed: ComposeReviewResult;
  /** Audit log entries for downgrades that fired. Empty when no recovery. */
  downgrades: ReadonlyArray<DowngradeAuditEntry>;
  /**
   * BLOCKING count from the MODEL'S OWN `submit_finding` calls only — captured
   * BEFORE Step 0 (mt#2685 synthesis) and before downgrade recovery. Excludes
   * any Step-0 synthesized finding (mt#2685 review R1: made explicit after
   * this field's ambiguity was flagged). See `synthesizedBlockingCount`.
   */
  originalBlockingCount: number;
  /**
   * BLOCKING count AFTER the full pipeline (Step 0 synthesis, then downgrade
   * recovery). Includes the Step-0 synthesized finding when
   * `synthesizedBlockingCount > 0` — compare against `originalBlockingCount`
   * to see the pipeline's net effect (mt#2685 review R1).
   */
  postRecoveryBlockingCount: number;
  /**
   * BLOCKING findings synthesized by Step 0 (mt#2685) — 0 or 1 (at most one
   * per review). Lets log/metric consumers distinguish "the model found N"
   * (`originalBlockingCount`) from "M of the N now reported were synthesized"
   * without re-deriving it from `emptyFindingsRecovery.applied` (review R1).
   */
  synthesizedBlockingCount: number;
  /** True when the conclude_review tool call was rewritten REQUEST_CHANGES → COMMENT. */
  reconcileApplied: boolean;
  /**
   * Result of the composition-side convergence detection pass (mt#1867 Fix 2).
   * Present only when convergenceEnabled=true. Absent (undefined) when the
   * feature flag is off so callers can conditionally log it.
   */
  convergenceDetection?: ConvergenceDetectionResult;
  /**
   * Audit entries for BLOCKINGs downgraded by the convergence detection pass.
   * Empty when convergenceEnabled=false or no downgrades fired.
   */
  convergenceDowngrades: ReadonlyArray<ConvergenceDowngradeAuditEntry>;
  /**
   * Audit entries for BLOCKINGs downgraded by the diff-scope-bounded pass
   * (mt#1875 Fix 3). Empty when diffScopeBoundedEnabled=false, when
   * priorReviewsMarkdown is empty (R1), or when no downgrades fired.
   */
  diffScopeBoundedDowngrades: ReadonlyArray<DiffScopeDowngradeAuditEntry>;
  /**
   * Result of the empty-findings coherence recovery pass (mt#2685). Always
   * present (unlike the feature-flagged passes above) — this pass runs
   * unconditionally since it repairs a model-output defect (REQUEST_CHANGES
   * with zero submit_finding calls), not a tunable recovery heuristic.
   */
  emptyFindingsRecovery: EmptyFindingsRecoveryResult;
}

export interface ApplyRecoveryAndComposeOptions {
  /** Whether to run the mt#1496 severity-monotonicity recovery pass. */
  recoveryEnabled: boolean;
  /**
   * Whether to run the mt#1867 composition-side convergence detection pass.
   * Default: false (feature-flagged until empirical verification).
   */
  convergenceEnabled?: boolean;
  /**
   * Pre-parsed flat findings from all prior rounds (any severity), for the
   * convergence evidence-novelty comparison. Oldest-first. When absent but
   * convergenceEnabled=true, the convergence detector uses an empty list
   * (equivalent to "all evidence is new" — conservative, will not fire).
   */
  priorFindingsForConvergence?: ReadonlyArray<import("./convergence-detector").FindingForDetection>;
  /**
   * BLOCKING counts from each prior round (oldest first) for convergence
   * strictly-decreasing check. Required when convergenceEnabled=true.
   */
  priorBlockingCounts?: ReadonlyArray<number>;
  /**
   * 1-based current iteration index (R1=1, R4=4, etc.) for convergence
   * threshold gating. Required when convergenceEnabled=true.
   */
  iterationIndex?: number;
  /**
   * Whether to run the mt#1875 diff-scope-bounded downgrade pass (Fix 3).
   * Default: false (feature-flagged until empirical verification).
   * Only fires when priorReviewsMarkdown is non-empty (R≥2).
   */
  diffScopeBoundedEnabled?: boolean;
  /**
   * Fix-commit-diff line range map. When supplied and non-empty, BLOCKING
   * findings outside this range are downgraded to NON-BLOCKING.
   * Produced by extractFixCommitDiff from the diff-scoper module.
   * When absent or empty, the downgrade pass is a no-op (conservative).
   */
  fixCommitLineRange?: FixCommitLineRangeMap;
}

export function applyRecoveryAndCompose(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  priorFindings: ReadonlyArray<FlatPriorFinding>,
  diffText: string,
  recoveryEnabled: boolean,
  options?: ApplyRecoveryAndComposeOptions
): ComposeWithRecoveryResult {
  const originalBlockingCount = toolCalls.filter(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  ).length;

  // Step 0: empty-findings coherence recovery (mt#2685). Runs FIRST, on the
  // RAW toolCalls (unconditionally — not gated by recoveryEnabled), and
  // is keyed on originalBlockingCount semantics (a REQUEST_CHANGES
  // conclusion with zero of the model's OWN submit_finding calls), never on
  // a post-downgrade count. This ordering is load-bearing: running it before
  // the downgrade passes below means that when it fires, blockingCount is
  // already >= 1 by the time Step 3's crossed-zero check runs, so that check
  // (which exists to reconcile a DIFFERENT case — a downgrade pass reducing
  // an originally-nonzero BLOCKING count to zero) never contradicts this
  // pass's synthesized finding. See empty-findings-recovery.ts's module doc
  // for the full incoherence + design-alternatives writeup.
  const emptyFindingsRecovery = applyEmptyFindingsRecovery(toolCalls);

  // Step 1: optionally recover (mt#1496 monotonicity recovery).
  let toolCallsForComposition: ReadonlyArray<ReviewToolCall> = emptyFindingsRecovery.toolCalls;
  let downgrades: ReadonlyArray<DowngradeAuditEntry> = [];
  if (recoveryEnabled && priorFindings.length > 0) {
    const recovery = applyMonotonicityRecovery(toolCallsForComposition, priorFindings, diffText);
    toolCallsForComposition = recovery.toolCalls;
    downgrades = recovery.downgrades;
  }

  // Step 2: count post-recovery BLOCKING.
  let postRecoveryBlockingCount = toolCallsForComposition.filter(
    (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
  ).length;

  // Step 3: reconcile conclude_review if recovery crossed zero.
  const shouldReconcile =
    recoveryEnabled &&
    postRecoveryBlockingCount === 0 &&
    toolCallsForComposition.some(
      (tc) => tc.name === "conclude_review" && tc.args.event === "REQUEST_CHANGES"
    );
  let reconcileApplied = false;
  if (shouldReconcile) {
    reconcileApplied = true;
    toolCallsForComposition = toolCallsForComposition.map((tc) => {
      if (tc.name !== "conclude_review" || tc.args.event !== "REQUEST_CHANGES") {
        return tc;
      }
      return {
        name: "conclude_review" as const,
        args: {
          event: "COMMENT" as const,
          summary: tc.args.summary,
        },
      };
    });
  }

  // Step 3b: composition-side convergence detection (mt#1867 Fix 2).
  // Runs AFTER monotonicity recovery so the convergence check sees already-
  // recovered tool calls (prevents double-downgrade of the same finding).
  let convergenceDetection: ConvergenceDetectionResult | undefined;
  let convergenceDowngrades: ReadonlyArray<ConvergenceDowngradeAuditEntry> = [];
  const opts = options ?? { recoveryEnabled };
  const convergenceEnabled = opts.convergenceEnabled ?? false;
  if (convergenceEnabled && postRecoveryBlockingCount > 0) {
    // Use pre-parsed findings if provided; otherwise empty list (conservative:
    // empty priorFindingsForConvergence means all evidence is "new", so no
    // stagnation fires — safe default).
    const priorFindingsForConvergence = opts.priorFindingsForConvergence ?? [];
    const priorCounts = opts.priorBlockingCounts ?? [];
    const iterIdx = opts.iterationIndex ?? 1;

    const convergenceResult = applyCompositionConvergenceDowngrade(
      toolCallsForComposition,
      priorFindingsForConvergence,
      priorCounts,
      iterIdx
    );

    convergenceDetection = convergenceResult.detectionResult;
    convergenceDowngrades = convergenceResult.downgrades;

    if (convergenceResult.downgradeApplied) {
      toolCallsForComposition = convergenceResult.toolCalls;
      // Recount post-convergence-downgrade BLOCKINGs.
      postRecoveryBlockingCount = toolCallsForComposition.filter(
        (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
      ).length;
    }
  }

  // Step 3c: diff-scope-bounded downgrade (mt#1875 Fix 3).
  // Runs AFTER convergence detection (Step 3b) so the scope check sees
  // already-convergence-downgraded tool calls (prevents double-audit of
  // the same finding). Fires only when diffScopeBoundedEnabled=true AND
  // fixCommitLineRange is non-empty (the caller gates on priorReviewsMarkdown
  // non-empty before supplying a non-empty lineRange — R1 path gets empty map
  // and the downgrade is a no-op by construction).
  let diffScopeBoundedDowngrades: ReadonlyArray<DiffScopeDowngradeAuditEntry> = [];
  const diffScopeBoundedEnabled = opts.diffScopeBoundedEnabled ?? false;
  if (diffScopeBoundedEnabled) {
    const fixCommitLineRange = opts.fixCommitLineRange ?? new Map();
    const diffScopeResult = applyDiffScopeBoundedDowngrade(
      toolCallsForComposition,
      fixCommitLineRange
    );
    diffScopeBoundedDowngrades = diffScopeResult.downgrades;
    if (diffScopeResult.downgradeApplied) {
      toolCallsForComposition = diffScopeResult.toolCalls;
      // Recount post-diff-scope-bounded BLOCKINGs.
      postRecoveryBlockingCount = toolCallsForComposition.filter(
        (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
      ).length;
    }
  }

  // Step 4: compose. Spread to coerce the readonly local to the mutable
  // signature expected by composeReviewBody (which only reads).
  const composed = composeReviewBody([...toolCallsForComposition]);

  return {
    toolCalls: toolCallsForComposition,
    composed,
    downgrades,
    originalBlockingCount,
    postRecoveryBlockingCount,
    // 1 when Step 0 synthesized a finding, 0 otherwise (mt#2685 review R1:
    // the pass only ever synthesizes at most one finding per review, so
    // `applied` boolean and this count carry identical information — this
    // field exists to make that information available under a name that
    // reads correctly next to originalBlockingCount/postRecoveryBlockingCount
    // in logs, without requiring the reader to know the pass's internals).
    synthesizedBlockingCount: emptyFindingsRecovery.applied ? 1 : 0,
    reconcileApplied,
    convergenceDetection,
    convergenceDowngrades,
    diffScopeBoundedDowngrades,
    emptyFindingsRecovery,
  };
}

/**
 * Read prior-round BLOCKING counts from the mt#1306 substrate
 * (reviewer_convergence_metrics table).
 *
 * Returns an array of new_blocker_count values, one per prior review row,
 * ordered oldest-first (ascending iteration_index). Excludes the current
 * round's row (rows with iteration_index >= currentIterationIndex).
 *
 * This is the authoritative source for the convergence detection path per
 * the mt#1867 spec ("reads prior-round convergence metrics from the mt#1306
 * substrate"). The fallback (parsed from GitHub review bodies) is used only
 * when the DB is unavailable.
 *
 * Errors are swallowed — the caller falls back to the review-body-parsed
 * counts. This mirrors the metrics-write swallow-on-error pattern.
 *
 * @param db                    Drizzle DB instance.
 * @param owner                 GitHub repository owner.
 * @param repo                  GitHub repository name.
 * @param prNumber              Pull request number.
 * @param currentIterationIndex 1-based index of the current review round.
 *                              Only rows with iteration_index < currentIterationIndex
 *                              are returned.
 */
export async function fetchPriorBlockingCountsFromDb(
  db: ReviewerDb,
  owner: string,
  repo: string,
  prNumber: number,
  currentIterationIndex: number
): Promise<number[]> {
  try {
    const rows = await db
      .select({ newBlockerCount: convergenceMetricsTable.newBlockerCount })
      .from(convergenceMetricsTable)
      .where(
        and(
          eq(convergenceMetricsTable.prOwner, owner),
          eq(convergenceMetricsTable.prRepo, repo),
          eq(convergenceMetricsTable.prNumber, prNumber),
          lt(convergenceMetricsTable.iterationIndex, currentIterationIndex)
        )
      )
      .orderBy(asc(convergenceMetricsTable.iterationIndex));
    return rows.map((r) => r.newBlockerCount);
  } catch {
    // Swallow — caller falls back to review-body-parsed counts.
    return [];
  }
}
