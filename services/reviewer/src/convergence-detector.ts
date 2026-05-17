/**
 * Composition-side convergence detection (mt#1867 — Fix 2 from mt#1640 paper).
 *
 * Detects iteration stagnation **across** rounds by comparing BLOCKING counts
 * and evidence novelty between R(N) and R(N+1). When stagnation is detected,
 * the caller downgrades ALL BLOCKINGs to NON-BLOCKING and forces event=COMMENT.
 *
 * Architectural sibling: mt#1496 (severity-monotonicity recovery) — same
 * composition-layer downgrade pattern, different decision rule. mt#1496 detects
 * severity inflation **within** a round; this detects stagnation **across** rounds.
 *
 * Activation gate: R≥4 only. R1/R2/R3 are unaffected; R4+ subject to the rule.
 * This matches the "after ~3 rounds of iteration, if no progress, stop" intuition
 * from the mt#1640 paper.
 *
 * Pure functions — no I/O, no async, no GitHub API. All inputs are already
 * fetched/parsed by the caller.
 */

import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Flat representation of a finding from a prior or current review round,
 * suitable for evidence-novelty comparison.
 */
export interface FindingForDetection {
  /** File path (relative to repo root). */
  file: string;
  /** Severity classification. */
  severity: "BLOCKING" | "NON-BLOCKING" | "PRE-EXISTING";
  /** 1-based line number (may be absent for file-level findings). */
  line?: number;
  /** Inclusive end line for multi-line findings. */
  lineEnd?: number;
}

/**
 * BLOCKING count per round, indexed 0 = R1, 1 = R2, etc.
 * R(N) is the count at index N-1.
 */
export type BlockingCountByRound = ReadonlyArray<number>;

/**
 * Per-finding evidence verdict for the convergence downgrade log.
 */
export interface FindingEvidenceVerdict {
  file: string;
  line?: number;
  lineEnd?: number;
  hasNewEvidence: boolean;
}

/**
 * Result of the convergence detection pass.
 */
export interface ConvergenceDetectionResult {
  /**
   * Whether the convergence downgrade fired. True means stagnation was
   * detected and ALL BLOCKINGs should be downgraded.
   */
  downgradeApplied: boolean;
  /**
   * Human-readable reason for the decision. Always present.
   */
  reason: string;
  /**
   * Per-finding evidence verdicts for the current round's BLOCKINGs.
   * Populated whenever the activation threshold is met and there are BLOCKINGs
   * to assess (regardless of whether downgradeApplied is true or false).
   * Empty when threshold is not met, there are no BLOCKINGs, or there is no
   * prior-round data.
   */
  evidenceVerdicts: FindingEvidenceVerdict[];
  /**
   * Number of BLOCKINGs in the current round (before any downgrade).
   */
  currentBlockingCount: number;
  /**
   * BLOCKING counts by round (oldest first), not including the current round.
   */
  priorBlockingCounts: BlockingCountByRound;
  /**
   * Whether the BLOCKING count is strictly decreasing from R(N-1) to R(N).
   * Absent when not enough history exists.
   */
  isCountDecreasing?: boolean;
  /**
   * Whether any BLOCKING in the current round has new evidence.
   * Absent when there are no BLOCKINGs in the current round.
   */
  hasAnyNewEvidence?: boolean;
}

/**
 * Audit entry for the `reviewer.composition_convergence_downgrade` log event.
 */
export interface ConvergenceDowngradeAuditEntry {
  file: string;
  line?: number;
  lineEnd?: number;
  fromSeverity: "BLOCKING";
  toSeverity: "NON-BLOCKING";
  reason: string;
}

/**
 * Result of applying the composition convergence downgrade.
 */
