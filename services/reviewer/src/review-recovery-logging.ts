/**
 * Recovery-outcome logging (mt#2731).
 *
 * The output-tools review path emits up to five structured log events off the
 * `applyRecoveryAndCompose` result so operators can audit the recovery layer's
 * decisions (severity downgrades, composition-convergence downgrades,
 * diff-scope-bounded downgrades, empty-findings synthesis) and detect
 * "enabled but never fired" scenarios on dashboards.
 *
 * Extracted verbatim from `runReviewBody` — pure logging, no control flow beyond
 * the per-block gating. Behavior-preserving move: the log event names, fields,
 * and gating conditions are unchanged.
 */

import { log } from "./logger";
import type { ReviewOutput } from "./providers";
import type { ComposeWithRecoveryResult } from "./recovery-compose";

export interface LogRecoveryOutcomesInput {
  /** Result of applyRecoveryAndCompose (recovery + reconciliation + convergence). */
  recoveryResult: ComposeWithRecoveryResult;
  /** The model output — its `toolCalls` supply the pre-recovery finding counts. */
  output: ReviewOutput;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  /** 1-based current review round (priorReviewIngestion.iterationCount + 1). */
  iterationIndex: number;
  /** REVIEWER_MONOTONICITY_RECOVERY_ENABLED — gates the severity_downgrade_summary event. */
  monotonicityRecoveryEnabled: boolean;
  /** REVIEWER_COMPOSITION_CONVERGENCE_ENABLED — gates the composition_convergence events. */
  compositionConvergenceEnabled: boolean;
  /** REVIEWER_DIFF_SCOPE_BOUNDED_ENABLED — gates the diff_scope_bounded events. */
  diffScopeBoundedEnabled: boolean;
  /** True when prior reviews exist on this PR (R≥2). Reported in the diff-scope summary. */
  priorReviewsPresent: boolean;
  /** fixCommitLineRange.size — number of files in the fix-commit scope. */
  filesInScope: number;
}

/**
 * Emit the recovery-outcome log events for one output-tools review.
 * Pure side-effect (log.info only); returns nothing.
 */
