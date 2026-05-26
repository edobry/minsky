/**
 * Pre-flight diff anchor validation for GitHub PR review comments.
 *
 * Validates that each review comment's (path, line, side) lies within the
 * diff for a given PR before the Octokit createReview call. Off-diff anchors
 * produce a typed DiffAnchorError with the nearest valid anchor on miss, not
 * an opaque 422 from GitHub that fails the entire review.
 *
 * Design decision: the validator is a pure function that accepts a pre-parsed
 * DiffFile[] fixture. The caller (submitReview) fetches the diff inline and
 * passes parsedDiff. This keeps the validator fully testable without network
 * access and allows submitReview to reuse the same diff if it already has it.
 *
 * Validation rules:
 *  - If comments[] is empty or undefined, validation is skipped (backward compat).
 *  - Warning-flagged DiffFile entries (path === "" with warning field) are
 *    filtered out — they are not anchorable.
 *  - Each comment's path must exist in the parsedDiff.
 *  - (line, side) must lie within a hunk for that path:
 *      RIGHT: a DiffLine where newLine === line
 *      LEFT:  a DiffLine where oldLine === line
 *    CONTEXT lines (both oldLine and newLine set) are valid anchors for both LEFT and RIGHT.
 *  - For multi-line ranges, BOTH (startLine, startSide) and (line, side) must be valid.
 *  - Binary files (hunks: []) produce anchor misses for any (line, side).
 *
 * On validation failure, throws a DiffAnchorError per-comment including:
 *  - The anchor that failed: { path, line, side }
 *  - The nearest valid anchor in the same file (closest line number by absolute distance)
 *  - A human-readable reason string
 */

import { MinskyError } from "../errors/index";
import type { DiffFile } from "../utils/parse-diff";
import type { ReviewComment } from "./github-pr-review";

// ── Error type ─────────────────────────────────────────────────────────────

export interface DiffAnchorFailure {
  /** The (path, line, side) that did not match any hunk line. */
  anchor: { path: string; line: number; side: "LEFT" | "RIGHT" };
  /** Nearest valid anchor in the same file, or null if the file has no anchorable lines. */
  nearestValidAnchor: { line: number; side: "LEFT" | "RIGHT" } | null;
  /** Human-readable explanation. */
  reason: string;
}

/**
 * Typed error thrown when a review comment anchor lies outside the PR diff.
 *
 * Each instance represents a single anchor failure. The caller may catch this
 * and present the nearestValidAnchor to the reviewer as a correction hint.
 *
 * Not thrown when comments[] is empty or undefined (backward compat).
 */
export class DiffAnchorError extends MinskyError {
  constructor(
    message: string,
    public readonly failure: DiffAnchorFailure
  ) {
    super(message);
    this.name = "DiffAnchorError";
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Build an index from file path to DiffFile, filtering out warning-flagged entries.
 */
function buildPathIndex(parsedDiff: DiffFile[]): Map<string, DiffFile> {
  const index = new Map<string, DiffFile>();
  for (const file of parsedDiff) {
    // Filter out warning-flagged entries (path === "" with warning field set)
    if (file.path === "" && file.warning !== undefined) {
      continue;
    }
    index.set(file.path, file);
  }
  return index;
}

/**
 * Collect all anchorable (line, side) pairs from a DiffFile's hunks.
 *
 * Returns a flat list of { line, side } objects. CONTEXT lines (both oldLine
 * and newLine set) produce two entries — one for LEFT (oldLine) and one for
 * RIGHT (newLine) — because they are valid anchors for both sides.
 */
function collectValidAnchors(file: DiffFile): Array<{ line: number; side: "LEFT" | "RIGHT" }> {
  const anchors: Array<{ line: number; side: "LEFT" | "RIGHT" }> = [];

  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (dl.side === "RIGHT" && dl.newLine !== null) {
        anchors.push({ line: dl.newLine, side: "RIGHT" });
      } else if (dl.side === "LEFT" && dl.oldLine !== null) {
        anchors.push({ line: dl.oldLine, side: "LEFT" });
      } else if (dl.side === "CONTEXT") {
        // CONTEXT lines are valid for both LEFT (oldLine) and RIGHT (newLine)
        if (dl.oldLine !== null) {
          anchors.push({ line: dl.oldLine, side: "LEFT" });
        }
        if (dl.newLine !== null) {
          anchors.push({ line: dl.newLine, side: "RIGHT" });
        }
      }
    }
  }

  return anchors;
}

/**
 * Check whether a specific (line, side) is valid within a DiffFile's hunks.
 *
 * RIGHT side: matches a DiffLine where newLine === line (RIGHT or CONTEXT)
 * LEFT  side: matches a DiffLine where oldLine === line (LEFT or CONTEXT)
 */
