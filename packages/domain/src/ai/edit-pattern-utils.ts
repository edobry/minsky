/**
 * Utility functions for handling edit patterns and Morph API integration.
 * Ensures consistency between production code and tests.
 */

export const EXISTING_CODE_MARKER = "// ... existing code ...";

export function hasExistingCodeMarkers(content: string): boolean {
  return content.includes(EXISTING_CODE_MARKER);
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
