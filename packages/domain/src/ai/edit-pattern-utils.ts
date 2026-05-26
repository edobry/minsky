/**
 * Utility functions for handling edit patterns and Morph API integration.
 * Ensures consistency between production code and tests.
 */

export const EXISTING_CODE_MARKER = "// ... existing code ...";

export function hasExistingCodeMarkers(content: string): boolean {
  return content.includes(EXISTING_CODE_MARKER);
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