export interface CompositionConvergenceResult {
  /**
   * The (possibly downgraded) tool calls. Same length and ordering as the
   * input; only the `severity` field of `submit_finding` BLOCKING calls may
   * differ. Non-finding tool calls pass through unchanged.
   */
  toolCalls: ReadonlyArray<ReviewToolCall>;
  /**
   * Whether any downgrades were applied.
   */
  downgradeApplied: boolean;
  /**
   * Audit entries for each BLOCKING that was downgraded.
   */
  downgrades: ConvergenceDowngradeAuditEntry[];
  /**
   * The full convergence detection trace — prior counts, evidence verdicts,
   * decision reasoning. Used for the structured log event.
   */
  detectionResult: ConvergenceDetectionResult;
}

// ---------------------------------------------------------------------------
// Activation threshold
// ---------------------------------------------------------------------------

/**
 * Minimum iteration index (1-based) at which the convergence rule activates.
 * R1=1, R2=2, R3=3, R4=4.
 *
 * The rule fires when iterationIndex >= CONVERGENCE_ACTIVATION_THRESHOLD,
 * meaning R4 is the first round where stagnation detection is active.
 * R1/R2/R3 are always unaffected.
 */
export const CONVERGENCE_ACTIVATION_THRESHOLD = 4;

// ---------------------------------------------------------------------------
// Pure detection primitives
// ---------------------------------------------------------------------------

/**
 * Check whether a sequence of BLOCKING counts is strictly decreasing from
 * the second-to-last element to the last element.
 *
 * "Strictly decreasing" means count[N] < count[N-1] (NOT count[N] <= count[N-1]).
 * A count that stays the same is NOT strictly decreasing.
 *
 * Returns false when:
 *   - The array has fewer than 2 elements (no comparison possible).
 *   - The last element equals or exceeds the second-to-last element.
 *
 * Examples:
 *   [5, 4, 3, 2, 2] → false (last 2 elements: 2 → 2, not strictly decreasing)
 *   [5, 4, 3, 2, 1] → true  (last 2 elements: 2 → 1, strictly decreasing)
 *   [5, 4, 3, 4]    → false (last 2 elements: 3 → 4, not strictly decreasing)
 *   [5]             → false (fewer than 2 elements)
 *   []              → false (fewer than 2 elements)
 *
 * Exported for unit testing.
 */
export function isStrictlyDecreasing(history: BlockingCountByRound): boolean {
  if (history.length < 2) return false;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last === undefined || prev === undefined) return false;
  return last < prev;
}

/**
 * Check whether any BLOCKING finding in the current round has new evidence
 * not present in any prior round's NON-BLOCKING or PRE-EXISTING findings.
 *
 * "New evidence" means: a BLOCKING finding in currentFindings has a `file:line`
 * (or `file:line-lineEnd`) that does NOT appear in ANY prior NON-BLOCKING or
 * PRE-EXISTING finding. The comparison is:
 *   - File must match exactly (normalized: lowercase, forward-slash).
 *   - Line must match: same line number OR the line falls within an existing
 *     finding's lineEnd range.
 *   - If a current finding has no line number, it is treated as having new
 *     evidence (conservative: can't tell without a line reference).
 *
 * **Important:** Only NON-BLOCKING and PRE-EXISTING prior findings are
 * consulted. A prior BLOCKING at the same locus does NOT negate novelty —
 * a persistent BLOCKING that the implementer has not addressed is legitimately
 * ongoing and should NOT be stagnation-downgraded merely because the file:line
 * appeared in a prior round. The stagnation signal is specifically about
 * re-escalating previously accepted-as-NON-BLOCKING items (the mt#1496 class),
 * not about persistent genuine blockers.
 *
 * Returns true if ANY BLOCKING finding in currentFindings has new evidence.
 * Returns false if ALL BLOCKINGs in currentFindings match a prior NON-BLOCKING/
 * PRE-EXISTING finding, or if there are no BLOCKINGs in currentFindings.
 *
 * The semantic is: "does at least one BLOCKING have new evidence?" A single
 * genuinely new finding is enough to preserve BLOCKINGs for the round.
 *
 * Exported for unit testing.
 */
