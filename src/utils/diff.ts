/**
 * Diff utilities for reporting what an edit actually changed.
 *
 * The core primitive is `computeChangedRange` — a common-prefix/common-suffix
 * trim that answers "which lines did this edit touch?". `generateUnifiedDiff`
 * and `generateDiffSummary` are both derived from it, so all three agree.
 *
 * WHY A TRIM RATHER THAN A REAL DIFF ALGORITHM (mt#3071). Until mt#3071 these
 * functions compared lines POSITIONALLY (`originalLines[i] !== modifiedLines[i]`),
 * which is correct only when an edit preserves line count. A single inserted
 * line shifted every later line and rendered the entire tail as changed — an
 * 8-line fixture reported 7 added / 6 removed for ONE inserted line. That is
 * worse than no signal for the thing these are used for (showing a caller where
 * an edit landed), because it looks authoritative while being wrong.
 *
 * A prefix/suffix trim is exact for a SINGLE contiguous change — the normal
 * shape of a marker-based apply — and needs no LCS/Myers implementation or
 * third-party dependency. For an edit with several disjoint changed regions it
 * reports the BOUNDING range covering all of them: coarser than per-hunk output,
 * but never wrong about which lines are untouched. That tradeoff is deliberate;
 * if per-hunk granularity is ever needed, replace the trim with a real diff
 * algorithm and keep these signatures.
 */

/** Lines of unchanged context to show around a change in a unified diff. */
const CONTEXT_LINES = 3;

/**
 * The region an edit touched, in unified-diff hunk coordinates.
 *
 * Counts are line counts, starts are 1-indexed. Following `diff -u` convention,
 * a count of 0 (a pure insertion on the original side, or a pure deletion on the
 * final side) reports the start as the line the change comes AFTER — so
 * prepending to a file yields `originalStart: 0, originalCount: 0`.
 */
export interface ChangedRange {
  /** 1-indexed first changed line in the ORIGINAL (see the zero-count convention). */
  originalStart: number;
  /** Number of original lines replaced or deleted. 0 for a pure insertion. */
  originalCount: number;
  /** 1-indexed first changed line in the RESULT (see the zero-count convention). */
  finalStart: number;
  /** Number of result lines added or replacing. 0 for a pure deletion. */
  finalCount: number;
}

interface Trim {
  originalLines: string[];
  modifiedLines: string[];
  /** Count of identical leading lines. */
  prefix: number;
  /** Original lines inside the changed region. */
  originalCount: number;
  /** Modified lines inside the changed region. */
  finalCount: number;
}

/** Trim the common prefix and suffix, leaving the changed region between them. */
function trimCommon(original: string, modified: string): Trim {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");

  const limit = Math.min(originalLines.length, modifiedLines.length);

  let prefix = 0;
  while (prefix < limit && originalLines[prefix] === modifiedLines[prefix]) {
    prefix++;
  }

  // The suffix may not overlap the prefix — otherwise a repeated line would be
  // counted on both sides and produce a negative changed-region length.
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    originalLines[originalLines.length - 1 - suffix] ===
      modifiedLines[modifiedLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  return {
    originalLines,
    modifiedLines,
    prefix,
    originalCount: originalLines.length - prefix - suffix,
    finalCount: modifiedLines.length - prefix - suffix,
  };
}

/**
 * Compute which lines an edit changed.
 *
 * Returns `null` when the two contents are identical — a no-op edit, which is
 * itself a meaningful signal to a caller that expected to change something.
 */
export function computeChangedRange(original: string, modified: string): ChangedRange | null {
  if (original === modified) return null;

  const { prefix, originalCount, finalCount } = trimCommon(original, modified);

  return {
    originalStart: originalCount > 0 ? prefix + 1 : prefix,
    originalCount,
    finalStart: finalCount > 0 ? prefix + 1 : prefix,
    finalCount,
  };
}

/**
 * Generate a unified diff between two strings.
 *
 * Emits one hunk covering the changed region (see the module comment on the
 * bounding-range tradeoff for multi-region edits), with up to `CONTEXT_LINES`
 * lines of context on each side. Identical content yields the file headers and
 * no hunk.
 *
 * @param original - The original content
 * @param modified - The modified content
 * @param filename - Optional filename to include in diff header
 * @returns Unified diff string
 */
export function generateUnifiedDiff(original: string, modified: string, filename?: string): string {
  const fileLabel = filename || "file";
  const diffLines: string[] = [`--- ${fileLabel}`, `+++ ${fileLabel}`];

  if (original === modified) return diffLines.join("\n");

  const { originalLines, modifiedLines, prefix, originalCount, finalCount } = trimCommon(
    original,
    modified
  );

  const contextStart = Math.max(0, prefix - CONTEXT_LINES);
  const originalChangeEnd = prefix + originalCount;
  const modifiedChangeEnd = prefix + finalCount;
  const trailingContext = Math.min(
    CONTEXT_LINES,
    originalLines.length - originalChangeEnd,
    modifiedLines.length - modifiedChangeEnd
  );

  const leadingContext = prefix - contextStart;
  const hunkOriginalLength = leadingContext + originalCount + trailingContext;
  const hunkModifiedLength = leadingContext + finalCount + trailingContext;

  diffLines.push(
    `@@ -${contextStart + 1},${hunkOriginalLength} +${contextStart + 1},${hunkModifiedLength} @@`
  );

  for (let i = contextStart; i < prefix; i++) {
    diffLines.push(` ${originalLines[i]}`);
  }
  for (let i = prefix; i < originalChangeEnd; i++) {
    diffLines.push(`-${originalLines[i]}`);
  }
  for (let i = prefix; i < modifiedChangeEnd; i++) {
    diffLines.push(`+${modifiedLines[i]}`);
  }
  for (let i = originalChangeEnd; i < originalChangeEnd + trailingContext; i++) {
    diffLines.push(` ${originalLines[i]}`);
  }

  return diffLines.join("\n");
}

/**
 * Generate a concise summary of changes between two strings.
 *
 * Counts describe the changed region only — an edit that inserts one line
 * reports one added line, not "every line after the insertion point".
 *
 * @param original - The original content
 * @param modified - The modified content
 * @returns Summary object with statistics
 */
export function generateDiffSummary(
  original: string,
  modified: string
): {
  linesAdded: number;
  linesRemoved: number;
  linesChanged: number;
  totalLines: number;
} {
  const modifiedLines = modified.split("\n");

  // Whole-file creation/clearing: report it as purely added or purely removed
  // rather than as the empty string's one blank line being replaced.
  if (original === "") {
    return {
      linesAdded: modifiedLines.length,
      linesRemoved: 0,
      linesChanged: 0,
      totalLines: modifiedLines.length,
    };
  }

  if (modified === "") {
    return {
      linesAdded: 0,
      linesRemoved: original.split("\n").length,
      linesChanged: 0,
      totalLines: 0,
    };
  }

  if (original === modified) {
    return { linesAdded: 0, linesRemoved: 0, linesChanged: 0, totalLines: modifiedLines.length };
  }

  const { originalCount, finalCount } = trimCommon(original, modified);

  return {
    linesAdded: finalCount,
    linesRemoved: originalCount,
    // Lines replaced in place — the overlap between what was removed and added.
    linesChanged: Math.min(originalCount, finalCount),
    totalLines: modifiedLines.length,
  };
}
