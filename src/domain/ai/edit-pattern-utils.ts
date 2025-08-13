/**
 * Utilities for handling edit patterns with "// ... existing code ..." markers
 * following MorphLLM Fast Apply API best practices
 */

export const EXISTING_CODE_MARKER = "// ... existing code ...";

/**
 * Check if an edit pattern contains existing code markers
 */
export function hasExistingCodeMarkers(editPattern: string): boolean {
  return editPattern.includes(EXISTING_CODE_MARKER);
}

/**
 * Split edit pattern on existing code markers for analysis
 */
export function splitOnMarkers(editPattern: string): string[] {
  return editPattern.split(EXISTING_CODE_MARKER);
}

/**
 * Validate that an edit pattern follows MorphLLM best practices
 */
export function validateEditPattern(editPattern: string): {
  isValid: boolean;
  issues: string[];
  suggestions: string[];
} {
  const issues: string[] = [];
  const suggestions: string[] = [];

  if (!hasExistingCodeMarkers(editPattern)) {
    issues.push("Edit pattern should use '// ... existing code ...' markers");
    suggestions.push(
      "Add '// ... existing code ...' markers to indicate where existing code should be preserved"
    );
  }

  const parts = splitOnMarkers(editPattern);
  if (parts.length > 3) {
    issues.push("Too many existing code markers - should be minimal");
    suggestions.push("Use fewer markers to minimize unchanged code repetition");
  }

  // Check for repeated code patterns that suggest the pattern is too verbose
  const lines = editPattern.split("\n");
  const codeLines = lines.filter(
    (line) => line.trim() && !line.includes(EXISTING_CODE_MARKER) && !line.trim().startsWith("//")
  );

  if (codeLines.length > 10) {
    issues.push("Edit pattern appears too verbose");
    suggestions.push(
      "Consider showing only the new/changed code with markers for existing content"
    );
  }

  return {
    isValid: issues.length === 0,
    issues,
    suggestions,
  };
}

/**
 * Create a Morph Fast Apply API request structure
 */
export interface MorphFastApplyRequest {
  instruction: string;
  originalCode: string;
  editPattern: string;
}

/**
 * Format a request for Morph Fast Apply API using the correct XML structure
 */
export function createMorphFastApplyPrompt(request: MorphFastApplyRequest): string {
  return `<instruction>${request.instruction}</instruction>
<code>${request.originalCode}</code>
<update>${request.editPattern}</update>`;
}

/**
 * Create completion service parameters for Morph Fast Apply
 */
export function createMorphCompletionParams(
  request: MorphFastApplyRequest,
  options: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  } = {}
) {
  const prompt = createMorphFastApplyPrompt(request);

  return {
    prompt,
    provider: options.provider || "morph",
    model: options.model || "morph-v3-large",
    temperature: options.temperature ?? 0.1, // Low temperature for precise edits
    maxTokens: options.maxTokens ?? Math.max(request.originalCode.length * 2, 4000),
    systemPrompt: "You are a precise code editor using the Fast Apply format.",
  };
}

/**
 * Analyze edit pattern and provide insights
 */
export function analyzeEditPattern(editPattern: string): {
  hasMarkers: boolean;
  markerCount: number;
  parts: string[];
  characterCount: number;
  lineCount: number;
  validation: ReturnType<typeof validateEditPattern>;
} {
  const hasMarkers = hasExistingCodeMarkers(editPattern);
  const parts = splitOnMarkers(editPattern);
  const validation = validateEditPattern(editPattern);

  return {
    hasMarkers,
    markerCount: parts.length - 1,
    parts: parts.map((part) => part.trim()),
    characterCount: editPattern.length,
    lineCount: editPattern.split("\n").length,
    validation,
  };
}