export function hasNewEvidence(
  currentFindings: ReadonlyArray<FindingForDetection>,
  priorFindings: ReadonlyArray<FindingForDetection>
): boolean {
  const normalizePath = (p: string): string => p.replace(/\\/g, "/").toLowerCase();

  // Only check BLOCKING findings in the current round.
  const currentBlockings = currentFindings.filter((f) => f.severity === "BLOCKING");
  if (currentBlockings.length === 0) return false;

  // Only match against NON-BLOCKING and PRE-EXISTING prior findings.
  // Prior BLOCKING findings are excluded: a persistent genuine blocker at the
  // same locus is NOT evidence of stagnation re-escalation. The stagnation
  // downgrade targets re-escalation of accepted-NON-BLOCKING/PRE-EXISTING items.
  const normalizedPriors = priorFindings
    .filter((f) => f.severity === "NON-BLOCKING" || f.severity === "PRE-EXISTING")
    .map((f) => ({
      ...f,
      normalizedFile: normalizePath(f.file),
    }));

  for (const finding of currentBlockings) {
    const currentFile = normalizePath(finding.file);
    // If no line number, treat as new evidence (conservative).
    if (finding.line === undefined) {
      return true;
    }

    const currentLine = finding.line;
    const currentLineEnd = finding.lineEnd ?? finding.line;

    // Check whether this BLOCKING overlaps with any prior NON-BLOCKING/PRE-EXISTING.
    const hasMatchingPrior = normalizedPriors.some((prior) => {
      if (prior.normalizedFile !== currentFile) return false;
      // Prior finding with no line matches any line in that file.
      if (prior.line === undefined) return true;
      const priorLine = prior.line;
      const priorLineEnd = prior.lineEnd ?? prior.line;
      // Check range overlap: [currentLine, currentLineEnd] ∩ [priorLine, priorLineEnd] ≠ ∅
      return priorLine <= currentLineEnd && priorLineEnd >= currentLine;
    });

    if (!hasMatchingPrior) {
      // This BLOCKING has no matching prior NON-BLOCKING/PRE-EXISTING — it's new evidence.
      return true;
    }
  }

  // All BLOCKINGs matched prior NON-BLOCKING/PRE-EXISTING findings — no new evidence.
  return false;
}

// ---------------------------------------------------------------------------
// Convergence detection
// ---------------------------------------------------------------------------

/**
 * Determine whether the current round is stagnating.
 *
 * Stagnation fires when ALL of:
 *   1. iterationIndex >= CONVERGENCE_ACTIVATION_THRESHOLD (R4+)
 *   2. priorBlockingCounts.length >= 1 (at least one prior round's data exists)
 *   3. BLOCKING count is NOT strictly decreasing from last prior round to now
 *   4. NO new evidence per BLOCKING finding in the current round
 *
 * The new-evidence check is the carve-out for legitimate R4+ BLOCKINGs:
 * if the model found a genuinely new file:line, we preserve it.
 *
 * Returns a ConvergenceDetectionResult with full trace for logging.
 */
