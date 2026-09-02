/**
 * Utility functions for handling edit patterns and Morph API integration.
 * Ensures consistency between production code and tests.
 */

export const EXISTING_CODE_MARKER = "// ... existing code ...";

export function hasExistingCodeMarkers(content: string): boolean {
  return content.includes(EXISTING_CODE_MARKER);
}

/**
 * Line-count floor below which the collapse guard's shrink-ratio check is not
 * applied — a ratio is too noisy on tiny content, and an accidental large drop
 * is only meaningful on a non-trivial document.
 */
export const COLLAPSE_GUARD_MIN_ORIGINAL_LINES = 40;

/**
 * A marker-based apply that retains FEWER than this fraction of the original's
 * lines is treated as a suspicious collapse (mt#2577). Tuned to fire on the
 * observed 999->517 (~52% retained) incident with margin, while leaving normal
 * marker edits — which change size by a small delta — untouched.
 */
export const COLLAPSE_GUARD_SHRINK_RATIO = 0.6;

/**
 * Count lines in a string, normalizing away ALL trailing blank lines so content
 * with a different count of trailing newlines / trailing blank lines counts the
 * same. This keeps the collapse ratio insensitive to trailing-whitespace churn
 * on either side (mt#2577 R1): comparing content-line counts, not trailing
 * blanks, avoids both false positives (trailing blanks removed) and false
 * negatives (trailing blanks padding an otherwise-collapsed document).
 */
function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/**
 * Pure predicate for the marker-spanning-collapse guard (mt#2577): did a
 * marker-based apply shrink the content far more than a normal edit would?
 * Returns the before/after line counts when the drop is suspicious, else null.
 * Only meaningful for the marker-apply path — the caller gates on
 * `hasMarkers && contentExisted` before calling this.
 *
 * **Lives here, not beside one caller (mt#3674).** This is the same decision for
 * every apply-model-backed partial-edit surface, and scoping it to one tool is
 * what let the family recur: mt#2577 guarded `session_edit_file`, and
 * `tasks_spec_patch` — the tool whose artifact has no version history to restore
 * from — went unguarded until a spec was destroyed through it. Any future
 * apply-model edit surface should import this rather than re-derive a second,
 * divergent heuristic.
 */
/**
 * Render a line count with the right plural (PR #2650 R1). Lives beside the predicate so all
 * three collapse-refusal surfaces read alike — the reviewer caught "1 lines" on one of them,
 * and the other two build the same string from the same numbers.
 */
export function formatLineCount(n: number): string {
  return `${n} ${n === 1 ? "line" : "lines"}`;
}

export function detectSuspiciousCollapse(
  originalContent: string,
  finalContent: string
): { originalLines: number; finalLines: number } | null {
  const originalLines = countLines(originalContent);
  if (originalLines < COLLAPSE_GUARD_MIN_ORIGINAL_LINES) return null;
  const finalLines = countLines(finalContent);
  if (finalLines < originalLines * COLLAPSE_GUARD_SHRINK_RATIO) {
    return { originalLines, finalLines };
  }
  return null;
}

/**
 * Size-growth factor above which a `replace_all` operation is refused without
 * an explicit override (mt#2400 fail-closed guard). A `replace_all` that
 * balloons the file past this multiple of its original size is, far more often
 * than not, a runaway duplication (the mt#1361 family) rather than an intended
 * large expansion — so the safe default is to refuse and require the caller to
 * opt in.
 */
export const REPLACE_ALL_GROWTH_REFUSAL_FACTOR = 1.5;

/**
 * True when an output of `outputLen` bytes exceeds `factor`× the `inputLen`
 * bytes. Pure helper so the guard and its tests share one definition.
 */
export function exceedsGrowthThreshold(
  inputLen: number,
  outputLen: number,
  factor: number = REPLACE_ALL_GROWTH_REFUSAL_FACTOR
): boolean {
  return outputLen > inputLen * factor;
}