export function logRecoveryOutcomes(input: LogRecoveryOutcomesInput): void {
  const {
    recoveryResult,
    output,
    owner,
    repo,
    prNumber,
    headSha,
    iterationIndex,
    monotonicityRecoveryEnabled,
    compositionConvergenceEnabled,
    diffScopeBoundedEnabled,
    priorReviewsPresent,
    filesInScope,
  } = input;

  // Empty-findings coherence recovery logging (mt#2685): always check —
  // unlike the feature-flagged passes below, this pass runs unconditionally,
  // so its own `applied` flag is the only gate for whether to log.
  if (recoveryResult.emptyFindingsRecovery.applied) {
    log.info("reviewer.empty_findings_recovery", {
      event: "reviewer.empty_findings_recovery",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      synthesizedFile: recoveryResult.emptyFindingsRecovery.synthesizedFinding?.file,
      synthesizedSummary: recoveryResult.emptyFindingsRecovery.synthesizedFinding?.summary,
      // mt#2685 review R1: unconditional (unlike severity_downgrade_summary
      // below), so this is where operators always see the model's own
      // BLOCKING count vs. the synthesized one — effective count is their
      // sum (== postRecoveryBlockingCount) without needing another field.
      modelBlockingCount: recoveryResult.originalBlockingCount,
      synthesizedBlockingCount: recoveryResult.synthesizedBlockingCount,
    });
  }

  // Emit one log event per downgrade so operators can audit the recovery
  // layer's decisions and identify false positives. Aggregated count is
  // also useful for dashboards.
  for (const d of recoveryResult.downgrades) {
    log.info("reviewer.severity_downgrade", {
      event: "reviewer.severity_downgrade",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      file: d.file,
      line: d.line,
      ...(d.lineEnd !== undefined ? { lineEnd: d.lineEnd } : {}),
      fromSeverity: d.fromSeverity,
      toSeverity: d.toSeverity,
      matchingPriorSeverity: d.matchingPriorSeverity,
      reason: d.reason,
    });
  }
  if (monotonicityRecoveryEnabled) {
    // Emit summary on EVERY review when recovery is enabled, even with
    // zero downgrades, so dashboards see one event per review and can
    // detect "recovery enabled but never fired" scenarios (PR #922 R20#3).
    // All counts derived from post-recovery toolCalls (PR #922 R3) for
    // basis consistency. Recovery doesn't add or remove findings (only
    // changes severity), so totalFindingCount is identical pre- and post-,
    // but using one basis avoids future drift.
    const preRecoveryFindings = output.toolCalls.filter((tc) => tc.name === "submit_finding");
    const preRecoveryNonBlockingCount = preRecoveryFindings.filter(
      (tc) => tc.name === "submit_finding" && tc.args.severity === "NON-BLOCKING"
    ).length;
    const preRecoveryPreExistingCount = preRecoveryFindings.filter(
      (tc) => tc.name === "submit_finding" && tc.args.severity === "PRE-EXISTING"
    ).length;
    const postRecoveryFindings = recoveryResult.toolCalls.filter(
      (tc) => tc.name === "submit_finding"
    );
    const totalFindingCount = postRecoveryFindings.length;
    const postRecoveryNonBlockingCount = postRecoveryFindings.filter(
      (tc) => tc.name === "submit_finding" && tc.args.severity === "NON-BLOCKING"
    ).length;
    const postRecoveryPreExistingCount = postRecoveryFindings.filter(
      (tc) => tc.name === "submit_finding" && tc.args.severity === "PRE-EXISTING"
    ).length;
    log.info("reviewer.severity_downgrade_summary", {
      event: "reviewer.severity_downgrade_summary",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      downgradeCount: recoveryResult.downgrades.length,
      totalFindingCount,
      // originalBlockingCount is the MODEL's own count (pre-Step-0,
      // pre-downgrade); postRecoveryBlockingCount is after the full
      // pipeline including any Step-0 synthesis — see
      // synthesizedBlockingCount below when they disagree (mt#2685 review
      // R1: distinguishes "the model found N" from "the pipeline
      // synthesized M of the N now reported").
      originalBlockingCount: recoveryResult.originalBlockingCount,
      postRecoveryBlockingCount: recoveryResult.postRecoveryBlockingCount,
      synthesizedBlockingCount: recoveryResult.synthesizedBlockingCount,
      // Pre- and post-recovery breakdowns for the non-BLOCKING tiers
      // so dashboards can distinguish "downgraded from BLOCKING" vs.
      // "originally non-blocking" without reconstructing from logs
      // (PR #922 R24#3).
      preRecoveryNonBlockingCount,
      preRecoveryPreExistingCount,
      postRecoveryNonBlockingCount,
      postRecoveryPreExistingCount,
      // True when the recovery moved the count past zero, signaling the
      // composed event will likely change from REQUEST_CHANGES to
      // COMMENT/APPROVE downstream.
      crossedZero:
        recoveryResult.originalBlockingCount > 0 && recoveryResult.postRecoveryBlockingCount === 0,
    });
  }

  // mt#1867 convergence detection logging: emit one structured event per
  // downgraded finding, plus a summary event. The summary always emits when
  // compositionConvergenceEnabled is true (mirrors severity_downgrade_summary
  // convention — zero downgrades still useful for "enabled but never fired"
  // observability). Per-finding events only emit when the downgrade fires.
  if (compositionConvergenceEnabled && recoveryResult.convergenceDetection !== undefined) {
    const convDetection = recoveryResult.convergenceDetection;
    // Per-finding downgrade events
    for (const d of recoveryResult.convergenceDowngrades) {
      log.info("reviewer.composition_convergence_downgrade", {
        event: "reviewer.composition_convergence_downgrade",
        prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        sha: headSha,
        file: d.file,
        ...(d.line !== undefined ? { line: d.line } : {}),
        ...(d.lineEnd !== undefined ? { lineEnd: d.lineEnd } : {}),
        fromSeverity: d.fromSeverity,
        toSeverity: d.toSeverity,
        reason: d.reason,
      });
    }
    // Summary event — always emitted when enabled so dashboards see one entry
    // per review regardless of whether the downgrade fired.
    log.info("reviewer.composition_convergence_summary", {
      event: "reviewer.composition_convergence_summary",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      iterationIndex,
      downgradeApplied: convDetection.downgradeApplied,
      downgradeCount: recoveryResult.convergenceDowngrades.length,
      currentBlockingCount: convDetection.currentBlockingCount,
      priorBlockingCounts: convDetection.priorBlockingCounts,
      isCountDecreasing: convDetection.isCountDecreasing,
      hasAnyNewEvidence: convDetection.hasAnyNewEvidence,
      reason: convDetection.reason,
      // Evidence verdicts per BLOCKING (populated when downgradeApplied=true)
      evidenceVerdicts: convDetection.downgradeApplied ? convDetection.evidenceVerdicts : [],
    });
  }

  // mt#1875 diff-scope-bounded downgrade logging: emit one structured event per
  // downgraded finding, plus a summary event. The summary always emits when
  // diffScopeBoundedEnabled is true (mirrors severity_downgrade_summary
  // convention — zero downgrades still useful for "enabled but never fired"
  // observability). Per-finding events only emit when the downgrade fires.
  if (diffScopeBoundedEnabled) {
    // Per-finding downgrade events
    for (const d of recoveryResult.diffScopeBoundedDowngrades) {
      log.info("reviewer.diff_scope_bounded_downgrade", {
        event: "reviewer.diff_scope_bounded_downgrade",
        prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
        sha: headSha,
        file: d.file,
        ...(d.line !== undefined ? { line: d.line } : {}),
        ...(d.lineEnd !== undefined ? { lineEnd: d.lineEnd } : {}),
        fromSeverity: d.fromSeverity,
        toSeverity: d.toSeverity,
        reason: d.reason,
      });
    }
    // Summary event — always emitted when enabled so dashboards see one entry
    // per review regardless of whether the downgrade fired.
    log.info("reviewer.diff_scope_bounded_summary", {
      event: "reviewer.diff_scope_bounded_summary",
      prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      sha: headSha,
      iterationIndex,
      priorReviewsPresent,
      diff_scope: priorReviewsPresent ? "fix_commit" : "full_pr",
      filesInScope,
      downgradeApplied: recoveryResult.diffScopeBoundedDowngrades.length > 0,
      downgradeCount: recoveryResult.diffScopeBoundedDowngrades.length,
    });
  }
}