export function detectConvergence(
  currentBlockings: ReadonlyArray<FindingForDetection>,
  priorFindings: ReadonlyArray<FindingForDetection>,
  priorBlockingCounts: BlockingCountByRound,
  iterationIndex: number
): ConvergenceDetectionResult {
  const currentBlockingCount = currentBlockings.filter((f) => f.severity === "BLOCKING").length;

  // Gate 1: Activation threshold.
  if (iterationIndex < CONVERGENCE_ACTIVATION_THRESHOLD) {
    return {
      downgradeApplied: false,
      reason: `convergence-detection: R${iterationIndex} < threshold R${CONVERGENCE_ACTIVATION_THRESHOLD} — deactivated`,
      evidenceVerdicts: [],
      currentBlockingCount,
      priorBlockingCounts,
    };
  }

  // Gate 2: No BLOCKINGs in current round → nothing to downgrade.
  if (currentBlockingCount === 0) {
    return {
      downgradeApplied: false,
      reason: `convergence-detection: R${iterationIndex} has 0 BLOCKINGs — nothing to downgrade`,
      evidenceVerdicts: [],
      currentBlockingCount,
      priorBlockingCounts,
    };
  }

  // Gate 3: Need at least one prior round's data.
  if (priorBlockingCounts.length === 0) {
    return {
      downgradeApplied: false,
      reason: `convergence-detection: R${iterationIndex} has no prior-round data — cannot assess trajectory`,
      evidenceVerdicts: [],
      currentBlockingCount,
      priorBlockingCounts,
    };
  }

  // Assess whether BLOCKING count is strictly decreasing.
  // Append the current count to the history for the check.
  const fullHistory: BlockingCountByRound = [...priorBlockingCounts, currentBlockingCount];
  const countDecreasing = isStrictlyDecreasing(fullHistory);

  // Assess whether there is new evidence in any current BLOCKING.
  const newEvidence = hasNewEvidence(currentBlockings, priorFindings);

  // Build evidence verdicts for the current BLOCKINGs.
  // Mirror hasNewEvidence: only NON-BLOCKING and PRE-EXISTING prior findings
  // are consulted, for the same reason (persistent BLOCKINGs are not stagnation).
  const normalizePath = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const normalizedPriors = priorFindings
    .filter((f) => f.severity === "NON-BLOCKING" || f.severity === "PRE-EXISTING")
    .map((f) => ({
      ...f,
      normalizedFile: normalizePath(f.file),
    }));

  const evidenceVerdicts: FindingEvidenceVerdict[] = currentBlockings
    .filter((f) => f.severity === "BLOCKING")
    .map((finding) => {
      const currentFile = normalizePath(finding.file);
      if (finding.line === undefined) {
        return { file: finding.file, hasNewEvidence: true };
      }
      const currentLine = finding.line;
      const currentLineEnd = finding.lineEnd ?? finding.line;
      const hasMatch = normalizedPriors.some((prior) => {
        if (prior.normalizedFile !== currentFile) return false;
        if (prior.line === undefined) return true;
        const priorLine = prior.line;
        const priorLineEnd = prior.lineEnd ?? prior.line;
        return priorLine <= currentLineEnd && priorLineEnd >= currentLine;
      });
      return {
        file: finding.file,
        ...(finding.line !== undefined ? { line: finding.line } : {}),
        ...(finding.lineEnd !== undefined ? { lineEnd: finding.lineEnd } : {}),
        hasNewEvidence: !hasMatch,
      };
    });

  // Stagnation: count NOT strictly decreasing AND no new evidence.
  if (!countDecreasing && !newEvidence) {
    const prevCount = priorBlockingCounts[priorBlockingCounts.length - 1];
    return {
      downgradeApplied: true,
      reason:
        `convergence-detection: R${iterationIndex} stagnating — ` +
        `BLOCKING count ${currentBlockingCount} is not strictly less than prior R${priorBlockingCounts.length} count ${prevCount}, ` +
        `AND no new evidence found in any BLOCKING finding`,
      evidenceVerdicts,
      currentBlockingCount,
      priorBlockingCounts,
      isCountDecreasing: countDecreasing,
      hasAnyNewEvidence: newEvidence,
    };
  }

  // Not stagnating — at least one of the conditions is met.
  const conditions: string[] = [];
  if (countDecreasing) conditions.push("BLOCKING count is strictly decreasing");
  if (newEvidence) conditions.push("at least one BLOCKING has new evidence");
  return {
    downgradeApplied: false,
    reason: `convergence-detection: R${iterationIndex} not stagnating — ${conditions.join("; ")}`,
    evidenceVerdicts,
    currentBlockingCount,
    priorBlockingCounts,
    isCountDecreasing: countDecreasing,
    hasAnyNewEvidence: newEvidence,
  };
}

// ---------------------------------------------------------------------------
// Integration: apply downgrade to tool calls
// ---------------------------------------------------------------------------

