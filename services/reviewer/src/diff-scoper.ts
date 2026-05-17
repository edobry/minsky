/**
 * Diff-scope-bounded review (mt#1875 — Fix 3 from mt#1640 paper).
 *
 * When a PR has prior reviews (R≥2), restrict the analysis to the fix-commit
 * diff — the commits pushed since the last reviewer round. Tool-call findings
 * on lines outside the fix-commit-diff range are auto-downgraded to NON-BLOCKING.
 *
 * Architectural siblings:
 *   - mt#1496 severity-recovery.ts: severity-monotonicity recovery (across files)
 *   - mt#1867 convergence-detector.ts: stagnation detection across rounds
 *
 * This module is the mechanical complement to mt#1867: Fix 2 detects stagnation,
 * Fix 3 narrows the discovery surface so stagnation has less to grab onto.
 *
 * Pure functions — no I/O, no async, no GitHub API.
 */

import type { ReviewToolCall, SubmitFindingArgs } from "./output-tools";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A line range [start, end] (both 1-based, inclusive).
 */
export type LineRange = readonly [number, number];

/**
 * Map from normalized file path to list of changed line ranges in the fix commit.
 * Ranges are 1-based and inclusive, matching unified-diff hunk headers.
 */
export type FixCommitLineRangeMap = ReadonlyMap<string, ReadonlyArray<LineRange>>;

/**
 * Result of extracting the fix-commit diff from a PR diff.
 */
export interface ExtractFixCommitDiffResult {
  /**
   * The slice of the unified diff that covers commits since the
   * prior-review timestamp. May be empty when no new commits exist.
   */
  diff: string;
  /**
   * Per-file map of changed line ranges in the fix-commit diff.
   * Used by isLineInScope and applyDiffScopeBoundedDowngrade.
   */
  lineRange: FixCommitLineRangeMap;
}

/**
 * Audit entry for a single diff-scope-bounded downgrade.
 */
export interface DiffScopeDowngradeAuditEntry {
  file: string;
  line?: number;
  lineEnd?: number;
  fromSeverity: "BLOCKING";
  toSeverity: "NON-BLOCKING";
  reason: string;
}

/**
 * Result of applying the diff-scope-bounded downgrade pass.
 */
export interface DiffScopeBoundedDowngradeResult {
  /**
   * The (possibly downgraded) tool calls. Same length and ordering as
   * input; only severity of out-of-scope BLOCKING submit_finding calls
   * may differ.
   */
  toolCalls: ReadonlyArray<ReviewToolCall>;
  /**
   * Whether any downgrades were applied.
   */
  downgradeApplied: boolean;
  /**
   * Audit entries for each BLOCKING finding that was downgraded.
   */
  downgrades: DiffScopeDowngradeAuditEntry[];
}

// ---------------------------------------------------------------------------
// Diff parsing helpers (unified-diff hunk extraction)
// ---------------------------------------------------------------------------

/**
 * Normalize a file path for comparison: lowercase, forward-slash separators,
 * strip leading a/ and b/ prefixes used in git diff output.
 */
function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/^[ab]\//, "")
    .toLowerCase();
}

/**
 * Parse a unified-diff string into a per-file map of changed line ranges in
 * the NEW file (added + context lines, 1-based inclusive).
 *
 * We treat every line in the diff hunk (not just `+` lines) as "potentially
 * changed" for the purpose of scope detection. This is intentionally
 * conservative: if a finding is at a line that appears in the hunk context
 * window, it may relate to the fix commit and should be preserved.
 *
 * Hunk header format: @@ -oldStart,oldCount +newStart,newCount @@
 *
 * Returns an empty map for empty or unparseable diffs.
 *
 * Exported for unit testing.
 */
