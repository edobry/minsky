/**
 * Inline-comment anchor pre-validation (mt#2350).
 *
 * GitHub's `pulls.createReview` rejects the ENTIRE review payload with a 422
 * ("Line could not be resolved") when any single `comments[]` entry anchors to
 * a `line` that GitHub cannot resolve against the PR diff. Because the reviewer
 * sends all inline comments in ONE `createReview` call, a single bad anchor
 * loses the whole review — observed live on PR #1602 (2026-06-08) and earlier on
 * PR #1115 (mt#1810, 2026-05-13).
 *
 * The fix: before submitting, partition inline comments into anchorable vs.
 * unanchorable against the diff. Anchorable comments are posted as `comments[]`;
 * unanchorable ones are demoted to a Markdown section appended to the review
 * body so the finding still surfaces (the same demote-don't-drop shape mt#1485
 * uses for the `/review-pr` human-reviewer path).
 *
 * This is distinct from `severity-recovery.ts`'s `parseUnifiedDiff`, which
 * tracks added/removed line RANGES for monotonicity recovery and deliberately
 * omits context lines. GitHub resolves a RIGHT-side comment on ANY line present
 * in a hunk — added OR context — so an added-only check would over-demote valid
 * context-line comments. This module computes the precise RIGHT-side resolvable
 * set instead.
 */

import type { ReviewInlineComment } from "./github-client";

/**
 * Parse a unified-diff string into the set of new-file line numbers that GitHub
 * can resolve as RIGHT-side inline-comment anchors, per file path.
 *
 * A new-file line is anchorable on the RIGHT side iff it appears in a hunk as
 * either an added line (`+`) or a context line (` `). Removed lines (`-`) do not
 * advance the new-file counter and are not RIGHT-side anchorable.
 *
 * Returns an empty map for an empty/unparseable diff. The reviewer only ever
 * anchors on the RIGHT side (see `ReviewInlineComment.side`), so LEFT-side
 * resolution is intentionally not modeled here.
 *
 * Exported for unit testing.
 */
export function parseRightSideAnchorableLines(diff: string): Map<string, Set<number>> {
  const anchorable = new Map<string, Set<number>>();
  if (!diff) return anchorable;

  const lines = diff.split("\n");
  let currentFile: string | null = null;
  let newLine = 0;
  let inHunk = false;

  const add = (file: string, line: number): void => {
    let set = anchorable.get(file);
    if (set === undefined) {
      set = new Set<number>();
      anchorable.set(file, set);
    }
    set.add(line);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      inHunk = false;
      continue;
    }

    // The new-file path comes from the `+++ b/<path>` header. `+++ /dev/null`
    // is a full deletion — no RIGHT side exists, so leave currentFile null.
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).trim();
      if (path === "/dev/null") {
        currentFile = null;
      } else if (path.startsWith("b/")) {
        currentFile = path.slice(2);
      } else {
        currentFile = path;
      }
      inHunk = false;
      continue;
    }

    // The `--- a/<path>` header carries the OLD path; skip it so its leading
    // `-` is not mistaken for a removed content line.
    if (line.startsWith("--- ")) {
      continue;
    }

    // Hunk header: `@@ -oldStart,oldCount +newStart,newCount @@`. Seed the
    // new-file counter from newStart.
    if (line.startsWith("@@")) {
      const match = /@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match && match[1] !== undefined) {
        newLine = parseInt(match[1], 10);
        inHunk = true;
      } else {
        inHunk = false;
      }
      continue;
    }

    if (!inHunk || currentFile === null) continue;

    // A zero-length line is never a hunk content line: git prefixes every
    // content line (context=" ", added="+", removed="-"), so a blank context
    // line is " ", not "". An empty string is the trailing-newline split
    // artifact (or inter-file separator) — skip it without advancing.
    if (line.length === 0) continue;

    // Within a hunk, classify by the leading marker.
    if (line.startsWith("+")) {
      // Added line — anchorable; advances the new-file counter.
      add(currentFile, newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // Removed line — old side only; does not advance the new-file counter.
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — metadata, not a content line.
    } else {
      // Context line (leading space). Anchorable; advances the counter.
      add(currentFile, newLine);
      newLine += 1;
    }
  }

  return anchorable;
}

/** Result of partitioning inline comments against the resolvable anchor set. */
export interface PartitionedInlineComments {
  /** Comments safe to submit as `createReview` `comments[]` entries. */
  anchored: ReviewInlineComment[];
  /** Comments whose anchor would 422; demote these into the review body. */
  unanchored: ReviewInlineComment[];
}

/**
 * Partition inline comments into those GitHub can anchor vs. those that would
 * cause a 422 on submission.
 *
 * - Reply comments (`inReplyTo` set) always pass through as anchored: GitHub
 *   anchors them via the parent comment and ignores `path`/`line`/`side`, so the
 *   diff-resolvability check does not apply. (A reply to a since-deleted parent
 *   is a separate, much rarer failure class and is out of scope here.)
 * - Top-level comments are anchored iff their `line` is in the resolvable set
 *   for their `path`. The reviewer only emits RIGHT-side anchors, so a LEFT-side
 *   comment (should one ever appear) is conservatively treated as unanchored.
 */
export function partitionInlineComments(
  comments: ReviewInlineComment[],
  anchorable: Map<string, Set<number>>
): PartitionedInlineComments {
  const anchored: ReviewInlineComment[] = [];
  const unanchored: ReviewInlineComment[] = [];

  for (const c of comments) {
    if (c.inReplyTo !== undefined) {
      anchored.push(c);
      continue;
    }
    const side = c.side ?? "RIGHT";
    const resolvable = side === "RIGHT" && (anchorable.get(c.path)?.has(c.line) ?? false);
    if (resolvable) {
      anchored.push(c);
    } else {
      unanchored.push(c);
    }
  }

  return { anchored, unanchored };
}

/**
 * Render demoted (unanchorable) inline comments as a Markdown section to append
 * to the review body, so the findings still reach the PR even though they could
 * not be anchored to a diff line.
 *
 * Returns the empty string when there are no unanchored comments, so callers can
 * unconditionally concatenate the result.
 */
export function formatUnanchoredFindings(unanchored: ReviewInlineComment[]): string {
  if (unanchored.length === 0) return "";

  const items = unanchored
    .map((c) => {
      // Single-line the body for the list entry; the full body is preserved.
      const oneLine = c.body.replace(/\r?\n+/g, " ").trim();
      return `- \`${c.path}:${c.line}\` — ${oneLine}`;
    })
    .join("\n");

  return [
    "",
    "## Unanchored findings",
    "",
    "The following findings could not be anchored to a line in the PR diff " +
      "(the referenced line is outside the changed hunks). They are surfaced here " +
      "instead of as inline comments so the review still posts (mt#2350):",
    "",
    items,
    "",
  ].join("\n");
}