/**
 * Apply the composition convergence downgrade to a list of model tool calls.
 *
 * When stagnation is detected (isStrictlyDecreasing=false AND hasNewEvidence=false),
 * ALL BLOCKING findings are downgraded to NON-BLOCKING.
 *
 * Additionally, when all BLOCKINGs are downgraded (which happens when any
 * BLOCKING exists and stagnation fires), conclude_review calls with
 * event=REQUEST_CHANGES are reconciled to event=COMMENT, keeping the review
 * body's executive summary and GitHub event consistent.
 *
 * @param toolCalls         Model tool calls from the current round.
 * @param priorFindings     All findings from all prior rounds (flat list, any severity).
 * @param priorBlockingCounts BLOCKING count from each prior round (oldest first).
 * @param iterationIndex    1-based current iteration index (R1=1, R4=4, etc.).
 */
export function applyCompositionConvergenceDowngrade(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  priorFindings: ReadonlyArray<FindingForDetection>,
  priorBlockingCounts: BlockingCountByRound,
  iterationIndex: number
): CompositionConvergenceResult {
  // Extract current findings for detection.
  const currentFindings: FindingForDetection[] = toolCalls
    .filter(
      (tc): tc is Extract<ReviewToolCall, { name: "submit_finding" }> =>
        tc.name === "submit_finding"
    )
    .map((tc) => ({
      file: tc.args.file,
      severity: tc.args.severity,
      ...(tc.args.line !== undefined ? { line: tc.args.line } : {}),
      ...(tc.args.lineEnd !== undefined ? { lineEnd: tc.args.lineEnd } : {}),
    }));

  const detectionResult = detectConvergence(
    currentFindings,
    priorFindings,
    priorBlockingCounts,
    iterationIndex
  );

  if (!detectionResult.downgradeApplied) {
    return {
      toolCalls,
      downgradeApplied: false,
      downgrades: [],
      detectionResult,
    };
  }

  // Downgrade all BLOCKINGs to NON-BLOCKING.
  const downgrades: ConvergenceDowngradeAuditEntry[] = [];
  let corrected: ReadonlyArray<ReviewToolCall> = toolCalls.map((tc) => {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      return tc;
    }
    const downgradedArgs: SubmitFindingArgs = { ...tc.args, severity: "NON-BLOCKING" };
    downgrades.push({
      file: tc.args.file,
      ...(tc.args.line !== undefined ? { line: tc.args.line } : {}),
      ...(tc.args.lineEnd !== undefined ? { lineEnd: tc.args.lineEnd } : {}),
      fromSeverity: "BLOCKING",
      toSeverity: "NON-BLOCKING",
      reason: detectionResult.reason,
    });
    return { name: "submit_finding" as const, args: downgradedArgs };
  });

  // Reconcile conclude_review: if the review had REQUEST_CHANGES and all
  // BLOCKINGs were downgraded, rewrite to COMMENT for consistency.
  corrected = corrected.map((tc) => {
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

  return {
    toolCalls: corrected,
    downgradeApplied: true,
    downgrades,
    detectionResult,
  };
}

// ---------------------------------------------------------------------------
// DB helpers: read prior-round data from reviewer_convergence_metrics
// ---------------------------------------------------------------------------

/**
 * Extract FindingForDetection entries from prior review bodies.
 *
 * Reuses the same severity-marker regex as the monotonicity-recovery
 * layer (parsePriorBodyFindings in severity-recovery.ts) via an
 * externally injected parser function. This keeps convergence-detector.ts
 * pure (no import from severity-recovery.ts) while sharing the regex logic.
 *
 * @param priorBodies   Array of prior review body strings (oldest first).
 * @param parseFn       Parser function matching parsePriorBodyFindings's
 *                      signature: (body: string) => Array<{file, severity, line?, lineEnd?}>
 */
export function extractPriorFindingsForDetection(
  priorBodies: ReadonlyArray<string>,
  parseFn: (body: string) => ReadonlyArray<FindingForDetection>
): FindingForDetection[] {
  const out: FindingForDetection[] = [];
  for (const body of priorBodies) {
    try {
      const findings = parseFn(body);
      out.push(...findings);
    } catch {
      // Defensive: malformed prior body should not crash the detection pass.
    }
  }
  return out;
}