/**
 * Strip the surrounding whitespace an apply model emits around its output while
 * preserving the ORIGINAL file's trailing-newline state.
 *
 * WHY THIS EXISTS (mt#3248). Both apply paths returned `response.content.trim()`
 * straight to their callers, and `String.prototype.trim()` removes the file's
 * terminating newline along with the model's padding. Because the result is
 * written to disk verbatim, every marker-based edit of a newline-terminated file
 * silently dropped that newline — deterministically, regardless of the
 * instruction or the model's output. It went unnoticed for as long as it did
 * because a following `prettier --write` restores the newline; files no
 * formatter touches kept the corruption.
 *
 * Deleting the trim is not the fix: the model does pad its output, and leaking
 * that padding into files is the failure this trim was added to prevent. So the
 * transform trims as before and then restores whatever trailing-newline state
 * the original had.
 *
 * Pure over its inputs, so both apply paths share one definition and neither can
 * drift from the other.
 */
export function preserveTrailingNewline(modelOutput: string, originalContent: string): string {
  const trimmed = modelOutput.trim();

  // An empty result stays empty: emitting a lone "\n" would fabricate a byte the
  // model did not produce, turning a legitimately-emptied file into a 1-byte one.
  if (trimmed === "") {
    return trimmed;
  }

  // Restore the original's exact terminator, not a hardcoded "\n". `trim()` strips
  // \r as readily as \n, so a CRLF file whose terminator was rebuilt as a bare LF
  // would come back with its last line silently converted — a different corruption
  // than the one this helper exists to prevent, and one that leaves the file with
  // mixed endings.
  const trailingNewline = /(\r\n|\n|\r)$/.exec(originalContent)?.[1] ?? "";

  return `${trimmed}${trailingNewline}`;
}

export function splitOnMarkers(content: string): string[] {
  return content.split(EXISTING_CODE_MARKER);
}

export interface EditPatternValidation {
  isValid: boolean;
  issues: string[];
  suggestions: string[];
}

export interface EditPatternAnalysis {
  hasMarkers: boolean;
  markerCount: number;
  characterCount: number;
  lineCount: number;
  parts: string[];
  validation: EditPatternValidation;
}

export function analyzeEditPattern(editPattern: string): EditPatternAnalysis {
  const hasMarkers = hasExistingCodeMarkers(editPattern);
  const parts = splitOnMarkers(editPattern);
  const markerCount = hasMarkers ? parts.length - 1 : 0;
  const characterCount = editPattern.length;
  const lineCount = editPattern.split("\n").length;

  const issues: string[] = [];
  const suggestions: string[] = [];

  if (hasMarkers && markerCount === 0) {
    issues.push("Edit pattern contains the marker but it's not used to split content.");
    suggestions.push(
      "Ensure '// ... existing code ...' is used to separate unchanged code sections."
    );
  }
  if (markerCount > 1) {
    suggestions.push(
      "Consider using a single '// ... existing code ...' marker for simplicity, unless multiple distinct insertion points are truly needed."
    );
  }
  if (!hasMarkers && editPattern.trim().length > 0 && editPattern.split("\n").length > 5) {
    // Heuristic for verbosity
    suggestions.push(
      "For modifications, consider using '// ... existing code ...' markers to minimize unchanged code in the edit pattern, as per MorphLLM best practices."
    );
  }
  if (editPattern.trim().length === 0) {
    issues.push("Edit pattern is empty.");
    suggestions.push("Provide a valid edit pattern.");
  }

  return {
    hasMarkers,
    markerCount,
    characterCount,
    lineCount,
    parts,
    validation: {
      isValid: issues.length === 0,
      issues,
      suggestions,
    },
  };
}

export interface MorphFastApplyRequest {
  instruction: string;
  originalCode: string;
  editPattern: string;
}