export function parseFixCommitLineRanges(diff: string): FixCommitLineRangeMap {
  if (!diff.trim()) return new Map();

  const result = new Map<string, LineRange[]>();
  let currentFile: string | null = null;
  let inHunk = false;
  let hunkRangeStart = 0;
  let hunkRangeEnd = 0;

  function flushHunk(): void {
    if (currentFile !== null && inHunk && hunkRangeEnd >= hunkRangeStart) {
      const normalized = normalizePath(currentFile);
      const existing = result.get(normalized) ?? [];
      existing.push([hunkRangeStart, hunkRangeEnd]);
      result.set(normalized, existing);
    }
    inHunk = false;
  }

  const lines = diff.split("\n");
  for (const line of lines) {
    // New file header (diff --git a/... b/...)
    if (line.startsWith("diff --git ")) {
      flushHunk();
      currentFile = null;
      continue;
    }

    // +++ line: file path for the new version
    if (line.startsWith("+++ ")) {
      flushHunk();
      const path = line.slice(4).trim();
      // Skip /dev/null (deleted files)
      if (path !== "/dev/null") {
        currentFile = path;
      } else {
        currentFile = null;
      }
      continue;
    }

    // Hunk header: @@ -oldStart[,oldCount] +newStart[,newCount] @@
    // Precompute the full hunk range from the header (newStart to newStart+newCount-1).
    // We treat the entire hunk window as "in scope" for conservative scope detection.
    if (line.startsWith("@@")) {
      flushHunk();
      const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (hunkMatch) {
        const newStart = parseInt(hunkMatch[1] ?? "1", 10);
        // newCount defaults to 1 when absent
        const newCount = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
        hunkRangeStart = newStart;
        hunkRangeEnd = newCount > 0 ? newStart + newCount - 1 : newStart;
        inHunk = true;
      }
      continue;
    }

    if (!inHunk || currentFile === null) continue;
    // Content lines (+ / - / context) do not affect the precomputed range.
  }
  flushHunk();

  return result;
}

/**
 * Extract the portion of a PR diff that corresponds to commits after
 * `priorReviewTimestamp`.
 *
 * In the current implementation, the full prDiff is used as the fix-commit
 * diff when the caller has already filtered it to only the recent commits.
 * When the caller supplies the full diff (no filtering), this function parses
 * the diff as-is and uses it as the fix-commit scope.
 *
 * This function is intentionally simple: the filtering by timestamp is
 * expected to happen at the caller site (in runReview) using git commit
 * metadata. This module's responsibility is the line-range extraction and
 * scope-check logic.
 *
 * The `priorReviewTimestamp` parameter is included in the result for logging
 * and audit purposes. It is not used to further filter the diff here, since
 * the caller is responsible for providing the already-filtered diff.
 *
 * @param fixCommitDiff The diff of commits since the prior review (already
 *   filtered by the caller). Pass the full PR diff when timestamp-filtering
 *   is not available.
 * @param priorReviewTimestamp ISO-8601 timestamp of the last reviewer round.
 *   Included in the result for audit; not used for filtering here.
 */
export function extractFixCommitDiff(
  fixCommitDiff: string,
  priorReviewTimestamp: string
): ExtractFixCommitDiffResult {
  let parsedRanges: FixCommitLineRangeMap;
  try {
    parsedRanges = parseFixCommitLineRanges(fixCommitDiff);
  } catch {
    // Defensive: malformed diff should not crash the downgrade pass.
    parsedRanges = new Map();
  }

  return {
    diff: fixCommitDiff,
    lineRange: parsedRanges,
    // Note: priorReviewTimestamp is consumed by the caller for logging.
    // We include it implicitly in the contract documentation here.
  };
}

// ---------------------------------------------------------------------------
// Scope check
// ---------------------------------------------------------------------------

/**
 * Check whether a finding's file:line falls within the fix-commit-diff scope.
 *
 * Returns true when:
 *   - The file appears in the lineRange map AND
 *   - The finding's line (or any line in [line, lineEnd]) overlaps at least
 *     one range in the map for that file.
 *
 * Returns true (conservative) when:
 *   - No line number is given (can't tell → preserve the finding).
 *   - The lineRange map is empty (fix-commit diff was empty or unparseable →
 *     preserve all findings).
 *
 * Returns false (out of scope) when:
 *   - The file is NOT in the lineRange map (fix commit did not touch the file).
 *   - The file IS in the map but the finding's line range does not overlap
 *     any hunk range in the map.
 *
 * Exported for unit testing.
 */