function isValidAnchor(file: DiffFile, line: number, side: "LEFT" | "RIGHT"): boolean {
  for (const hunk of file.hunks) {
    for (const dl of hunk.lines) {
      if (side === "RIGHT") {
        // RIGHT matches a line where newLine is set (RIGHT or CONTEXT dl)
        if (dl.newLine === line) return true;
      } else {
        // LEFT matches a line where oldLine is set (LEFT or CONTEXT dl)
        if (dl.oldLine === line) return true;
      }
    }
  }
  return false;
}

/**
 * Find the nearest valid anchor to a given (line, side) in a file.
 *
 * "Nearest" means smallest absolute distance between the target line number
 * and the candidate anchor's line number. When two candidates have equal
 * distance, the first encountered (earlier in diff order) is preferred.
 *
 * Returns null if the file has no anchorable lines (e.g., binary file).
 */
function findNearestAnchor(
  file: DiffFile,
  targetLine: number,
  _targetSide: "LEFT" | "RIGHT"
): { line: number; side: "LEFT" | "RIGHT" } | null {
  const anchors = collectValidAnchors(file);
  if (anchors.length === 0) return null;

  let best: { line: number; side: "LEFT" | "RIGHT" } | null = null;
  let bestDist = Infinity;

  for (const a of anchors) {
    const dist = Math.abs(a.line - targetLine);
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }

  return best;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate that each review comment's anchor lies within the parsed diff.
 *
 * Skips validation entirely when comments is empty or undefined (backward compat).
 * Filters out warning-flagged DiffFile entries (path === "", warning set).
 *
 * Throws DiffAnchorError for the FIRST failing comment (per-comment, not batched).
 * This is intentional: callers that want to collect all failures should loop
 * and catch individually.
 *
 * @param parsedDiff  Parsed diff from parseUnifiedDiff()
 * @param comments    ReviewComment[] from SubmitReviewOptions
 */
export function validateDiffAnchors(
  parsedDiff: DiffFile[],
  comments: ReviewComment[] | undefined
): void {
  if (!comments || comments.length === 0) {
    // Backward compat: no comments to validate
    return;
  }

  const pathIndex = buildPathIndex(parsedDiff);

  for (const comment of comments) {
    const resolvedSide: "LEFT" | "RIGHT" = comment.side ?? comment.startSide ?? "RIGHT";
    const resolvedStartSide: "LEFT" | "RIGHT" = comment.startSide ?? resolvedSide;

    // ── Path check ──────────────────────────────────────────────────────
    const file = pathIndex.get(comment.path);
    if (!file) {
      // Path not in diff
      throw new DiffAnchorError(
        `Review comment anchor is out of diff: path "${comment.path}" is not in the PR diff. ` +
          `Check that the file path matches exactly (case-sensitive, no leading slash).`,
        {
          anchor: { path: comment.path, line: comment.line, side: resolvedSide },
          nearestValidAnchor: null,
          reason: `Path "${comment.path}" not found in PR diff`,
        }
      );
    }

    // ── startLine anchor check (multi-line range) ────────────────────────
    if (comment.startLine !== undefined) {
      if (!isValidAnchor(file, comment.startLine, resolvedStartSide)) {
        const nearest = findNearestAnchor(file, comment.startLine, resolvedStartSide);
        throw new DiffAnchorError(
          `Review comment anchor is out of diff: startLine ${comment.startLine} (${resolvedStartSide}) ` +
            `on "${comment.path}" does not lie within any hunk in the PR diff.${
              nearest
                ? ` Nearest valid anchor: line ${nearest.line} (${nearest.side}).`
                : " No valid anchors found in this file (binary or empty diff)."
            }`,
          {
            anchor: { path: comment.path, line: comment.startLine, side: resolvedStartSide },
            nearestValidAnchor: nearest,
            reason: `startLine ${comment.startLine} (${resolvedStartSide}) not within any diff hunk for "${comment.path}"`,
          }
        );
      }
    }

    // ── End-line anchor check ────────────────────────────────────────────
    if (!isValidAnchor(file, comment.line, resolvedSide)) {
      const nearest = findNearestAnchor(file, comment.line, resolvedSide);
      throw new DiffAnchorError(
        `Review comment anchor is out of diff: line ${comment.line} (${resolvedSide}) ` +
          `on "${comment.path}" does not lie within any hunk in the PR diff.${
            nearest
              ? ` Nearest valid anchor: line ${nearest.line} (${nearest.side}).`
              : " No valid anchors found in this file (binary or empty diff)."
          }`,
        {
          anchor: { path: comment.path, line: comment.line, side: resolvedSide },
          nearestValidAnchor: nearest,
          reason: `line ${comment.line} (${resolvedSide}) not within any diff hunk for "${comment.path}"`,
        }
      );
    }
  }
}