export interface CompletionParams {
  prompt: string;
  provider: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

export function createMorphFastApplyPrompt(request: MorphFastApplyRequest): string {
  return (
    `<instruction>${request.instruction}</instruction>\n` +
    `<code>${request.originalCode}</code>\n` +
    `<update>${request.editPattern}</update>`
  );
}

export function createMorphCompletionParams(
  request: MorphFastApplyRequest,
  baseParams: Omit<CompletionParams, "prompt" | "systemPrompt">
): CompletionParams {
  const prompt = createMorphFastApplyPrompt(request);
  return {
    ...baseParams,
    prompt,
    systemPrompt: "You are a precise code editor using the Fast Apply format.",
  };
}

// ---------------------------------------------------------------------------
// Deterministic marker resolution (mt#4181)
// ---------------------------------------------------------------------------

/**
 * Which unambiguous shape a marker patch resolved to. Reported so a caller can
 * log or test WHICH rule fired rather than only that one did.
 */
export type MarkerMergeShape = "append" | "prepend" | "anchored";

export type MarkerMergeResolution =
  | { resolved: true; merged: string; shapes: MarkerMergeShape[] }
  | { resolved: false; reason: string };

/**
 * Compare two lines for anchor purposes, ignoring trailing whitespace only.
 *
 * Trailing-whitespace drift is common when an agent re-types an anchor it read
 * from `tasks_spec_get`, and it never changes meaning. Nothing else is
 * normalized: leading indentation IS content, and matching loosely on it would
 * let an anchor bind to the wrong line. The SAME normalization is used by the
 * retention check below, so the two cannot disagree about whether a line matched.
 */
function sameLine(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

/** Drop leading and trailing blank lines; interior blanks are content. */
function stripBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] ?? "").trim() === "") start++;
  while (end > start && (lines[end - 1] ?? "").trim() === "") end--;
  return lines.slice(start, end);
}

/**
 * Every line of `original` appears in `merged`, in order.
 *
 * **This is the post-condition that makes the splice safe**, and it is why the
 * resolver can be simple. A merge rule can be wrong in many ways; all the ways
 * that MATTER here lose original content, and a spec has no version history to
 * restore from (mt#3674). So rather than trying to prove each rule correct, the
 * resolver computes a candidate and then refuses to return it unless the
 * original survives inside it intact.
 *
 * A legitimate DELETION fails this check and falls back to the apply model —
 * which is exactly today's behaviour for every patch, so nothing regresses.
 * Greedy matching is correct for subsequence containment.
 */
export function retainsAllLinesInOrder(originalLines: string[], mergedLines: string[]): boolean {
  let cursor = 0;
  for (const line of mergedLines) {
    const expected = originalLines[cursor];
    if (expected !== undefined && sameLine(line, expected)) cursor++;
  }
  return cursor === originalLines.length;
}

/** Indices at/after `from` where `needle` occurs. */
function occurrences(lines: string[], needle: string, from: number): number[] {
  const found: number[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && sameLine(line, needle)) found.push(i);
  }
  return found;
}

/**
 * Resolve a `// ... existing code ...` patch by string splice, with no apply
 * model involved — for the subset of patches where the markers are unambiguous.
 *
 * WHY THIS EXISTS (mt#4181). `applyEditPattern` hands the WHOLE document plus the
 * patch to a fast-apply model and asks it to reproduce the merged result. Past
 * roughly 500 lines the model stops reproducing the document and returns
 * something a fraction of its size, so the mt#3674 collapse guard — correctly —
 * refuses the write, and there is no append path at all. Measured on real specs:
 * 588 -> 86 lines, 1172 -> 36, 1956 -> 67, 2130 -> 63, 584 -> 24. Payload size
 * and anchor quality made no difference; length was the variable. The specs that
 * grow that long are the long-lived anchors whose whole function is to
 * accumulate, so the tool failed hardest exactly where it was needed most.
 *
 * A splice cannot collapse, so this path sidesteps the failure rather than
 * tuning around it. It is deliberately NOT a general patch engine: it recognizes
 * three shapes, and anything else returns `{ resolved: false }` so the caller
 * falls back to the model exactly as before.
 *
 *   - **append**  — a lone leading marker, new content after it.
 *   - **prepend** — new content, then a lone trailing marker.
 *   - **anchored** — a segment between markers whose first and last lines each
 *     occur exactly ONCE in the remaining original; the span between them is
 *     replaced by the segment.
 *
 * Ambiguity always loses: a segment whose head anchor matches twice, or a
 * content segment in a position where its location cannot be derived, refuses.
 * And every resolution is checked by {@link retainsAllLinesInOrder} before it is
 * returned, so a rule that mis-fires produces a fallback rather than a loss.
 */