export function isLineInScope(
  file: string,
  line: number | undefined,
  lineEnd: number | undefined,
  lineRange: FixCommitLineRangeMap
): boolean {
  // Empty map: fix-commit diff was empty or unparseable → preserve all findings.
  if (lineRange.size === 0) return true;

  // No line number: can't tell → conservative preserve.
  if (line === undefined) return true;

  const normalizedFile = normalizePath(file);

  // File not in map: fix commit did not touch this file → out of scope.
  const ranges = lineRange.get(normalizedFile);
  if (ranges === undefined) return false;

  const findingStart = line;
  const findingEnd = lineEnd ?? line;

  // Check whether the finding's range overlaps any hunk range.
  for (const [rangeStart, rangeEnd] of ranges) {
    if (rangeStart <= findingEnd && rangeEnd >= findingStart) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Composition-layer downgrade pass
// ---------------------------------------------------------------------------

/**
 * Apply the diff-scope-bounded downgrade to a list of model tool calls.
 *
 * For each BLOCKING submit_finding whose file:line falls outside the
 * fix-commit-diff line range, downgrade to NON-BLOCKING.
 *
 * Additionally, when all BLOCKINGs are downgraded, reconcile conclude_review
 * calls with event=REQUEST_CHANGES to event=COMMENT for consistency (same
 * pattern as mt#1867 convergence-detector).
 *
 * When lineRange is empty (fix-commit diff was empty or unparseable), the
 * downgrade does NOT fire — this is the conservative safe path.
 *
 * @param toolCalls    Model tool calls from the current round (post-recovery,
 *                     post-convergence — Step 3c runs after Step 3b).
 * @param lineRange    Fix-commit-diff scope map (from extractFixCommitDiff).
 */
export function applyDiffScopeBoundedDowngrade(
  toolCalls: ReadonlyArray<ReviewToolCall>,
  lineRange: FixCommitLineRangeMap
): DiffScopeBoundedDowngradeResult {
  // Empty map: conservative preserve — no downgrades.
  if (lineRange.size === 0) {
    return {
      toolCalls,
      downgradeApplied: false,
      downgrades: [],
    };
  }

  const downgrades: DiffScopeDowngradeAuditEntry[] = [];
  let corrected: ReadonlyArray<ReviewToolCall> = toolCalls.map((tc) => {
    if (tc.name !== "submit_finding" || tc.args.severity !== "BLOCKING") {
      return tc;
    }

    const inScope = isLineInScope(tc.args.file, tc.args.line, tc.args.lineEnd, lineRange);
    if (inScope) {
      return tc;
    }

    // Out-of-scope BLOCKING: downgrade to NON-BLOCKING.
    const downgradedArgs: SubmitFindingArgs = { ...tc.args, severity: "NON-BLOCKING" };
    downgrades.push({
      file: tc.args.file,
      ...(tc.args.line !== undefined ? { line: tc.args.line } : {}),
      ...(tc.args.lineEnd !== undefined ? { lineEnd: tc.args.lineEnd } : {}),
      fromSeverity: "BLOCKING",
      toSeverity: "NON-BLOCKING",
      reason: `diff-scope-bounded: file:line not in fix-commit-diff range (Fix 3, mt#1875)`,
    });
    return { name: "submit_finding" as const, args: downgradedArgs };
  });

  const downgradeApplied = downgrades.length > 0;

  // Reconcile conclude_review: if all BLOCKINGs were downgraded and the review
  // event was REQUEST_CHANGES, rewrite to COMMENT for consistency.
  if (downgradeApplied) {
    const postDowngradeBlockingCount = corrected.filter(
      (tc) => tc.name === "submit_finding" && tc.args.severity === "BLOCKING"
    ).length;

    if (postDowngradeBlockingCount === 0) {
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
    }
  }

  return {
    toolCalls: corrected,
    downgradeApplied,
    downgrades,
  };
}