export function resolveMarkerMergeDeterministically(
  originalContent: string,
  editContent: string
): MarkerMergeResolution {
  if (!hasExistingCodeMarkers(editContent)) {
    return { resolved: false, reason: "patch carries no existing-code marker" };
  }

  // Line endings and boundary blanks are CONTENT, and a spec has no version history to restore
  // from if they are lost (PR #3580 R1, both BLOCKING). An earlier revision stripped blank edges
  // off the ORIGINAL and joined with "\n" unconditionally, which silently dropped leading blank
  // lines and left LF-only separators inside a CRLF document. Worse, it then ran the retention
  // check against the STRIPPED array — so the post-condition could not see its own damage. The
  // original is now split without normalizing, and the check below compares against all of it.
  const lineEnding = originalContent.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = /\r?\n$/.test(originalContent);

  const originalLines = originalContent.split(/\r?\n/);
  // Drop ONLY the empty string a terminating newline produces — never a genuine trailing blank.
  if (endsWithNewline) originalLines.pop();

  const editLines = editContent.split(/\r?\n/);

  const segments: string[][] = [];
  let segmentStart = 0;
  for (let i = 0; i < editLines.length; i++) {
    if ((editLines[i] ?? "").trim() === EXISTING_CODE_MARKER) {
      segments.push(editLines.slice(segmentStart, i));
      segmentStart = i + 1;
    }
  }
  segments.push(editLines.slice(segmentStart));

  const merged: string[] = [];
  const shapes: MarkerMergeShape[] = [];
  let cursor = 0;

  /** One blank line of separation, and only when there is not already one. */
  const pushSeparator = (): void => {
    const last = merged[merged.length - 1];
    if (merged.length > 0 && (last ?? "").trim() !== "") merged.push("");
  };

  for (let s = 0; s < segments.length; s++) {
    const body = stripBlankEdges(segments[s] ?? []);
    const openingAnchor = body[0];
    const closingAnchor = body[body.length - 1];
    // Blank edges are stripped from the PATCH's segments — those blanks sit between a marker and
    // its anchor and are patch formatting, not document content. The original's blanks are never
    // touched.
    if (openingAnchor === undefined || closingAnchor === undefined) continue;

    const isFirst = s === 0;
    const isLast = s === segments.length - 1;
    const heads = occurrences(originalLines, openingAnchor, cursor);
    const [head] = heads;

    if (heads.length === 1 && head !== undefined) {
      const tails = occurrences(originalLines, closingAnchor, head);
      const [tail] = tails;
      if (tails.length !== 1 || tail === undefined) {
        return {
          resolved: false,
          reason:
            `segment ${s + 1}'s closing anchor matches ${tails.length} times in the remaining ` +
            `original — cannot place it unambiguously`,
        };
      }
      merged.push(...originalLines.slice(cursor, head));
      merged.push(...body);
      cursor = tail + 1;
      shapes.push("anchored");
      continue;
    }

    if (heads.length === 0 && isLast) {
      // Pure new content after the final marker: the marker stands for "all the rest of the
      // original", so the addition lands at the end.
      merged.push(...originalLines.slice(cursor));
      cursor = originalLines.length;
      pushSeparator();
      merged.push(...body);
      shapes.push("append");
      continue;
    }

    if (heads.length === 0 && isFirst) {
      // Pure new content before the first marker: prepend.
      merged.push(...body);
      pushSeparator();
      shapes.push("prepend");
      continue;
    }

    return {
      resolved: false,
      reason:
        heads.length === 0
          ? `segment ${s + 1} matches nothing in the original and is not at an edge — ` +
            `cannot derive where it belongs`
          : `segment ${s + 1}'s opening anchor matches ${heads.length} times in the remaining ` +
            `original — cannot place it unambiguously`,
    };
  }

  merged.push(...originalLines.slice(cursor));

  // A patch of markers and blank lines only would otherwise "resolve" to the original written
  // back unchanged — a silent no-op write (PR #3580 R1, NON-BLOCKING). There is nothing to apply,
  // so say so rather than reporting success.
  if (shapes.length === 0) {
    return { resolved: false, reason: "patch contains no content to apply" };
  }

  if (!retainsAllLinesInOrder(originalLines, merged)) {
    return {
      resolved: false,
      reason: "the spliced result would not retain every original line in order",
    };
  }

  return {
    resolved: true,
    merged: merged.join(lineEnding) + (endsWithNewline ? lineEnding : ""),
    shapes,
  };
}
